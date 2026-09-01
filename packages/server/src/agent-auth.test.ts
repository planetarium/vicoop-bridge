import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { SiweMessage } from 'siwe';
import { Wallet } from 'ethers';
import type { WebSocket } from 'ws';
import { CALLER_CONTEXT_V2_CAPABILITY, type AgentCard } from '@vicoop-bridge/protocol';
import {
  agentAuthMiddleware,
  getCaller,
  newRejectionId,
  sanitizeErrorDescription,
} from './agent-auth.js';
import { _resetSiweBearerCacheForTests } from './auth/siwe-bearer.js';
import { Registry, type ClientConnection } from './registry.js';
import type { Sql } from './db.js';

// Anvil account #0 — well-known test key, mirrors siwe-bearer.test.ts.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS_LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

async function mintBearer(opts: { domain: string; uri: string }): Promise<string> {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const issuedAt = new Date();
  const expirationTime = new Date(Date.now() + 60 * 60 * 1000);
  const msg = new SiweMessage({
    domain: opts.domain,
    address: wallet.address,
    statement: 'agent-auth test',
    uri: opts.uri,
    version: '1',
    chainId: 1,
    nonce: crypto.randomUUID().replace(/-/g, ''),
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
  });
  const message = msg.prepareMessage();
  const signature = await wallet.signMessage(message);
  const json = JSON.stringify({ message, signature });
  return Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Most reject paths exercised here never touch postgres — the middleware
// short-circuits on missing/malformed bearer headers before reaching
// verifyCallerToken (vbc_caller_* branch) or verifySiweBearerToken (SIWE
// branch). The exception is the missing-agent branch (issue #352), which
// checks the `agents` table to tell registered-but-offline (503) apart from
// unknown (404) — fakeSql answers that single query shape.
function fakeSql(registeredAgentIds: string[]): Sql {
  return (async (_strings: TemplateStringsArray, ...values: unknown[]) =>
    registeredAgentIds.includes(values[0] as string)
      ? [{ '?column?': 1 }]
      : []) as unknown as Sql;
}

function fakeAgentCard(name: string): AgentCard {
  return { name, version: '0.0.1', protocolVersion: '0.3.0' };
}

function registerAgent(
  registry: Registry,
  agentId: string,
  allowedCallers: string[],
  protocolCapabilities?: string[],
): void {
  const conn: ClientConnection = {
    agentId,
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    agentCard: fakeAgentCard(agentId),
    allowedCallers,
    ws: { close() {} } as unknown as WebSocket,
    connectedAt: Date.now(),
    ...(protocolCapabilities !== undefined ? { protocolCapabilities } : {}),
  };
  registry.registerAgent(conn);
}

function buildApp(opts: { siweDomain?: string; sql?: Sql } = {}): {
  app: Hono;
  registry: Registry;
} {
  const registry = new Registry();
  const app = new Hono();
  const mw = agentAuthMiddleware(registry, {
    sql: opts.sql ?? fakeSql([]),
    deviceFlowEnabled: false,
    siweDomain: opts.siweDomain,
  });
  app.post('/agents/:id', mw, (c) => c.json({ ok: true }));
  return { app, registry };
}

test('missing bearer responds with WWW-Authenticate realm and no error code (RFC 6750 §3.1)', async () => {
  const { app, registry } = buildApp();
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res = await app.request('/agents/restricted', { method: 'POST' });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('WWW-Authenticate');
  assert.ok(challenge, 'expected WWW-Authenticate header');
  assert.equal(challenge, 'Bearer realm="vicoop-bridge"');
});

test('bad token prefix responds with WWW-Authenticate error="invalid_token"', async () => {
  // siweDomain undefined so non-vbc_* bearers fall through to bad_token_prefix
  // instead of the SIWE branch.
  const { app, registry } = buildApp();
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res = await app.request('/agents/restricted', {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-known-prefix-xyz' },
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('WWW-Authenticate');
  assert.ok(challenge);
  assert.match(challenge, /^Bearer realm="vicoop-bridge"/);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description="expected vbc_caller_\* prefix"/);
});

test('owner-session token on caller route responds with WWW-Authenticate error="invalid_token"', async () => {
  const { app, registry } = buildApp();
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res = await app.request('/agents/restricted', {
    method: 'POST',
    headers: { Authorization: 'Bearer vbc_owner_deadbeef' },
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('WWW-Authenticate');
  assert.ok(challenge);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description="vbc_owner_\* tokens are not accepted on \/agents\/:id"/);
});

test('invalid SIWE bearer (siweDomain on) responds with WWW-Authenticate error="invalid_token" and stable description', async () => {
  const { app, registry } = buildApp({ siweDomain: 'bridge.example' });
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res = await app.request('/agents/restricted', {
    method: 'POST',
    // Anything that's not vbc_caller_*/vbc_owner_* goes through the SIWE
    // bearer fast-path when siweDomain is set; a junk value will fail verify.
    headers: { Authorization: 'Bearer not-a-real-siwe-bearer' },
  });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('WWW-Authenticate');
  assert.ok(challenge);
  assert.match(challenge, /^Bearer realm="vicoop-bridge"/);
  assert.match(challenge, /error="invalid_token"/);
  // Description is a stable public string, not the raw upstream err.message,
  // so detail (e.g. "SIWE bearer token is not valid JSON") can't leak via
  // proxy access logs.
  assert.match(challenge, /error_description="invalid SIWE bearer"/);

  // The JSON body must also not leak the underlying verifier err.message —
  // unauthenticated callers receive this directly. Detail stays in logEvent.
  const body = (await res.json()) as { error: { message: string } };
  assert.doesNotMatch(body.error.message, /not valid JSON/i);
  assert.doesNotMatch(body.error.message, /SIWE bearer token/i);
  assert.match(body.error.message, /^Invalid bearer token\./);
});

test('public agent (no allowedCallers) passes through without WWW-Authenticate', async () => {
  const { app, registry } = buildApp();
  registerAgent(registry, 'public', []);

  const res = await app.request('/agents/public', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('WWW-Authenticate'), null);
});

test('a presented federation token is still validated after its final policy tuple is removed', async () => {
  const sql = (async (strings: TemplateStringsArray) => {
    if (strings.join('?').includes('FROM infra.oauth_federation_access_tokens')) return [];
    throw new Error('unexpected SQL');
  }) as unknown as Sql;
  const { app, registry } = buildApp({ sql });
  registerAgent(registry, 'public-after-removal', [], [CALLER_CONTEXT_V2_CAPABILITY]);

  const response = await app.request('/agents/public-after-removal', {
    method: 'POST',
    headers: { Authorization: 'Bearer vbc_fed_revoked-token' },
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('WWW-Authenticate') ?? '', /invalid_token/);
});

test('unknown agent returns 404 without auth challenge', async () => {
  const { app } = buildApp();

  const res = await app.request('/agents/missing', { method: 'POST' });
  assert.equal(res.status, 404);
  // 404 is not an auth failure, so RFC 6750 challenge shouldn't be added.
  assert.equal(res.headers.get('WWW-Authenticate'), null);
});

// Issue #352 — a registered agent whose client is not connected is a
// transient condition (operator stopped it / mid-restart), signaled as 503 +
// Retry-After so downstream routers retry shortly instead of applying the
// long misconfiguration cooldown they reserve for bare 404s.
test('registered-but-offline agent returns 503 with Retry-After, not 404', async () => {
  const { app } = buildApp({ sql: fakeSql(['ghost']) });

  const res = await app.request('/agents/ghost', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '60');
  // Unavailability is not an auth failure either.
  assert.equal(res.headers.get('WWW-Authenticate'), null);
  const body = (await res.json()) as {
    error: { code: number; message: string; data?: { rejectionId?: string } };
  };
  assert.equal(body.error.code, -32000);
  assert.match(body.error.message, /temporarily unavailable/i);
});

test('registration lookup failure degrades to 503 (transient), not 404', async () => {
  // When the agents-table query itself fails, the bridge can't tell offline
  // from unknown — report transient so a bridge-side DB outage doesn't park
  // known-good agents in consumers' long misconfiguration cooldown.
  const failingSql = (async () => {
    throw new Error('connection refused');
  }) as unknown as Sql;
  const { app } = buildApp({ sql: failingSql });

  const res = await app.request('/agents/maybe-registered', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '60');
});

test('caller not in allowedCallers responds 403 with WWW-Authenticate error="insufficient_scope"', async () => {
  _resetSiweBearerCacheForTests();
  // The agent only allows a different principal — the bearer's address is
  // valid SIWE but not on the allow list, so the middleware must reach the
  // caller_not_authorized branch (403).
  const { app, registry } = buildApp({ siweDomain: 'bridge.example' });
  registerAgent(registry, 'restricted', [
    'eth:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  // Sanity: the minted bearer's address differs from the allowed principal.
  assert.notEqual(TEST_ADDRESS_LOWER, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  const bearer = await mintBearer({
    domain: 'bridge.example',
    uri: 'https://bridge.example',
  });
  const res = await app.request('/agents/restricted', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert.equal(res.status, 403);
  const challenge = res.headers.get('WWW-Authenticate');
  assert.ok(challenge);
  assert.match(challenge, /^Bearer realm="vicoop-bridge"/);
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /error_description="caller not in allowed list"/);
});

test('federated bearer restores platform principal, Connector actor, and normalized attestation', async () => {
  const sql = (async (strings: TemplateStringsArray) => {
    const statement = strings.join('?');
    if (statement.includes('FROM infra.oauth_federation_access_tokens')) {
      return [{
        id: 'token-row-1',
        agent_id: 'restricted',
        resource: 'https://bridge.example/agents/restricted',
        principal_id: 'slack:T123/U456',
        actor_id: 'did:web:connector.example',
        allowed_caller: 'federated:v1:test',
        attestation: {
          credentialId: 'urn:mentionable:oauth-assertion:test',
          issuer: 'did:web:connector.example',
          subject: 'slack:T123/U456',
          method: 'urn:mentionable:auth:slack-member:v0.1',
        },
        scopes: ['a2a:message.send'],
        task_id: null,
        expires_at: new Date(Date.now() + 60_000),
        revoked: false,
        policy_active: true,
      }];
    }
    if (statement.includes('UPDATE infra.oauth_federation_access_tokens')) return [];
    throw new Error(`unexpected SQL in test: ${statement}`);
  }) as unknown as Sql;
  const registry = new Registry();
  registerAgent(
    registry,
    'restricted',
    ['federated:v1:test'],
    [CALLER_CONTEXT_V2_CAPABILITY],
  );
  const app = new Hono();
  app.post('/agents/:id', agentAuthMiddleware(registry, {
    sql,
    deviceFlowEnabled: false,
  }), (c) => c.json(getCaller(c)!));

  const response = await app.request('/agents/restricted', {
    method: 'POST',
    headers: { Authorization: 'Bearer vbc_fed_test-token' },
  });
  assert.equal(response.status, 200);
  const caller = await response.json() as {
    principalId: string;
    actorId: string;
    federation: { attestations: Array<{ subject: string }> };
  };
  assert.equal(caller.principalId, 'slack:T123/U456');
  assert.equal(caller.actorId, 'did:web:connector.example');
  assert.equal(caller.federation.attestations[0]?.subject, 'slack:T123/U456');
});

// Direct unit tests for sanitizeErrorDescription. All call sites in the
// middleware now feed stable hand-authored strings, but the sanitize + cap
// remains as defense-in-depth — these tests pin that contract.
test('sanitizeErrorDescription drops chars outside the RFC 6749 §4.1.2.1 set', () => {
  // Strip `"` (0x22), `\` (0x5C), control chars, and anything > 0x7E.
  assert.equal(sanitizeErrorDescription('hello'), 'hello');
  assert.equal(sanitizeErrorDescription('with "quotes"'), 'with quotes');
  assert.equal(sanitizeErrorDescription('with\\backslash'), 'withbackslash');
  assert.equal(sanitizeErrorDescription('line\nbreak\ttab'), 'linebreaktab');
  assert.equal(sanitizeErrorDescription('non-ascii: ✓ 한글'), 'non-ascii:  ');
});

test('sanitizeErrorDescription caps output at 200 chars regardless of input length', () => {
  const long = 'a'.repeat(5000);
  const out = sanitizeErrorDescription(long);
  assert.equal(out.length, 200);
  assert.equal(out, 'a'.repeat(200));
});

// Rejection-id observability — issue #128 (B). Each reject branch stamps a
// short opaque id into both the structured log (asserted indirectly here via
// the body) and the JSON-RPC error body's `data.rejectionId`, so a caller
// transcript line can be grepped 1:1 against the bridge log.

const REJECTION_ID_RE = /^rej_[0-9a-f]{8}$/;

test('newRejectionId returns a short opaque rej_-prefixed id', () => {
  const id = newRejectionId();
  assert.match(id, REJECTION_ID_RE);
  // Two consecutive calls must not collide — 32 bits is enough that a flake
  // is vanishingly unlikely, and this catches obvious mistakes (constant id,
  // empty suffix) immediately.
  assert.notEqual(id, newRejectionId());
});

test('agent_not_connected (404) body carries rejectionId in error.data', async () => {
  const { app } = buildApp();

  const res = await app.request('/agents/missing', { method: 'POST' });
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    error: { code: number; data?: { rejectionId?: string } };
  };
  assert.equal(body.error.code, -32000);
  assert.match(body.error.data?.rejectionId ?? '', REJECTION_ID_RE);
});

test('agent_unavailable (503) body carries rejectionId in error.data', async () => {
  const { app } = buildApp({ sql: fakeSql(['ghost']) });

  const res = await app.request('/agents/ghost', { method: 'POST' });
  assert.equal(res.status, 503);
  const body = (await res.json()) as {
    error: { code: number; data?: { rejectionId?: string } };
  };
  assert.equal(body.error.code, -32000);
  assert.match(body.error.data?.rejectionId ?? '', REJECTION_ID_RE);
});

test('missing_bearer (401) body carries rejectionId in error.data', async () => {
  const { app, registry } = buildApp();
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res = await app.request('/agents/restricted', { method: 'POST' });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { data?: { rejectionId?: string } } };
  assert.match(body.error.data?.rejectionId ?? '', REJECTION_ID_RE);
});

test('bad_token_prefix (401) body carries rejectionId in error.data', async () => {
  const { app, registry } = buildApp();
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res = await app.request('/agents/restricted', {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-known-prefix-xyz' },
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { data?: { rejectionId?: string } } };
  assert.match(body.error.data?.rejectionId ?? '', REJECTION_ID_RE);
});

test('caller_not_authorized (403) body carries rejectionId in error.data', async () => {
  _resetSiweBearerCacheForTests();
  const { app, registry } = buildApp({ siweDomain: 'bridge.example' });
  registerAgent(registry, 'restricted', [
    'eth:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  const bearer = await mintBearer({
    domain: 'bridge.example',
    uri: 'https://bridge.example',
  });

  const res = await app.request('/agents/restricted', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: { data?: { rejectionId?: string } } };
  assert.match(body.error.data?.rejectionId ?? '', REJECTION_ID_RE);
});

test('each rejection gets its own id (no shared / cached id across requests)', async () => {
  // Two independent rejections in the same process must produce different
  // ids — guards against accidentally hoisting the id to module scope or
  // reusing a per-middleware-instance constant.
  const { app, registry } = buildApp();
  registerAgent(registry, 'restricted', ['eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

  const res1 = await app.request('/agents/restricted', { method: 'POST' });
  const res2 = await app.request('/agents/restricted', { method: 'POST' });
  const body1 = (await res1.json()) as { error: { data: { rejectionId: string } } };
  const body2 = (await res2.json()) as { error: { data: { rejectionId: string } } };
  assert.notEqual(body1.error.data.rejectionId, body2.error.data.rejectionId);
});
