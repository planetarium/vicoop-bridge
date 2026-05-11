import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { WebSocket } from 'ws';
import type { AgentCard } from '@vicoop-bridge/protocol';
import { agentAuthMiddleware } from './agent-auth.js';
import { Registry, type ClientConnection } from './registry.js';
import type { Sql } from './db.js';

// The reject paths exercised here never touch postgres — the middleware short-
// circuits on missing/malformed bearer headers before reaching verifyCallerToken
// or verifySessionToken. A stub Sql is sufficient.
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

test('invalid SIWE bearer (siweDomain on) responds with WWW-Authenticate error="invalid_token"', async () => {
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
