import path from 'node:path';
import fs from 'node:fs';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { stream } from 'hono/streaming';
import { html } from 'hono/html';
import {
  A2XAgent,
  DefaultRequestHandler,
  type AgentCardV03,
} from '@a2x/sdk';
import type { ClientConnection, Registry } from './registry.js';
import { createAdminA2XAgent, getAdminWallets } from './admin.js';
import { agentAuthMiddleware, getAgentConn } from './agent-auth.js';
import { CALLER_TOKEN_PREFIX, verifyCallerToken } from './auth/caller-token.js';
import { mountDeviceFlow } from './auth/device-flow.js';
import { mountDeviceUi } from './auth/device-ui.js';
import { mountSiweExchange } from './auth/siwe-exchange.js';
import type { GoogleConfig } from './auth/google-oauth.js';
import type { Sql } from './db.js';
import { Landing } from './landing.js';
import { logEvent } from './log.js';
import { buildAgentA2XAgent, type AgentA2XOptions } from './agent-card.js';

export interface ServerHttpOptions {
  registry: Registry;
  publicUrl?: string;
  db: Sql;
  google?: GoogleConfig;     // absent = device flow endpoints disabled
  deviceFlowStateSecret?: string;
}

export function createHttpApp(opts: ServerHttpOptions): Hono {
  const app = new Hono();

  // Built-in admin agent at root. The admin agent owns its own taskStore
  // (Postgres-backed) for context-aware history loading; client agents
  // share a separate taskStore so their state isn't entangled with the
  // admin's persistence model.
  const { handler: adminHandler, a2xAgent: adminA2X, taskStore: adminTaskStore } =
    createAdminA2XAgent({
      db: opts.db,
      registry: opts.registry,
      publicUrl: opts.publicUrl,
    });
  const adminCard = adminA2X.getAgentCard() as AgentCardV03;

  // Per-agent A2XAgent cache. Rebuilds on caller-/agent-change so the
  // card reflects the latest connection state.
  const agentCache = new Map<string, A2XAgent>();
  const handlerCache = new Map<string, DefaultRequestHandler>();

  // Device flow endpoints (/oauth/device/code, /oauth/token) are only mounted
  // when Google OAuth is fully configured. Surface this to the agent card and
  // the agent-auth error hint so SIWE-only deployments don't point callers at
  // non-existent endpoints.
  const deviceFlowEnabled = Boolean(opts.google && opts.publicUrl);
  const agentCardOpts: AgentA2XOptions = {
    publicUrl: opts.publicUrl,
    deviceFlowEnabled,
  };

  function getAgentForConn(conn: ClientConnection): A2XAgent {
    const cached = agentCache.get(conn.agentId);
    if (cached) return cached;
    const a2x = buildAgentA2XAgent(conn, adminTaskStore, opts.registry, agentCardOpts);
    agentCache.set(conn.agentId, a2x);
    return a2x;
  }

  function getHandlerForConn(conn: ClientConnection): DefaultRequestHandler {
    const cached = handlerCache.get(conn.agentId);
    if (cached) return cached;
    const handler = new DefaultRequestHandler(getAgentForConn(conn));
    handlerCache.set(conn.agentId, handler);
    return handler;
  }

  // Invalidate cached A2XAgent + handler when allowedCallers changes so
  // the rendered card reflects the updated security fields.
  opts.registry.onCallerChange((agentId) => {
    agentCache.delete(agentId);
    handlerCache.delete(agentId);
  });
  // Also invalidate on (re)registration or disconnect. The handler
  // captures the agent card at construction time — including
  // `capabilities.streaming` — so a client that reconnects with an
  // updated card would otherwise be served by a stale handler that
  // still advertises the old capabilities.
  opts.registry.onAgentChange((agentId) => {
    agentCache.delete(agentId);
    handlerCache.delete(agentId);
  });

  async function handleHandlerResult(result: unknown, c: Context) {
    if (result && typeof result === 'object' && Symbol.asyncIterator in (result as object)) {
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
    return c.json(result as Record<string, unknown>);
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Root agent card — the server itself is an A2A agent
  app.get('/.well-known/agent-card.json', (c) => c.json(adminCard));

  // Server info — HTML landing for browsers, JSON for API clients
  app.get('/', (c) => {
    const clients = opts.registry.listAgents().map((a) => ({
      id: a.agentId,
      url: opts.publicUrl
        ? `${opts.publicUrl}/agents/${a.agentId}`
        : `/agents/${a.agentId}`,
      card: getAgentForConn(a).getAgentCard() as AgentCardV03,
    }));

    const accept = c.req.header('accept') ?? '';
    const wantsJson =
      accept.includes('application/json') && !accept.includes('text/html');
    if (wantsJson) {
      return c.json({
        name: 'vicoop-bridge',
        description: 'A2A server for outbound-connected local agents',
        version: '0.0.0',
        url: opts.publicUrl,
        card: adminCard,
        clients,
      });
    }
    return c.html(
      html`<!DOCTYPE html>${(
        <Landing
          adminCard={adminCard}
          clients={clients}
          adminWallets={getAdminWallets()}
        />
      )}`,
    );
  });

  // Derive SIWE domain early so both admin and agent endpoints use it
  let siweDomain: string | undefined;
  if (opts.publicUrl) {
    try {
      siweDomain = new URL(opts.publicUrl).hostname;
    } catch {
      throw new Error(`PUBLIC_URL "${opts.publicUrl}" is not a valid URL — cannot configure SIWE domain verification`);
    }
  }

  // SIWE → opaque caller token exchange. Admin UI and any wallet-based client
  // signs a SIWE message once, then presents the returned vbc_caller_* token
  // on all subsequent requests.
  mountSiweExchange(app, { sql: opts.db, domain: siweDomain });

  // Root POST — admin agent A2A endpoint. Requires opaque caller token with
  // an `eth:*` principal (admin agent is wallet-based; Google-only callers
  // can still call /agents/:id but have no admin GraphQL access under the
  // current owner_wallet schema).
  app.post('/', async (c) => {
    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (!bearerToken || !bearerToken.startsWith(CALLER_TOKEN_PREFIX)) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: `Authentication required (Bearer ${CALLER_TOKEN_PREFIX}* token). Acquire via /auth/siwe/exchange.`,
        },
      }, 401);
    }

    let walletAddress: string;
    try {
      const caller = await verifyCallerToken(opts.db, bearerToken);
      if (!caller.principalId.startsWith('eth:')) {
        return c.json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: 'Admin agent requires a wallet-based caller token (eth:*). Sign in via SIWE.',
          },
        }, 403);
      }
      walletAddress = caller.principalId.slice('eth:'.length);
    } catch (err) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: `Invalid caller token: ${(err as Error).message}` },
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

    const result = await adminHandler.handle(parsed);
    return handleHandlerResult(result, c);
  });

  // Device flow endpoints (RFC-8628) — optional: only mounted when Google config is provided
  if (opts.google && opts.publicUrl) {
    if (!opts.deviceFlowStateSecret) {
      throw new Error('deviceFlowStateSecret is required when google OAuth is configured');
    }
    mountDeviceFlow(app, { sql: opts.db, publicUrl: opts.publicUrl });
    mountDeviceUi(app, {
      sql: opts.db,
      google: opts.google,
      stateSecret: opts.deviceFlowStateSecret,
      publicUrl: opts.publicUrl,
    });
  }

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
    return c.json(getAgentForConn(conn).getAgentCard() as AgentCardV03);
  });

  // Client agent A2A endpoints (auth middleware checks allowedCallers)
  const authMw = agentAuthMiddleware(opts.registry, {
    sql: opts.db,
    deviceFlowEnabled,
  });
  app.post('/agents/:id', authMw, async (c) => {
    const conn = getAgentConn(c);
    logEvent('agent_request', {
      agentId: conn.agentId,
      hasAuth: !!c.req.header('Authorization'),
    });

    const rawBody = await c.req.text();
    const parsed = JSON.parse(rawBody);
    const handler = getHandlerForConn(conn);
    const result = await handler.handle(parsed);
    return handleHandlerResult(result, c);
  });

  // Admin UI — serve static SPA from /admin
  const adminDistDir = path.resolve(import.meta.dirname, '../../admin-ui/dist');
  if (fs.existsSync(adminDistDir)) {
    app.use('/admin/*', serveStatic({ root: adminDistDir, rewriteRequestPath: (p) => p.replace(/^\/admin/, '') }));
    // SPA fallback — serve index.html for all non-file admin routes
    app.get('/admin/*', async (c) => {
      const filePath = path.join(adminDistDir, 'index.html');
      const html = await fs.promises.readFile(filePath, 'utf-8');
      return c.html(html);
    });
  }

  return app;
}
