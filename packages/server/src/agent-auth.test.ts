import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { SiweMessage } from 'siwe';
import { Wallet } from 'ethers';
import type { WebSocket } from 'ws';
import type { AgentCard } from '@vicoop-bridge/protocol';
import { agentAuthMiddleware, sanitizeErrorDescription } from './agent-auth.js';
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

// The reject paths exercised here never touch postgres — the middleware short-
// circuits on missing/malformed bearer headers before reaching verifyCallerToken
// (vbc_caller_* branch) or verifySiweBearerToken (SIWE branch). A stub Sql is
// sufficient.
const stubSql = {} as Sql;

function fakeAgentCard(name: string): AgentCard {
  return { name, version: '0.0.1', protocolVersion: '0.3.0' };
}

function registerAgent(
  registry: Registry,
  agentId: string,
  allowedCallers: string[],
): void {
  const conn: ClientConnection = {
    agentId,
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    agentCard: fakeAgentCard(agentId),
    allowedCallers,
    ws: { close() {} } as unknown as WebSocket,
    connectedAt: Date.now(),
  };
  registry.registerAgent(conn);
}

function buildApp(opts: { siweDomain?: string } = {}): { app: Hono; registry: Registry } {
  const registry = new Registry();
  const app = new Hono();
  const mw = agentAuthMiddleware(registry, {
    sql: stubSql,
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
});

test('public agent (no allowedCallers) passes through without WWW-Authenticate', async () => {
  const { app, registry } = buildApp();
  registerAgent(registry, 'public', []);

  const res = await app.request('/agents/public', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('WWW-Authenticate'), null);
});

test('unknown agent returns 404 without auth challenge', async () => {
  const { app } = buildApp();

  const res = await app.request('/agents/missing', { method: 'POST' });
  assert.equal(res.status, 404);
  // 404 is not an auth failure, so RFC 6750 challenge shouldn't be added.
  assert.equal(res.headers.get('WWW-Authenticate'), null);
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
