import path from 'node:path';
import fs from 'node:fs';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { stream } from 'hono/streaming';
import { html } from 'hono/html';
import { cors } from 'hono/cors';
import { sentry } from '@sentry/hono/node';
import * as Sentry from '@sentry/hono/node';
import {
  A2XServer,
  createSSEStream,
  DefaultRequestHandler,
  HttpJsonRequestHandler,
  JSONParseError,
  toHttpJsonErrorResponse,
  type AgentCardV03,
  type AgentCardV10,
  type HttpJsonResponse,
  type RequestContext,
} from '@a2x/sdk';
import type { ClientConnection, Registry } from './registry.js';
import { createAdminA2XServer } from './admin.js';
import { getAdminWallets, isAdmin } from './admin-scope.js';
import { requestUsage, UsageRpcError } from './usage-rpc.js';
import {
  AdminApiError,
  addCaller,
  addFederatedCaller,
  clearX402Pricing,
  deleteClientForOwner,
  getX402Pricing,
  issueAgentApiKey,
  listActiveAgents,
  listCallers,
  listClientsForOwner,
  removeCaller,
  removeFederatedCaller,
  setX402Pricing,
} from './admin-api.js';
import {
  AGENT_UNAVAILABLE_RETRY_AFTER_SECONDS,
  agentAuthMiddleware,
  classifyMissingAgent,
  getAgentConn,
  getCaller,
  newRejectionId,
  rejectAgentRequest,
} from './agent-auth.js';
import { CALLER_TOKEN_PREFIX, OWNER_SESSION_PREFIX, verifySessionToken } from './auth/caller-token.js';
import { mountDeviceFlow } from './auth/device-flow.js';
import { mountDeviceUi } from './auth/device-ui.js';
import { mountTokenRevocation } from './auth/revoke.js';
import { mountSiweExchange } from './auth/siwe-exchange.js';
import {
  A2A_EXTENSIONS_HEADER,
  A2A_EXTENSIONS_LEGACY_HEADER,
  parseA2AExtensionsHeader,
} from './a2a-extensions.js';
import type { GoogleConfig } from './auth/google-oauth.js';
import type { Sql } from './db.js';
import { Landing } from './landing.js';
import { logEvent } from './log.js';
import { buildAgentA2XServer, type AgentA2XOptions } from './agent-card.js';
import {
  PostgresIdentityReplayStore,
  SafeDidWebResolver,
  canonicalAgentMention,
  prepareIdentityVcAtBoundary,
  type DidDocumentResolver,
  type IdentityReplayStore,
} from './identity-vc/index.js';
import { IDENTITY_VC_PRESENTED_METADATA_KEY } from './identity-vc/types.js';
import {
  PostgresTaskStore,
  parsePersistRequestEnvelope,
} from './postgres-task-store.js';
import {
  buildLandingDirectory,
  mountWellKnown,
  type ConnectionPair,
  type WellKnownDeps,
} from './well-known.js';
import { mountOAuthFederationRoutes } from './oauth-federation/routes.js';
import {
  authorizeFederatedOperation,
  parseFederatedHttpJsonOperation,
  parseFederatedJsonRpcOperation,
  type FederatedOperation,
} from './oauth-federation/authorization.js';

