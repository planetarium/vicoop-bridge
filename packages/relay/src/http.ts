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
import type { ConnectorConnection, Registry } from './registry.js';
import { createAdminTransport, buildAdminAgentCard, ADMIN_AGENT_ID } from './admin.js';
import { verifySiweToken } from './siwe-token.js';
import type { Sql } from './db.js';

export interface RelayHttpOptions {
  registry: Registry;
  publicUrl?: string;
  db: Sql;
}

function toSdkAgentCard(
  wire: WireAgentCard,
  conn: ConnectorConnection,
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

  // Built-in admin agent
  const adminTransport = createAdminTransport({
    db: opts.db,
    registry: opts.registry,
    publicUrl: opts.publicUrl,
  });
  const adminCard = buildAdminAgentCard(opts.publicUrl);

  function getTransport(conn: ConnectorConnection): JsonRpcTransportHandler {
    const cached = transports.get(conn.agentId);
    if (cached) return cached;
    const card = toSdkAgentCard(conn.agentCard, conn, opts.publicUrl);
    const executor = new RelayAgentExecutor(conn.agentId, opts.registry);
    const handler = new DefaultRequestHandler(card, taskStore, executor);
    const transport = new JsonRpcTransportHandler(handler);
    transports.set(conn.agentId, transport);
    return transport;
  }

  async function handleTransportResult(result: unknown, c: Context) {
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

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/', (c) => {
    const agents = opts.registry.listAgents().map((a) => ({
      id: a.agentId,
      url: opts.publicUrl
        ? `${opts.publicUrl}/agents/${a.agentId}`
        : `/agents/${a.agentId}`,
      card: toSdkAgentCard(a.agentCard, a, opts.publicUrl),
    }));

    agents.push({
      id: ADMIN_AGENT_ID,
      url: adminCard.url,
      card: adminCard,
    });

    return c.json({
      name: 'vicoop-bridge',
      description: 'A2A relay for outbound-connected local agents',
      version: '0.0.0',
      url: opts.publicUrl,
      agents,
    });
  });

  app.get('/agents/:id/.well-known/agent-card.json', (c) => {
    const id = c.req.param('id');

    if (id === ADMIN_AGENT_ID) {
      return c.json(adminCard);
    }

    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);
    return c.json(toSdkAgentCard(conn.agentCard, conn, opts.publicUrl));
  });

  // TCK / single-agent clients expect /.well-known/agent-card.json at the
  // domain root. When exactly one connector is connected, proxy to its card.
  app.get('/.well-known/agent-card.json', (c) => {
    const agents = opts.registry.listAgents();
    if (agents.length === 1) {
      return c.json(toSdkAgentCard(agents[0].agentCard, agents[0], opts.publicUrl));
    }
    return c.json(
      {
        error: 'root agent card unavailable',
        reason: agents.length === 0 ? 'no connector connected' : 'multiple connectors connected',
        agents: agents.map((a) => ({
          id: a.agentId,
          cardUrl: `${opts.publicUrl ?? ''}/agents/${a.agentId}/.well-known/agent-card.json`,
        })),
      },
      404,
    );
  });

  app.post('/agents/:id', async (c) => {
    const id = c.req.param('id');

    // Admin agent — SIWE Bearer auth
    if (id === ADMIN_AGENT_ID) {
      const authHeader = c.req.header('Authorization');
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!bearerToken) {
        return c.json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Authentication required (Bearer SIWE token)' },
        }, 401);
      }

      let walletAddress: string;
      try {
        walletAddress = await verifySiweToken(bearerToken);
      } catch (err) {
        return c.json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: `Invalid SIWE token: ${(err as Error).message}` },
        }, 401);
      }

      // Inject wallet address into the JSON-RPC request body so the executor can read it.
      // We do this by wrapping the transport handler and patching the parsed request context.
      const rawBody = await c.req.text();
      const parsed = JSON.parse(rawBody);

      // Attach wallet to params metadata for the executor
      if (parsed.params?.message) {
        parsed.params.message.metadata = {
          ...parsed.params.message.metadata,
          _walletAddress: walletAddress,
          _bearerToken: bearerToken,
        };
      }

      const result = await adminTransport.handle(JSON.stringify(parsed));
      return handleTransportResult(result, c);
    }

    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);

    const rawBody = await c.req.text();
    const transport = getTransport(conn);
    const result = await transport.handle(rawBody);
    return handleTransportResult(result, c);
  });

  return app;
}
