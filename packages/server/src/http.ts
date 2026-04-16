import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import type { AgentCard as SdkAgentCard } from '@a2a-js/sdk';
import type { AgentCard as WireAgentCard } from '@vicoop-bridge/protocol';
import { ServerAgentExecutor } from './executor.js';
import type { ClientConnection, Registry } from './registry.js';
import { createAdminTransport, buildAdminAgentCard } from './admin.js';
import { verifySiweToken } from './siwe-token.js';
import type { Sql } from './db.js';

export interface ServerHttpOptions {
  registry: Registry;
  publicUrl?: string;
  db: Sql;
}

function toSdkAgentCard(
  wire: WireAgentCard,
  conn: ClientConnection,
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

export function createHttpApp(opts: ServerHttpOptions): Hono {
  const app = new Hono();

  app.use('*', cors({
    origin: (origin) => origin,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  }));

  const taskStore = new InMemoryTaskStore();
  const transports = new Map<string, JsonRpcTransportHandler>();

  // Built-in admin agent at root
  const adminTransport = createAdminTransport({
    db: opts.db,
    registry: opts.registry,
    publicUrl: opts.publicUrl,
  });
  const adminCard = buildAdminAgentCard(opts.publicUrl);

  function getTransport(conn: ClientConnection): JsonRpcTransportHandler {
    const cached = transports.get(conn.agentId);
    if (cached) return cached;
    const card = toSdkAgentCard(conn.agentCard, conn, opts.publicUrl);
    const executor = new ServerAgentExecutor(conn.agentId, opts.registry);
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

  // Root agent card — the server itself is an A2A agent
  app.get('/.well-known/agent-card.json', (c) => c.json(adminCard));

  // Server info
  app.get('/', (c) =>
    c.json({
      name: 'vicoop-bridge',
      description: 'A2A server for outbound-connected local agents',
      version: '0.0.0',
      url: opts.publicUrl,
      card: adminCard,
      clients: opts.registry.listAgents().map((a) => ({
        id: a.agentId,
        url: opts.publicUrl
          ? `${opts.publicUrl}/agents/${a.agentId}`
          : `/agents/${a.agentId}`,
        card: toSdkAgentCard(a.agentCard, a, opts.publicUrl),
      })),
    }),
  );

  // Root POST — admin agent A2A endpoint (SIWE auth)
  app.post('/', async (c) => {
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

    const rawBody = await c.req.text();
    const parsed = JSON.parse(rawBody);

    if (parsed.params?.message) {
      parsed.params.message.metadata = {
        ...parsed.params.message.metadata,
        _walletAddress: walletAddress,
        _bearerToken: bearerToken,
      };
    }

    const result = await adminTransport.handle(JSON.stringify(parsed));
    return handleTransportResult(result, c);
  });

  // PostGraphile proxy — forward /graphql and /graphiql to internal PostGraphile server
  const postgraphileUrl = `http://localhost:${process.env.POSTGRAPHILE_PORT ?? 5433}`;

  app.all('/graphql', async (c) => {
    const res = await fetch(`${postgraphileUrl}/graphql`, {
      method: c.req.method,
      headers: Object.fromEntries(c.req.raw.headers),
      body: c.req.method === 'POST' ? await c.req.text() : undefined,
    });
    return new Response(res.body, {
      status: res.status,
      headers: Object.fromEntries(res.headers),
    });
  });

  app.get('/graphiql', async (c) => {
    const res = await fetch(`${postgraphileUrl}/graphiql`, {
      headers: Object.fromEntries(c.req.raw.headers),
    });
    return new Response(res.body, {
      status: res.status,
      headers: Object.fromEntries(res.headers),
    });
  });

  // Client agent cards
  app.get('/agents/:id/.well-known/agent-card.json', (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);
    return c.json(toSdkAgentCard(conn.agentCard, conn, opts.publicUrl));
  });

  // Client agent A2A endpoints
  app.post('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);

    const rawBody = await c.req.text();
    const transport = getTransport(conn);
    const result = await transport.handle(rawBody);
    return handleTransportResult(result, c);
  });

  return app;
}
