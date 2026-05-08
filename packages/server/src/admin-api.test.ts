// Integration tests for the deterministic /admin-api/* HTTP routes.
// Mounts the real createHttpApp against a real Postgres so RLS, the shared
// admin-api functions, and the route plumbing are all exercised together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import type { AgentCard } from '@vicoop-bridge/protocol';
import { createHttpApp } from './http.js';
import { Registry, type ClientConnection } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';

const hasDb = !!process.env.DATABASE_URL;

function fakeAgentCard(name: string): AgentCard {
  return {
    name,
    version: '0.0.1',
    protocolVersion: '0.3.0',
  };
}

function fakeConnection(opts: {
  agentId: string;
  clientId: string;
  ownerPrincipal: string;
  allowedCallers?: string[];
}): ClientConnection {
  return {
    agentId: opts.agentId,
    clientId: opts.clientId,
    ownerPrincipal: opts.ownerPrincipal,
    agentCard: fakeAgentCard(opts.agentId),
    allowedCallers: opts.allowedCallers ?? [],
    // No real WebSocket — none of the routes under test touch it.
    ws: { close() {} } as unknown as WebSocket,
    connectedAt: Date.now(),
  };
}

interface SetupResult {
  ownerPrincipal: string;
  ownerToken: string;
  clientId: string;
  agentId: string;
}

async function setupOwner(
  sql: postgres.Sql,
  ownerPrincipal: string,
): Promise<SetupResult> {
  const agentId = `admin-api-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clients = await sql<{ id: string }[]>`
    INSERT INTO clients (owner_principal, client_name, token_hash, allowed_agent_ids)
    VALUES (
      ${ownerPrincipal},
      'admin-api-test',
      ${`fake-hash-${agentId}`},
      ARRAY[${agentId}]
    )
    RETURNING id
  `;
  const clientId = clients[0]!.id;
  await sql`
    INSERT INTO agent_policies (agent_id, owner_principal, client_id)
    VALUES (${agentId}, ${ownerPrincipal}, ${clientId})
  `;
  const issued = await issueSessionToken(sql, {
    principalId: ownerPrincipal,
    provider: 'siwe',
    audience: 'owner_session',
  });
  return { ownerPrincipal, ownerToken: issued.rawToken, clientId, agentId };
}

async function teardown(sql: postgres.Sql, principalId: string, clientId: string): Promise<void> {
  // agent_policies cascades on clients.id, callers wiped by principal_id.
  await sql`DELETE FROM clients WHERE id = ${clientId}`;
  await sql`DELETE FROM callers WHERE principal_id = ${principalId}`;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

test(
  'GET /admin-api/agents requires owner-session bearer',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      const noAuth = await app.request('/admin-api/agents');
      assert.equal(noAuth.status, 401);
      const noAuthBody = (await noAuth.json()) as { error: string };
      assert.match(noAuthBody.error, /Authentication required/);

      // Caller-audience tokens are not accepted here.
      const callerIssued = await issueSessionToken(sql, {
        principalId: 'eth:0x1111111111111111111111111111111111111111',
        provider: 'siwe',
        audience: 'caller',
      });
      try {
        const wrongAud = await app.request('/admin-api/agents', {
          headers: authHeaders(callerIssued.rawToken),
        });
        assert.equal(wrongAud.status, 401);
      } finally {
        await sql`DELETE FROM callers WHERE id = ${callerIssued.callerId}`;
      }
    } finally {
      await sql.end();
    }
  },
);

test(
  'GET /admin-api/agents returns the operator’s own agents only',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerA = `eth:0x${'a'.repeat(40)}`;
    const ownerB = `eth:0x${'b'.repeat(40)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, ownerA);
      setupB = await setupOwner(sql, ownerB);

      const registry = new Registry();
      registry.registerAgent(fakeConnection({
        agentId: setupA.agentId,
        clientId: setupA.clientId,
        ownerPrincipal: ownerA,
      }));
      registry.registerAgent(fakeConnection({
        agentId: setupB.agentId,
        clientId: setupB.clientId,
        ownerPrincipal: ownerB,
      }));

      const app = createHttpApp({ db: sql, registry });
      const res = await app.request('/admin-api/agents', {
        headers: authHeaders(setupA.ownerToken),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agents: { agent_id: string; client_id: string }[] };
      const agentIds = body.agents.map((a) => a.agent_id);
      assert.ok(agentIds.includes(setupA.agentId), 'should see own agent');
      assert.ok(!agentIds.includes(setupB.agentId), 'should not see other owner’s agent');
    } finally {
      if (setupA) await teardown(sql, ownerA, setupA.clientId);
      if (setupB) await teardown(sql, ownerB, setupB.clientId);
      await sql.end();
    }
  },
);

