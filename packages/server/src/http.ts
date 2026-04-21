import path from 'node:path';
import fs from 'node:fs';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
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
import { agentAuthMiddleware, getAgentConn } from './agent-auth.js';
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
  const card: SdkAgentCard = {
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
  if (conn.allowedCallers.length > 0) {
    card.securitySchemes = {
      siwe: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'SIWE',
        description: 'Sign-In with Ethereum (EIP-4361) bearer token',
      },
    };
    card.security = [{ siwe: [] }];
  }
  return card;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLandingPage(opts: {
  adminCard: SdkAgentCard;
  clients: Array<{ id: string; url: string; card: SdkAgentCard }>;
}): string {
  const e = escapeHtml;
  const clientItems = opts.clients.length
    ? opts.clients
        .map(
          (c) => `
          <li>
            <code>${e(c.id)}</code> — ${e(c.card.name)}
            <span class="muted">v${e(c.card.version)}</span>
            · <a href="/agents/${e(c.id)}/.well-known/agent-card.json">card</a>
          </li>`,
        )
        .join('')
    : '<li class="muted">No clients connected.</li>';

  const skillItems = opts.adminCard.skills
    .map(
      (s) =>
        `<li><strong>${e(s.name)}</strong> <span class="muted">— ${e(s.description ?? '')}</span></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>vicoop-bridge</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      max-width: 720px;
      margin: 2rem auto;
      padding: 0 1rem;
      line-height: 1.5;
    }
    h1 { margin-bottom: 0.25rem; }
    h2 {
      margin-top: 2rem;
      border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
      padding-bottom: 0.25rem;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
      padding: 0.1em 0.3em;
      background: color-mix(in srgb, currentColor 10%, transparent);
      border-radius: 3px;
    }
    .muted { opacity: 0.7; font-size: 0.9em; }
    .lede { opacity: 0.8; margin-top: 0; }
    ul { padding-left: 1.25rem; }
    li { margin: 0.25rem 0; }
    a { color: inherit; }
  </style>
</head>
<body>
  <h1>vicoop-bridge</h1>
  <p class="lede">A2A server for outbound-connected local agents.</p>

  <h2>Admin agent</h2>
  <p>
    <strong>${e(opts.adminCard.name)}</strong>
    <span class="muted">v${e(opts.adminCard.version)}</span>
  </p>
  <p>${e(opts.adminCard.description)}</p>
  <p>Skills:</p>
  <ul>${skillItems}</ul>
  <p>Card: <a href="/.well-known/agent-card.json"><code>/.well-known/agent-card.json</code></a></p>

  <h2>Connected clients (${opts.clients.length})</h2>
  <ul>${clientItems}</ul>

  <h2>Tools</h2>
  <ul>
    <li><a href="/admin">Admin UI</a></li>
    <li><a href="/graphiql">GraphiQL</a></li>
  </ul>
</body>
</html>`;
}

export function createHttpApp(opts: ServerHttpOptions): Hono {
  const app = new Hono();

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
    // Rebuild transport when security state changes (allowedCallers toggled)
    const cached = transports.get(conn.agentId);
    if (cached) return cached;
    const card = toSdkAgentCard(conn.agentCard, conn, opts.publicUrl);
    const executor = new ServerAgentExecutor(conn.agentId, opts.registry);
    const handler = new DefaultRequestHandler(card, taskStore, executor);
    const transport = new JsonRpcTransportHandler(handler);
    transports.set(conn.agentId, transport);
    return transport;
  }

  // Invalidate cached transport when allowedCallers changes so the
  // handler's card reflects the updated security fields.
  opts.registry.onCallerChange((agentId) => {
    transports.delete(agentId);
  });

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

  // Server info — HTML landing for browsers, JSON for API clients
  app.get('/', (c) => {
    const clients = opts.registry.listAgents().map((a) => ({
      id: a.agentId,
      url: opts.publicUrl
        ? `${opts.publicUrl}/agents/${a.agentId}`
        : `/agents/${a.agentId}`,
      card: toSdkAgentCard(a.agentCard, a, opts.publicUrl),
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
    return c.html(renderLandingPage({ adminCard, clients }));
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

  // Root POST — admin agent A2A endpoint (SIWE auth)
  app.post('/', async (c) => {
    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (!bearerToken) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Authentication required (Bearer SIWE token)' },
      }, 401);
    }

    let walletAddress: string;
    try {
      walletAddress = await verifySiweToken(bearerToken, { domain: siweDomain });
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

  // Client agent A2A endpoints (auth middleware checks allowedCallers)
  const authMw = agentAuthMiddleware(opts.registry, { domain: siweDomain });
  app.post('/agents/:id', authMw, async (c) => {
    const conn = getAgentConn(c);

    const rawBody = await c.req.text();
    const transport = getTransport(conn);
    const result = await transport.handle(rawBody);
    return handleTransportResult(result, c);
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
