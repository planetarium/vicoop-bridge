import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import type { AgentCard as SdkAgentCard } from '@a2a-js/sdk';
import type { AgentCard as WireAgentCard } from '@vicoop-bridge/protocol';
import { RelayAgentExecutor } from './executor.js';
import type { AdapterConnection, Registry } from './registry.js';

export interface RelayHttpOptions {
  registry: Registry;
  publicUrl?: string;
}

function toSdkAgentCard(
  wire: WireAgentCard,
  conn: AdapterConnection,
  publicUrl: string | undefined,
): SdkAgentCard {
  const url = publicUrl
    ? `${publicUrl}/agents/${conn.agentId}`
    : `/agents/${conn.agentId}`;
  return {
    name: wire.name,
    description: wire.description ?? '',
    version: wire.version,
    protocolVersion: wire.protocolVersion ?? '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: wire.capabilities?.streaming ?? false,
      pushNotifications: wire.capabilities?.pushNotifications ?? false,
    },
    defaultInputModes: wire.defaultInputModes ?? ['text/plain'],
    defaultOutputModes: wire.defaultOutputModes ?? ['text/plain'],
    skills: (wire.skills ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      tags: s.tags ?? [],
    })),
  };
}

export function createHttpApp(opts: RelayHttpOptions): Hono {
  const app = new Hono();
  const taskStore = new InMemoryTaskStore();
  const transports = new Map<string, JsonRpcTransportHandler>();

  function getTransport(conn: AdapterConnection): JsonRpcTransportHandler {
    const cached = transports.get(conn.agentId);
    if (cached) return cached;
    const card = toSdkAgentCard(conn.agentCard, conn, opts.publicUrl);
    const executor = new RelayAgentExecutor(conn.agentId, opts.registry);
    const handler = new DefaultRequestHandler(card, taskStore, executor);
    const transport = new JsonRpcTransportHandler(handler);
    transports.set(conn.agentId, transport);
    return transport;
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/', (c) =>
    c.json({
      name: 'vicoop-bridge',
      description: 'A2A relay for outbound-connected local agents',
      version: '0.0.0',
      url: opts.publicUrl,
      agents: opts.registry.listAgents().map((a) => ({
        id: a.agentId,
        url: opts.publicUrl
          ? `${opts.publicUrl}/agents/${a.agentId}`
          : `/agents/${a.agentId}`,
        card: toSdkAgentCard(a.agentCard, a, opts.publicUrl),
      })),
    }),
  );

  app.get('/agents/:id/.well-known/agent-card.json', (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);
    return c.json(toSdkAgentCard(conn.agentCard, conn, opts.publicUrl));
  });

  // TCK / single-agent clients expect /.well-known/agent-card.json at the
  // domain root. When exactly one adapter is connected, proxy to its card.
  app.get('/.well-known/agent-card.json', (c) => {
    const agents = opts.registry.listAgents();
    if (agents.length === 1) {
      return c.json(toSdkAgentCard(agents[0].agentCard, agents[0], opts.publicUrl));
    }
    return c.json(
      {
        error: 'root agent card unavailable',
        reason: agents.length === 0 ? 'no adapter connected' : 'multiple adapters connected',
        agents: agents.map((a) => ({
          id: a.agentId,
          cardUrl: `${opts.publicUrl ?? ''}/agents/${a.agentId}/.well-known/agent-card.json`,
        })),
      },
      404,
    );
  });

  async function handleJsonRpc(conn: AdapterConnection, c: Context) {
    const rawBody = await c.req.text();
    const transport = getTransport(conn);
    const result = await transport.handle(rawBody);

    if (Symbol.asyncIterator in (result as object)) {
      const iter = result as AsyncGenerator<unknown>;
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      return stream(c, async (s) => {
        for await (const chunk of iter) {
          await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      });
    }

    return c.json(result as unknown as Record<string, unknown>);
  }

  app.post('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);
    return handleJsonRpc(conn, c);
  });

  // TCK compat: single-agent alias at root (mirrors the agent-card alias).
  app.post('/', async (c) => {
    const agents = opts.registry.listAgents();
    if (agents.length !== 1) {
      return c.json(
        { error: 'root JSON-RPC unavailable', reason: `${agents.length} adapters connected` },
        404,
      );
    }
    return handleJsonRpc(agents[0], c);
  });

  return app;
}