test(
  'POST /admin-api/agents/:id/callers adds a principal and hot-reloads registry',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'c'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      registry.registerAgent(fakeConnection({
        agentId: setup.agentId,
        clientId: setup.clientId,
        ownerPrincipal: owner,
      }));

      const callerSeen: { agentId: string; callers: string[] }[] = [];
      registry.onCallerChange((agentId, callers) => {
        callerSeen.push({ agentId, callers: [...callers] });
      });

      const app = createHttpApp({ db: sql, registry });
      const target = `eth:0x${'d'.repeat(40)}`;
      const res = await app.request(`/admin-api/agents/${setup.agentId}/callers`, {
        method: 'POST',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({ principal: target }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { allowed_callers: string[]; principal: string };
      assert.deepEqual(body.allowed_callers, [target]);
      assert.equal(body.principal, target);

      // Idempotency: adding the same principal again returns 200 with a message
      // and a non-duplicated list.
      const repeat = await app.request(`/admin-api/agents/${setup.agentId}/callers`, {
        method: 'POST',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({ principal: target }),
      });
      assert.equal(repeat.status, 200);
      const repeatBody = (await repeat.json()) as { allowed_callers: string[]; message?: string };
      assert.deepEqual(repeatBody.allowed_callers, [target]);
      assert.match(repeatBody.message ?? '', /already/i);

      // Hot-reload notification fired (at least the first add).
      assert.ok(
        callerSeen.some((e) => e.agentId === setup!.agentId && e.callers.includes(target)),
        'registry caller-change listener should have been notified',
      );

      // GET reflects the new state.
      const list = await app.request(`/admin-api/agents/${setup.agentId}/callers`, {
        headers: authHeaders(setup.ownerToken),
      });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { allowed_callers: string[]; is_public: boolean };
      assert.deepEqual(listBody.allowed_callers, [target]);
      assert.equal(listBody.is_public, false);

      // DELETE removes it.
      const del = await app.request(
        `/admin-api/agents/${setup.agentId}/callers?principal=${encodeURIComponent(target)}`,
        { method: 'DELETE', headers: authHeaders(setup.ownerToken) },
      );
      assert.equal(del.status, 200);
      const delBody = (await del.json()) as { allowed_callers: string[] };
      assert.deepEqual(delBody.allowed_callers, []);

      // Removing again is idempotent.
      const delAgain = await app.request(
        `/admin-api/agents/${setup.agentId}/callers?principal=${encodeURIComponent(target)}`,
        { method: 'DELETE', headers: authHeaders(setup.ownerToken) },
      );
      assert.equal(delAgain.status, 200);
      const delAgainBody = (await delAgain.json()) as { message?: string };
      assert.match(delAgainBody.message ?? '', /not in/i);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'POST /admin-api/agents/:id/callers rejects invalid principals with 400',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'e'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(`/admin-api/agents/${setup.agentId}/callers`, {
        method: 'POST',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({ principal: 'not-a-valid-principal' }),
      });
      assert.equal(res.status, 400);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'GET /admin-api/agents/:id/callers returns 404 for another owner’s agent (RLS)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerA = `eth:0x${'1'.repeat(40)}`;
    const ownerB = `eth:0x${'2'.repeat(40)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, ownerA);
      setupB = await setupOwner(sql, ownerB);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      // ownerA tries to inspect ownerB's agent — RLS hides it as non-existent.
      const res = await app.request(`/admin-api/agents/${setupB.agentId}/callers`, {
        headers: authHeaders(setupA.ownerToken),
      });
      assert.equal(res.status, 404);
    } finally {
      if (setupA) await teardown(sql, ownerA, setupA.clientId);
      if (setupB) await teardown(sql, ownerB, setupB.clientId);
      await sql.end();
    }
  },
);