export interface ServerHttpOptions {
  registry: Registry;
  publicUrl?: string;
  db: Sql;
  google?: GoogleConfig;     // absent = device flow endpoints disabled
  deviceFlowStateSecret?: string;
  // Test seams for deterministic identity VC verification. Production uses
  // the SSRF-safe did:web resolver and Postgres replay store below.
  identityVc?: {
    resolver?: DidDocumentResolver;
    replayStore?: IdentityReplayStore;
    now?: () => Date;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drop caller-supplied `_`-prefixed keys from `message.metadata` in place at
 * the HTTP boundary. The `_*` convention marks bridge-internal context
 * (`_principalId`, `_bearerToken`, `_email`) that downstream code — the
 * executor's binding stamp, the admin executor's auth resolve — treats as
 * trusted. Without this strip, a caller could put `_principalId:
 * eth:victim` in their request body and it would (on public agents, where
 * the auth middleware doesn't inject one) flow through to the task binding
 * and downstream `task_*` logs as if it had been verified.
 *
 * Mutates `message.metadata` so the existing downstream code (which reads
 * `message.metadata` directly) sees the scrubbed object. Removes the
 * metadata field entirely when only `_*` keys were present, so the WS frame
 * keeps its pre-existing wire shape for messages that arrived bare.
 *
 * Exported for unit tests.
 */
export function stripCallerSuppliedInternalKeys(message: Record<string, unknown>): void {
  if (!isRecord(message.metadata)) return;
  for (const key of Object.keys(message.metadata)) {
    if (key.startsWith('_')) {
      delete (message.metadata as Record<string, unknown>)[key];
    }
  }
  if (Object.keys(message.metadata).length === 0) {
    delete message.metadata;
  }
}

export function createHttpApp(opts: ServerHttpOptions): Hono {
  const app = new Hono();
  const identityVcResolver = opts.identityVc?.resolver ?? new SafeDidWebResolver();
  const identityVcReplayStore =
    opts.identityVc?.replayStore ?? new PostgresIdentityReplayStore(opts.db);

  // Sentry request tracing + error capture. Sentry.init() runs in instrument.ts
  // (imported first in cli.ts); register this before any other middleware so it
  // wraps the entire request lifecycle and captures errors from app.onError.
  app.use(sentry(app));

  // The deployed admin UI lives at the same origin as the bridge (mounted
  // under /admin), but during local dev it runs on Vite. Reflect the
  // request Origin so cross-origin XHR from the dev UI works without
  // baking a wildcard into the response. `credentials: true` is needed
  // because A2XClient sends `Authorization: Bearer ...` headers.
  app.use(
    '*',
    cors({
      origin: (origin) => origin ?? '',
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'A2A-Version',
        A2A_EXTENSIONS_HEADER,
        A2A_EXTENSIONS_LEGACY_HEADER,
      ],
      // PUT is here for /admin-api/agents/:id/x402. Without it a browser
      // client (the Vite dev UI) fails preflight even though the CLI's Node
      // fetch, which sends no preflight, gets through.
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      credentials: true,
      maxAge: 600,
    }),
  );

  // The built-in admin agent and every connected client agent get distinct
  // owner-scoped views of the same Postgres table. A handler can therefore
  // never resolve another agent's task by taskId.
  const { handler: adminHandler, a2xServer: adminA2X } = createAdminA2XServer({
    db: opts.db,
    registry: opts.registry,
    publicUrl: opts.publicUrl,
  });
  const adminCard = adminA2X.getAgentCard() as AgentCardV03;
  const persistRequestEnvelope = parsePersistRequestEnvelope(
    process.env.A2A_PERSIST_REQUEST_ENVELOPE,
  );

  // Per-agent A2XServer cache. Rebuilds on caller-/agent-change so the
  // card reflects the latest connection state.
  const agentCache = new Map<string, A2XServer>();
  const handlerCache = new Map<string, DefaultRequestHandler>();
  const agentV1Cache = new Map<string, A2XServer>();
  const handlerV1Cache = new Map<string, DefaultRequestHandler>();
  const httpJsonV1Cache = new Map<string, HttpJsonRequestHandler>();

  // Device flow endpoints (/oauth/device/code, /oauth/token) are only mounted
  // when Google OAuth is fully configured. Surface this to the agent card and
  // the agent-auth error hint so SIWE-only deployments don't point callers at
  // non-existent endpoints.
  const deviceFlowEnabled = Boolean(opts.google && opts.publicUrl);
  const agentCardOpts: AgentA2XOptions = {
    publicUrl: opts.publicUrl,
    deviceFlowEnabled,
    db: opts.db,
  };

  function getAgentForConn(conn: ClientConnection): A2XServer {
    const cached = agentCache.get(conn.agentId);
    if (cached) return cached;
    const taskStore = new PostgresTaskStore(opts.db, {
      persistRequestEnvelope,
      ownerAgent: conn.agentId,
    });
    const a2x = buildAgentA2XServer(conn, taskStore, opts.registry, agentCardOpts);
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

  function getAgentV1ForConn(conn: ClientConnection): A2XServer {
    const cached = agentV1Cache.get(conn.agentId);
    if (cached) return cached;
    const taskStore = new PostgresTaskStore(opts.db, {
      persistRequestEnvelope,
      ownerAgent: conn.agentId,
    });
    const a2x = buildAgentA2XServer(conn, taskStore, opts.registry, {
      ...agentCardOpts,
      protocolVersion: '1.0',
    });
    agentV1Cache.set(conn.agentId, a2x);
    return a2x;
  }

  function getHandlerV1ForConn(conn: ClientConnection): DefaultRequestHandler {
    const cached = handlerV1Cache.get(conn.agentId);
    if (cached) return cached;
    const handler = new DefaultRequestHandler(getAgentV1ForConn(conn));
    handlerV1Cache.set(conn.agentId, handler);
    return handler;
  }

  function getHttpJsonV1ForConn(conn: ClientConnection): HttpJsonRequestHandler {
    const cached = httpJsonV1Cache.get(conn.agentId);
    if (cached) return cached;
    const handler = new HttpJsonRequestHandler(getHandlerV1ForConn(conn), {
      basePath: `/agents/${conn.agentId}/v1`,
    });
    httpJsonV1Cache.set(conn.agentId, handler);
    return handler;
  }

  // Invalidate cached A2XServer + handler when allowedCallers changes so
  // the rendered card reflects the updated security fields.
  opts.registry.onCallerChange((agentId) => {
    agentCache.delete(agentId);
    handlerCache.delete(agentId);
    agentV1Cache.delete(agentId);
    handlerV1Cache.delete(agentId);
    httpJsonV1Cache.delete(agentId);
  });
  // Also invalidate on (re)registration or disconnect. The handler
  // captures the agent card at construction time — including
  // `capabilities.streaming` — so a client that reconnects with an
  // updated card would otherwise be served by a stale handler that
  // still advertises the old capabilities.
  opts.registry.onAgentChange((agentId) => {
    agentCache.delete(agentId);
    handlerCache.delete(agentId);
    agentV1Cache.delete(agentId);
    handlerV1Cache.delete(agentId);
    httpJsonV1Cache.delete(agentId);
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

  function handleHttpJsonResponse(response: HttpJsonResponse): Response {
    const headers = { ...response.headers, 'A2A-Version': '1.0' };
    if (
      response.body &&
      typeof response.body === 'object' &&
      Symbol.asyncIterator in response.body
    ) {
      return new Response(createSSEStream(response.body as AsyncGenerator<unknown>), {
        status: response.status,
        headers,
      });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers,
    });
  }

  function getRequestContext(c: Context): RequestContext {
    const url = new URL(c.req.url);
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    const queryVersion = url.searchParams.get('A2A-Version');
    if (queryVersion !== null && !('a2a-version' in headers)) {
      headers['a2a-version'] = queryVersion;
    }
    return {
      headers,
      query: Object.fromEntries(url.searchParams.entries()),
    };
  }

  async function prepareAgentRequestBody(
    body: unknown,
    c: Context,
    caller: ReturnType<typeof getCaller>,
    conn: ClientConnection,
  ): Promise<void> {
    if (!isRecord(body)) return;
    const params = isRecord(body.params) ? body.params : undefined;
    const message = isRecord(params?.message)
      ? params.message
      : isRecord(body.message)
        ? body.message
        : undefined;
    if (!message) return;

    const requestedExtensions = [
      ...parseA2AExtensionsHeader(c.req.header(A2A_EXTENSIONS_HEADER)),
      ...parseA2AExtensionsHeader(c.req.header(A2A_EXTENSIONS_LEGACY_HEADER)),
    ];
    if (requestedExtensions.length > 0) {
      const existing = Array.isArray(message.extensions)
        ? message.extensions.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      message.extensions = [...new Set([...existing, ...requestedExtensions])];
    }

    stripCallerSuppliedInternalKeys(message);
    const identityResult = await prepareIdentityVcAtBoundary(message, {
      conn,
      expectedDomain: canonicalAgentMention(conn.agentId, opts.publicUrl),
      resolver: identityVcResolver,
      replayStore: identityVcReplayStore,
      ...(opts.identityVc?.now !== undefined ? { now: opts.identityVc.now } : {}),
    });
    for (const rejection of identityResult.rejections) {
      logEvent('identity_vc_rejected', {
        agentId: conn.agentId,
        code: rejection.code,
      });
    }
    if (identityResult.accepted > 0) {
      logEvent('identity_vc_verified', {
        agentId: conn.agentId,
        count: identityResult.accepted,
      });
    }
    if (caller !== undefined) {
      const existingAttestations =
        isRecord(message.metadata) &&
        Array.isArray(message.metadata[IDENTITY_VC_PRESENTED_METADATA_KEY])
          ? message.metadata[IDENTITY_VC_PRESENTED_METADATA_KEY]
          : [];
      message.metadata = {
        ...(isRecord(message.metadata) ? message.metadata : {}),
        _principalId: caller.principalId,
        ...(caller.actorId !== undefined ? { _actorId: caller.actorId } : {}),
        ...(caller.federation?.allowedCaller !== undefined
          ? { _authorizationKey: caller.federation.allowedCaller }
          : {}),
        ...(caller.federation?.attestations !== undefined
          ? {
              [IDENTITY_VC_PRESENTED_METADATA_KEY]: [
                ...existingAttestations,
                ...caller.federation.attestations,
              ],
            }
          : {}),
      };
    }
  }

  async function enforceFederatedOperation(
    c: Context,
    caller: ReturnType<typeof getCaller>,
    operation: FederatedOperation | undefined,
    responseFormat: 'jsonrpc' | 'http-json',
  ): Promise<Response | undefined> {
    const result = await authorizeFederatedOperation(
      opts.db,
      c.req.param('id')!,
      caller,
      operation,
    );
    if (result.ok) return undefined;
    const rejectionId = newRejectionId();
    logEvent('oauth_federation_request_rejected', {
      agentId: c.req.param('id'),
      reason: result.reason,
      rejectionId,
    });
    return rejectAgentRequest(
      c,
      responseFormat,
      403,
      -32001,
      'Federated token is not authorized for this operation',
      rejectionId,
    );
  }

  function recordAgentRequest(
    c: Context,
    conn: ClientConnection,
    caller: ReturnType<typeof getCaller>,
  ): void {
    logEvent('agent_request', {
      agentId: conn.agentId,
      backend: conn.backendKind ?? 'inline',
      ownerEmail: conn.ownerEmail ?? undefined,
      hasAuth: !!c.req.header('Authorization'),
      ...(caller !== undefined
        ? {
            principalId: caller.principalId,
            ...(caller.email ? { callerEmail: caller.email } : {}),
          }
        : {}),
    });
    Sentry.getActiveSpan()?.setAttributes({
      'bridge.agent': conn.agentId,
      'bridge.backend': conn.backendKind ?? 'inline',
      'bridge.caller': caller?.principalId ?? 'public',
    });
  }

  // Derive the public hostname once. Used both for SIWE domain verification
  // and for the Mentionable / WebFinger surface, which keys lookups on the
  // bridge's external hostname.
  let siweDomain: string | undefined;
  if (opts.publicUrl) {
    try {
      siweDomain = new URL(opts.publicUrl).hostname;
    } catch {
      throw new Error(
        `PUBLIC_URL "${opts.publicUrl}" is not a valid URL — cannot configure SIWE domain verification or well-known Mentionable routes`,
      );
    }
  }

  if (opts.publicUrl) {
    mountOAuthFederationRoutes(app, {
      sql: opts.db,
      publicUrl: opts.publicUrl,
      resolver: identityVcResolver,
      passThroughOtherGrants: deviceFlowEnabled,
      ...(opts.identityVc?.now !== undefined ? { now: opts.identityVc.now } : {}),
    });
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Root agent card — the server itself is an A2A agent
  app.get('/.well-known/agent-card.json', (c) => c.json(adminCard));

  // Mentionable v0.1 surface (WebFinger + agent-card + Agent Directory)
  // exposing every connected client as `@<agentId>@<bridge-host>`, plus
  // the bridge's own admin agent at `@admin@<bridge-host>`. The agentId
  // "admin" is reserved (see reserved-agent-ids.ts) so a connected client
  // cannot shadow the admin entry.
  const wellKnownDeps: WellKnownDeps = {
    listAgents: () => opts.registry.listAgents(),
    getAgentCard: (conn) => getAgentForConn(conn).getAgentCard() as AgentCardV03,
    adminCard,
    publicUrl: opts.publicUrl,
    domain: siweDomain,
    deviceFlowEnabled,
    organizationName: adminCard.name,
  };
  mountWellKnown(app, wellKnownDeps);

  // Server info — HTML landing for browsers, JSON for API clients
  app.get('/', (c) => {
    // Single registry walk per request: the HTML landing's `clients` array
    // and the JSON-LD directory it embeds both derive from the same
    // (connection, AgentCardV03) snapshot. Reusing one snapshot means the
    // two views can never disagree mid-request — and getAgentCard, which
    // reads from a per-agent cache that's invalidated on caller-policy /
    // hello-frame changes, is called once per agent instead of twice.
    const pairs: ConnectionPair[] = opts.registry.listAgents().map((conn) => ({
      conn,
      card: getAgentForConn(conn).getAgentCard() as AgentCardV03,
    }));
    const clients = pairs.map(({ conn, card }) => ({
      id: conn.agentId,
      url: opts.publicUrl
        ? `${opts.publicUrl}/agents/${conn.agentId}`
        : `/agents/${conn.agentId}`,
      card,
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
    const directory = buildLandingDirectory(wellKnownDeps, pairs);
    return c.html(
      html`<!DOCTYPE html>${(
        <Landing
          adminCard={adminCard}
          clients={clients}
          adminWallets={getAdminWallets()}
          directory={directory}
        />
      )}`,
    );
  });

  // SIWE → opaque caller token exchange. Admin UI and any wallet-based client
  // signs a SIWE message once, then presents the returned vbc_caller_* token
  // on all subsequent requests.
  mountSiweExchange(app, { sql: opts.db, domain: siweDomain });

  // RFC 7009 token revocation. Mounted unconditionally — revocation is
  // independent of how the token was issued (SIWE exchange or device flow),
  // so SIWE-only deployments without Google OAuth still get /oauth/revoke.
  mountTokenRevocation(app, { sql: opts.db });

  // Single owner-session bearer check shared by POST '/' (admin agent A2A
  // endpoint) and the /admin-api/* routes. Returns structured success or
  // failure; each call site formats its own envelope (JSON-RPC for the A2A
  // route, plain `{error}` for /admin-api). Centralising this prevents the
  // two from drifting again — e.g. when the device-flow hint became
  // conditional on deviceFlowEnabled, only one path was updated last time.
  type OwnerSessionAuthResult =
    | {
        ok: true;
        principalId: string;
        email: string | undefined;
        bearerToken: string;
      }
    | { ok: false; kind: 'missing' | 'invalid'; message: string };

  async function authOwnerSession(c: Context): Promise<OwnerSessionAuthResult> {
    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (!bearerToken || !bearerToken.startsWith(OWNER_SESSION_PREFIX)) {
      // Device flow is optional (only mounted when Google OAuth is configured),
      // so don't point operators at /oauth/device/code on SIWE-only deployments.
      const acquireHints = deviceFlowEnabled
        ? '/auth/siwe/exchange (intent=owner_session) or /oauth/device/code (intent=owner_session)'
        : '/auth/siwe/exchange (intent=owner_session)';
      return {
        ok: false,
        kind: 'missing',
        message:
          `Authentication required (Bearer ${OWNER_SESSION_PREFIX}* token). ` +
          `Acquire via ${acquireHints}.`,
      };
    }
    try {
      const caller = await verifySessionToken(opts.db, bearerToken, {
        expectedAudience: 'owner_session',
      });
      return {
        ok: true,
        principalId: caller.principalId,
        email: caller.email,
        bearerToken,
      };
    } catch (err) {
      return {
        ok: false,
        kind: 'invalid',
        message: `Invalid session token: ${(err as Error).message}`,
      };
    }
  }

  // Root POST — admin agent A2A endpoint. Owner-session-audience only
  // (`vbc_owner_*`); caller-audience tokens (`vbc_caller_*`) are rejected
  // because admin chat is for the resource owner managing their own
  // clients/policies, not for third-party agent invocation. RLS scopes
  // what the operator can see; admin scope (`is_admin()`) stays
  // wallet-only by design (issue #79).
  app.post('/', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) {
      // The A2A endpoint adds an extra hint about caller-audience tokens
      // because operators commonly try the wrong bearer here when they
      // already have a /agents/:id one.
      const message =
        auth.kind === 'missing'
          ? `${auth.message} ${CALLER_TOKEN_PREFIX}* tokens are not accepted here — those are for /agents/:id calls.`
          : auth.message;
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message },
        },
        401,
      );
    }

    const rawBody = await c.req.text();
    const parsed = JSON.parse(rawBody);

    const message = parsed.params?.message;
    if (isRecord(message)) {
      message.metadata = {
        ...(isRecord(message.metadata) ? message.metadata : {}),
        _principalId: auth.principalId,
        _bearerToken: auth.bearerToken,
        ...(auth.email !== undefined ? { _email: auth.email } : {}),
      };
    }

    const result = await adminHandler.handle(parsed);
    return handleHandlerResult(result, c);
  });

  // Deterministic admin RPC at /admin-api/*. Same owner_session bearer
  // requirement as the admin agent at POST '/', but the request never
  // crosses the LLM — these are direct calls to the same shared functions
  // (admin-api.ts) the admin agent's tools use. Lets CLI / scripts manage
  // callers and inspect connected agents without per-call LLM cost.
  function adminApiUnauthorized(c: Context, auth: Extract<OwnerSessionAuthResult, { ok: false }>): Response {
    return c.json({ error: auth.message }, 401);
  }

  function adminApiErrorResponse(c: Context, err: unknown): Response {
    if (err instanceof AdminApiError) {
      // Cast to a Hono-acceptable status union. AdminApiError uses standard
      // HTTP codes that Hono accepts for c.json's second arg: 400 invalid
      // input, 401 auth (currently emitted only by adminApiUnauthorized,
      // not through this path, but kept in the union so a future
      // AdminApiError with status 401 still typechecks), 403 forbidden,
      // 404 not-found / RLS-hidden, 409 ambiguous-client-name from
      // deleteClientForOwner.
      return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409);
    }
    logEvent('admin_api_error', { error: String(err) });
    return c.json({ error: 'Internal error' }, 500);
  }

  app.get('/admin-api/agents', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    return c.json({ agents: listActiveAgents(opts.registry, auth.principalId) });
  });

  app.get('/admin-api/agents/:id/callers', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    try {
      const result = await listCallers(opts.db, auth.principalId, c.req.param('id'));
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  // x402 pricing. The only write path for `agents.x402_pricing` — it is
  // DB-owned rather than declared by the connecting agent because `payTo`
  // names the wallet that gets paid. Unlike the agent's own token, these
  // routes take the owner-session bearer, so a stolen agent token cannot
  // reprice or redirect payments.
  app.get('/admin-api/agents/:id/x402', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    try {
      return c.json(await getX402Pricing(opts.db, auth.principalId, c.req.param('id')));
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  app.put('/admin-api/agents/:id/x402', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be a JSON x402 pricing object.' }, 400);
    }
    try {
      const result = await setX402Pricing(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
        body,
      );
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  app.delete('/admin-api/agents/:id/x402', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    try {
      const result = await clearX402Pricing(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
      );
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  // Per-account backend usage for a connected agent. Restricted to the bridge
  // admin or the agent's owning user. Supported by the `vicoop-codex` and
  // `claude` backends; the data is pulled from the client over the WS
  // (usage-rpc) and the backend's usage() payload is returned verbatim.
  app.get('/admin-api/agents/:id/usage', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    const agentId = c.req.param('id');
    const conn = opts.registry.getAgent(agentId);
    // Collapse "not connected" and "not authorized" into one 404 so a
    // non-owner can't probe which agent ids exist / are online.
    if (!conn || !(isAdmin(auth.principalId) || conn.ownerPrincipal === auth.principalId)) {
      return c.json({ error: 'Agent not found, not connected, or not authorized.' }, 404);
    }
    const USAGE_SUPPORTED_BACKENDS = ['vicoop-codex', 'claude'];
    if (!USAGE_SUPPORTED_BACKENDS.includes(conn.backendKind ?? '')) {
      return c.json(
        {
          error: `Usage is not available for backend '${conn.backendKind ?? 'unknown'}' (supported: ${USAGE_SUPPORTED_BACKENDS.join(', ')}).`,
        },
        400,
      );
    }
    try {
      const usage = await requestUsage(opts.registry, agentId);
      return c.json(usage as Record<string, unknown>);
    } catch (err) {
      if (err instanceof UsageRpcError) {
        const status = err.code === 'offline' ? 503 : err.code === 'timeout' ? 504 : 502;
        return c.json({ error: err.message, code: err.code }, status);
      }
      logEvent('admin_api_error', { error: String(err) });
      return c.json({ error: 'Internal error' }, 500);
    }
  });

  app.post('/admin-api/agents/:id/callers', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON: { "principal": "<...>" }' }, 400);
    }
    const principal =
      isRecord(body) && typeof body.principal === 'string' ? body.principal : null;
    if (!principal) {
      return c.json({ error: 'Body must be JSON: { "principal": "<...>" }' }, 400);
    }
    try {
      const result = await addCaller(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
        principal,
      );
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  async function federatedCallerBody(c: Context): Promise<
    | { ok: true; value: { issuer: string; method: string; subject: string } }
    | { ok: false; response: Response }
  > {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return {
        ok: false,
        response: c.json({ error: 'Body must be JSON: { issuer, method, subject }' }, 400),
      };
    }
    if (
      !isRecord(body) ||
      typeof body.issuer !== 'string' ||
      typeof body.method !== 'string' ||
      typeof body.subject !== 'string' ||
      Object.keys(body).some((key) => !['issuer', 'method', 'subject'].includes(key))
    ) {
      return {
        ok: false,
        response: c.json({ error: 'Body must be JSON: { issuer, method, subject }' }, 400),
      };
    }
    return {
      ok: true,
      value: { issuer: body.issuer, method: body.method, subject: body.subject },
    };
  }

  app.post('/admin-api/agents/:id/federated-callers', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    const parsed = await federatedCallerBody(c);
    if (!parsed.ok) return parsed.response;
    try {
      return c.json(await addFederatedCaller(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
        parsed.value,
      ));
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  app.delete('/admin-api/agents/:id/federated-callers', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    const parsed = await federatedCallerBody(c);
    if (!parsed.ok) return parsed.response;
    try {
      return c.json(await removeFederatedCaller(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
        parsed.value,
      ));
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  // List the owner's `clients` rows so operators can see persisted state
  // (including orphans from aborted setup / exited daemons) without
  // dropping to admin GraphQL or psql. RLS filters to the principal's own
  // rows. `connected` is the in-memory registry view so callers can spot
  // orphans at a glance — see issue #166.
  app.get('/admin-api/clients', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    try {
      const clients = await listClientsForOwner(opts.db, opts.registry, auth.principalId);
      return c.json({ clients });
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  // Delete a client by id or unique name. The target travels in the URL path
  // and may be a UUID `client_id` or a `client_name`; the server resolves
  // the ambiguity (404 if neither matches, 409 with the candidate ids if a
  // name matches multiple rows). On success, hard-deletes the agents +
  // clients rows and closes every live WS bound to the client with code
  // 4014 — see the close-code rationale in Registry.disconnectClient.
  app.delete('/admin-api/clients/:target', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    try {
      const result = await deleteClientForOwner(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('target'),
      );
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  // Principal removal uses ?principal=<urlencoded> rather than a path
  // segment so colon-delimited principals (eth:0x…, google:email:…@…) and
  // any future principal kinds with unusual characters survive routing.
  app.delete('/admin-api/agents/:id/callers', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    const principal = c.req.query('principal');
    if (!principal) {
      return c.json({ error: 'Query parameter "principal" is required' }, 400);
    }
    try {
      const result = await removeCaller(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
        principal,
      );
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
  });

  // Static API keys (issue #308). An API key is a server-minted caller token
  // (provider='apikey') whose `apikey:<key-id>` principal is auto-added to the
  // agent's allowed_callers, so non-interactive callers (CI, backend services)
  // can authenticate with a single Bearer instead of a Google/SIWE login flow.
  // Minting is the only apikey-specific route — listing and revoking fold into
  // the unified caller surface (GET/DELETE /admin-api/agents/:id/callers; the
  // DELETE revokes the underlying token when the principal is an apikey).
  app.post('/admin-api/agents/:id/apikeys', async (c) => {
    const auth = await authOwnerSession(c);
    if (!auth.ok) return adminApiUnauthorized(c, auth);
    // Body is optional: {} mints a key with the default TTL and no label.
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: 'Body must be JSON: { "label"?: string, "ttlDays"?: number }' }, 400);
      }
    }
    if (!isRecord(body)) {
      return c.json({ error: 'Body must be a JSON object.' }, 400);
    }
    const label = typeof body.label === 'string' ? body.label : undefined;
    if (body.ttlDays !== undefined && typeof body.ttlDays !== 'number') {
      return c.json({ error: '"ttlDays" must be a number (days).' }, 400);
    }
    const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : undefined;
    try {
      const result = await issueAgentApiKey(
        opts.db,
        opts.registry,
        auth.principalId,
        c.req.param('id'),
        { label, ttlDays },
      );
      return c.json(result);
    } catch (err) {
      return adminApiErrorResponse(c, err);
    }
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
  app.get('/agents/:id/.well-known/agent-card.json', async (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) {
      // Issue #352 — the card itself only exists on a live connection, but a
      // registered-but-offline agent is still a transient 503, not a 404.
      if ((await classifyMissingAgent(opts.db, id)) === 'offline') {
        c.header('Retry-After', String(AGENT_UNAVAILABLE_RETRY_AFTER_SECONDS));
        return c.json({ error: 'agent temporarily unavailable' }, 503);
      }
      return c.json({ error: 'agent not connected' }, 404);
    }
    return c.json(getAgentForConn(conn).getAgentCard() as AgentCardV03);
  });

  // A2A v1 card. It deliberately lives below the versioned base URL so the
  // existing v0.3 discovery and JSON-RPC endpoint remain byte-for-byte
  // compatible for deployed clients.
  app.get('/agents/:id/v1/.well-known/agent-card.json', async (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) {
      if ((await classifyMissingAgent(opts.db, id)) === 'offline') {
        c.header('Retry-After', String(AGENT_UNAVAILABLE_RETRY_AFTER_SECONDS));
        return c.json({ error: 'agent temporarily unavailable' }, 503);
      }
      return c.json({ error: 'agent not connected' }, 404);
    }
    return c.json(getAgentV1ForConn(conn).getAgentCard() as AgentCardV10);
  });

  // Client agent A2A endpoints (auth middleware checks allowedCallers)
  const authMw = agentAuthMiddleware(opts.registry, {
    sql: opts.db,
    deviceFlowEnabled,
    siweDomain,
  });
  const httpJsonAuthMw = agentAuthMiddleware(opts.registry, {
    sql: opts.db,
    deviceFlowEnabled,
    siweDomain,
    responseFormat: 'http-json',
  });
  app.post('/agents/:id', authMw, async (c) => {
    const conn = getAgentConn(c);
    // caller is undefined for public agents (allowedCallers.length === 0) —
    // the middleware short-circuits before parsing the bearer in that case.
    // For restricted agents it's always populated; otherwise the middleware
    // would have returned 401/403 before reaching this handler.
    const caller = getCaller(c);
    recordAgentRequest(c, conn, caller);
    const rawBody = await c.req.text();
    const parsed = JSON.parse(rawBody);
    const federatedRejection = await enforceFederatedOperation(
      c,
      caller,
      parseFederatedJsonRpcOperation(parsed),
      'jsonrpc',
    );
    if (federatedRejection) return federatedRejection;
    await prepareAgentRequestBody(parsed, c, caller, conn);
    const handler = getHandlerForConn(conn);
    const result = await handler.handle(parsed);
    return handleHandlerResult(result, c);
  });

  // A2A v1 JSON-RPC binding. v1 method names and wire shapes are handled by a
  // dedicated v1 A2XServer; sharing the Postgres owner scope keeps its tasks
  // visible through the sibling HTTP+JSON binding.
  app.post('/agents/:id/v1', authMw, async (c) => {
    const conn = getAgentConn(c);
    const caller = getCaller(c);
    recordAgentRequest(c, conn, caller);
    const rawBody = await c.req.text();
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // DefaultRequestHandler accepts a string and returns the protocol's
      // structured JSON parse error, so don't turn malformed JSON into a 500.
    }
    if (isRecord(body)) {
      const federatedRejection = await enforceFederatedOperation(
        c,
        caller,
        parseFederatedJsonRpcOperation(body),
        'jsonrpc',
      );
      if (federatedRejection) return federatedRejection;
    }
    await prepareAgentRequestBody(body, c, caller, conn);
    c.header('A2A-Version', '1.0');
    const result = await getHandlerV1ForConn(conn).handle(body, getRequestContext(c));
    return handleHandlerResult(result, c);
  });

  // A2A v1 HTTP+JSON binding. Operation paths are relative to the same base
  // URL advertised for JSON-RPC, e.g. POST message:send and GET tasks/{id}.
  app.all('/agents/:id/v1/*', httpJsonAuthMw, async (c) => {
    const conn = getAgentConn(c);
    const caller = getCaller(c);
    recordAgentRequest(c, conn, caller);
    const context = getRequestContext(c);
    let body: unknown;
    if (c.req.method === 'POST') {
      const mediaType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
      // Let the SDK produce its canonical content-type error before attempting
      // to parse an unsupported payload format.
      if (mediaType === 'application/a2a+json' || mediaType === 'application/json') {
        const rawBody = await c.req.text();
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            return handleHttpJsonResponse(
              toHttpJsonErrorResponse(new JSONParseError('Invalid JSON request body')),
            );
          }
        }
      }
    }
    const federatedRejection = await enforceFederatedOperation(
      c,
      caller,
      parseFederatedHttpJsonOperation(c.req.method, c.req.path, body),
      'http-json',
    );
    if (federatedRejection) return federatedRejection;
    await prepareAgentRequestBody(body, c, caller, conn);
    const response = await getHttpJsonV1ForConn(conn).handle({
      method: c.req.method,
      url: c.req.url,
      body,
      context,
    });
    return handleHttpJsonResponse(response);
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
