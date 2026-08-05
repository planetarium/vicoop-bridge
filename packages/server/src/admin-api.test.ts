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
import { issueSessionToken, verifyCallerToken, CALLER_TOKEN_PREFIX } from './auth/caller-token.js';
import { matchPrincipal } from './auth/principal.js';

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
  const agents = await sql<{ client_id: string }[]>`
    INSERT INTO agents (id, owner_principal, name, token_hash)
    VALUES (
      ${agentId},
      ${ownerPrincipal},
      'admin-api-test',
      ${`fake-hash-${agentId}`}
    )
    RETURNING client_id
  `;
  const clientId = agents[0]!.client_id;
  await sql`
    INSERT INTO clients (id, owner_principal, client_name, token_hash, allowed_agent_ids)
    VALUES (${clientId}, ${ownerPrincipal}, 'admin-api-test', ${`fake-client-hash-${agentId}`}, ARRAY[${agentId}])
    ON CONFLICT (id) DO NOTHING
  `;
  const issued = await issueSessionToken(sql, {
    principalId: ownerPrincipal,
    provider: 'siwe',
    audience: 'owner_session',
  });
  return { ownerPrincipal, ownerToken: issued.rawToken, clientId, agentId };
}

async function teardown(sql: postgres.Sql, principalId: string, clientId: string): Promise<void> {
  await sql`DELETE FROM agents WHERE client_id = ${clientId}`;
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
  'POST /admin-api/agents/:id/callers updates a registered agent without a live connection',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'e'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);

      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const target = `eth:0x${'f'.repeat(40)}`;
      const res = await app.request(`/admin-api/agents/${setup.agentId}/callers`, {
        method: 'POST',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({ principal: target }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as { allowed_callers: string[]; principal: string };
      assert.deepEqual(body.allowed_callers, [target]);
      assert.equal(body.principal, target);

      const rows = await sql<{ owner_principal: string; client_id: string; allowed_callers: string[] }[]>`
        SELECT owner_principal, client_id, allowed_callers
        FROM agents
        WHERE id = ${setup.agentId}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.owner_principal, owner);
      assert.equal(rows[0]!.client_id, setup.clientId);
      assert.deepEqual(rows[0]!.allowed_callers, [target]);
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

// ── /admin-api/clients (issue #166) ──────────────────────────────

test(
  'GET /admin-api/clients returns only the operator’s own clients with connected flag',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerA = `eth:0x${'3'.repeat(40)}`;
    const ownerB = `eth:0x${'4'.repeat(40)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, ownerA);
      setupB = await setupOwner(sql, ownerB);

      const registry = new Registry();
      // Only setupA is "connected" — setupB has a clients row but no live WS.
      registry.registerAgent(fakeConnection({
        agentId: setupA.agentId,
        clientId: setupA.clientId,
        ownerPrincipal: ownerA,
      }));

      const app = createHttpApp({ db: sql, registry });
      const res = await app.request('/admin-api/clients', {
        headers: authHeaders(setupA.ownerToken),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        clients: Array<{ client_id: string; connected: boolean }>;
      };
      const setupAClientId = setupA.clientId;
      const ids = body.clients.map((c) => c.client_id);
      assert.ok(ids.includes(setupAClientId), 'should see own client');
      assert.ok(!ids.includes(setupB.clientId), 'should not see other owner’s client');
      const a = body.clients.find((c) => c.client_id === setupAClientId)!;
      assert.equal(a.connected, true);
    } finally {
      if (setupA) await teardown(sql, ownerA, setupA.clientId);
      if (setupB) await teardown(sql, ownerB, setupB.clientId);
      await sql.end();
    }
  },
);

test(
  'GET /admin-api/clients shows persisted orphans (clients with no live WS) as connected:false',
  { skip: !hasDb },
  async () => {
    // Repros the issue's concrete trigger: two test clients were registered,
    // their daemons exited, and `list-agents` showed them as gone — but the
    // `clients` rows persisted. /admin-api/clients must surface those rows
    // with connected=false so the operator can spot them.
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'5'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry(); // no agents registered → all clients orphaned
      const app = createHttpApp({ db: sql, registry });
      const res = await app.request('/admin-api/clients', {
        headers: authHeaders(setup.ownerToken),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { clients: Array<{ client_id: string; connected: boolean }> };
      const row = body.clients.find((c) => c.client_id === setup!.clientId);
      assert.ok(row, 'orphan client should be listed');
      assert.equal(row.connected, false);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'DELETE /admin-api/clients/:target hard-deletes the row and closes the live WS with 4014',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'6'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);

      // Recording WS so we can assert the close code propagated.
      const closeArgs: Array<{ code: number; reason: string }> = [];
      const ws = {
        close(code: number, reason: string) {
          closeArgs.push({ code, reason });
        },
      } as unknown as WebSocket;

      const registry = new Registry();
      registry.registerAgent({
        ...fakeConnection({
          agentId: setup.agentId,
          clientId: setup.clientId,
          ownerPrincipal: owner,
        }),
        ws,
      });

      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(
        `/admin-api/clients/${encodeURIComponent(setup.clientId)}`,
        { method: 'DELETE', headers: authHeaders(setup.ownerToken) },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        client_id: string;
        deleted: boolean;
        closed_connections: number;
      };
      assert.equal(body.client_id, setup.clientId);
      assert.equal(body.deleted, true);
      assert.equal(body.closed_connections, 1);
      assert.deepEqual(closeArgs, [{ code: 4014, reason: 'client deleted' }]);

      // DB rows are gone.
      const clientsRows = await sql<{ id: string }[]>`
        SELECT id FROM clients WHERE id = ${setup.clientId}
      `;
      assert.equal(clientsRows.length, 0);
      const agentsRows = await sql<{ id: string }[]>`
        SELECT id FROM agents WHERE client_id = ${setup.clientId}
      `;
      assert.equal(agentsRows.length, 0);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'DELETE /admin-api/clients/:name resolves a unique client_name',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'7'.repeat(40)}`;
    const uniqueName = `delete-test-name-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      // Rename the just-created row so we can target it by name.
      await sql`UPDATE agents SET name = ${uniqueName} WHERE client_id = ${setup.clientId}`;

      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(
        `/admin-api/clients/${encodeURIComponent(uniqueName)}`,
        { method: 'DELETE', headers: authHeaders(setup.ownerToken) },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { client_id: string; client_name: string };
      assert.equal(body.client_id, setup.clientId);
      assert.equal(body.client_name, uniqueName);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'DELETE /admin-api/clients/:name returns 409 when the name is ambiguous',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'8'.repeat(40)}`;
    const dupName = `ambiguous-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, owner);
      setupB = await setupOwner(sql, owner);
      // Both rows are owned by the same principal and share the same name.
      await sql`UPDATE agents SET name = ${dupName} WHERE client_id IN (${setupA.clientId}, ${setupB.clientId})`;

      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(
        `/admin-api/clients/${encodeURIComponent(dupName)}`,
        { method: 'DELETE', headers: authHeaders(setupA.ownerToken) },
      );
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /Ambiguous client name/);
      assert.match(body.error, /Specify client_id/);

      // Neither client should be deleted — the ambiguous lookup must abort
      // before any state change.
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM clients WHERE id IN (${setupA.clientId}, ${setupB.clientId})
      `;
      assert.equal(rows.length, 2);
    } finally {
      if (setupA) await teardown(sql, owner, setupA.clientId);
      if (setupB) await teardown(sql, owner, setupB.clientId);
      await sql.end();
    }
  },
);

test(
  'DELETE /admin-api/clients/:target returns 404 when nothing matches',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'9'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(
        '/admin-api/clients/no-such-id-or-name',
        { method: 'DELETE', headers: authHeaders(setup.ownerToken) },
      );
      assert.equal(res.status, 404);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'DELETE /admin-api/clients/:id returns 404 for another owner’s client (RLS)',
  { skip: !hasDb },
  async () => {
    // RLS hides B's row from A's principal, so resolveClient yields no match
    // and we surface 404 — same shape as "no such client" so we don't leak
    // existence of rows owned by a different principal.
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerA = `eth:0x${'a'.repeat(40)}`;
    const ownerB = `eth:0x${'b'.repeat(40)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, ownerA);
      setupB = await setupOwner(sql, ownerB);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(
        `/admin-api/clients/${encodeURIComponent(setupB.clientId)}`,
        { method: 'DELETE', headers: authHeaders(setupA.ownerToken) },
      );
      assert.equal(res.status, 404);

      // ownerB's row remains intact (not deleted by A's request).
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM clients WHERE id = ${setupB.clientId}
      `;
      assert.equal(rows.length, 1);
    } finally {
      if (setupA) await teardown(sql, ownerA, setupA.clientId);
      if (setupB) await teardown(sql, ownerB, setupB.clientId);
      await sql.end();
    }
  },
);

test(
  '/admin-api/clients endpoints reject missing owner-session bearer',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      const list = await app.request('/admin-api/clients');
      assert.equal(list.status, 401);
      const del = await app.request('/admin-api/clients/anything', { method: 'DELETE' });
      assert.equal(del.status, 401);
    } finally {
      await sql.end();
    }
  },
);

// ----- Static API keys (issue #308) -----------------------------------------

// apikey callers rows carry principal_id='apikey:<id>', not the owner
// principal, so the standard teardown() (which deletes by owner principal)
// misses them. Clean them up explicitly off the agent's allowed_callers.
async function teardownApiKeys(sql: postgres.Sql, agentId: string): Promise<void> {
  const rows = await sql<{ allowed_callers: string[] }[]>`
    SELECT allowed_callers FROM agents WHERE id = ${agentId}
  `;
  const principals = (rows[0]?.allowed_callers ?? []).filter((p) => p.startsWith('apikey:'));
  if (principals.length > 0) {
    await sql`DELETE FROM callers WHERE principal_id = ANY(${sql.array(principals)})`;
  }
}

test(
  'POST /admin-api/agents/:id/apikeys mints a usable key and authorizes it',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'a1'.repeat(20)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      registry.registerAgent(fakeConnection({
        agentId: setup.agentId,
        clientId: setup.clientId,
        ownerPrincipal: owner,
      }));
      const callerSeen: string[][] = [];
      registry.onCallerChange((_agentId, callers) => callerSeen.push([...callers]));

      const app = createHttpApp({ db: sql, registry });
      const res = await app.request(`/admin-api/agents/${setup.agentId}/apikeys`, {
        method: 'POST',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'ci-deploy' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        agent_id: string;
        key_id: string;
        principal: string;
        api_key: string;
        label: string | null;
        expires_at: string;
        allowed_callers: string[];
      };
      assert.equal(body.principal, `apikey:${body.key_id}`);
      assert.ok(body.api_key.startsWith(CALLER_TOKEN_PREFIX), 'raw key is a vbc_caller_* token');
      assert.equal(body.label, 'ci-deploy');
      assert.deepEqual(body.allowed_callers, [body.principal]);

      // The principal was hot-reloaded into the registry.
      assert.ok(
        callerSeen.some((c) => c.includes(body.principal)),
        'caller-change listener fired with the apikey principal',
      );

      // End-to-end: the raw token verifies to the apikey principal, and that
      // principal satisfies the agent's allowed_callers entry.
      const verified = await verifyCallerToken(sql, body.api_key);
      assert.equal(verified.principalId, body.principal);
      assert.equal(matchPrincipal(body.allowed_callers[0]!, verified), true);

      // Default TTL is ~365 days out.
      const days = (new Date(body.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      assert.ok(days > 360 && days < 366, `expected ~365d TTL, got ${days}d`);
    } finally {
      if (setup) {
        await teardownApiKeys(sql, setup.agentId);
        await teardown(sql, owner, setup.clientId);
      }
      await sql.end();
    }
  },
);

test(
  'unified surface: GET callers lists an apikey, DELETE callers revokes its token',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'b2'.repeat(20)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      // Mint with an explicit short TTL.
      const mint = await app.request(`/admin-api/agents/${setup.agentId}/apikeys`, {
        method: 'POST',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({ ttlDays: 1 }),
      });
      assert.equal(mint.status, 200);
      const minted = (await mint.json()) as { key_id: string; principal: string; api_key: string; expires_at: string };
      const ttlDays = (new Date(minted.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      assert.ok(ttlDays > 0.9 && ttlDays < 1.1, `expected ~1d TTL, got ${ttlDays}d`);

      // The unified caller list shows the apikey principal (no secret).
      const list = await app.request(`/admin-api/agents/${setup.agentId}/callers`, {
        headers: authHeaders(setup.ownerToken),
      });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { allowed_callers: string[] };
      assert.deepEqual(listBody.allowed_callers, [minted.principal]);

      // DELETE on the caller surface removes the principal AND revokes the
      // underlying token (the apikey-specific branch in removeCaller).
      const del = await app.request(
        `/admin-api/agents/${setup.agentId}/callers?principal=${encodeURIComponent(minted.principal)}`,
        { method: 'DELETE', headers: authHeaders(setup.ownerToken) },
      );
      assert.equal(del.status, 200);
      const delBody = (await del.json()) as { allowed_callers: string[] };
      assert.deepEqual(delBody.allowed_callers, []);

      // Token no longer verifies (revoked) — not merely de-authorized.
      await assert.rejects(() => verifyCallerToken(sql, minted.api_key), /revoked/i);

      // And the DB row is flipped.
      const rows = await sql<{ revoked: boolean }[]>`
        SELECT revoked FROM callers WHERE provider = 'apikey' AND principal_id = ${minted.principal}
      `;
      assert.equal(rows[0]?.revoked, true);
    } finally {
      if (setup) {
        await teardownApiKeys(sql, setup.agentId);
        await teardown(sql, owner, setup.clientId);
      }
      await sql.end();
    }
  },
);

test(
  'POST /admin-api/agents/:id/apikeys rejects an out-of-range ttlDays with 400',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'c3'.repeat(20)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });
      for (const ttlDays of [0, -5, 10000]) {
        const res = await app.request(`/admin-api/agents/${setup.agentId}/apikeys`, {
          method: 'POST',
          headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
          body: JSON.stringify({ ttlDays }),
        });
        assert.equal(res.status, 400, `ttlDays=${ttlDays} should be rejected`);
      }
      // No keys should have been minted.
      const rows = await sql<{ allowed_callers: string[] }[]>`
        SELECT allowed_callers FROM agents WHERE id = ${setup.agentId}
      `;
      assert.deepEqual(rows[0]!.allowed_callers, []);
    } finally {
      if (setup) {
        await teardownApiKeys(sql, setup.agentId);
        await teardown(sql, owner, setup.clientId);
      }
      await sql.end();
    }
  },
);

test(
  'apikey endpoints return 404 for another owner’s agent (RLS)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerA = `eth:0x${'d4'.repeat(20)}`;
    const ownerB = `eth:0x${'e5'.repeat(20)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, ownerA);
      setupB = await setupOwner(sql, ownerB);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      // ownerB tries to mint a key on ownerA's agent → 404 (RLS hides it).
      const mint = await app.request(`/admin-api/agents/${setupA.agentId}/apikeys`, {
        method: 'POST',
        headers: { ...authHeaders(setupB.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(mint.status, 404);

      // ownerA's agent still has no callers — nothing leaked through.
      const rows = await sql<{ allowed_callers: string[] }[]>`
        SELECT allowed_callers FROM agents WHERE id = ${setupA.agentId}
      `;
      assert.deepEqual(rows[0]!.allowed_callers, []);
    } finally {
      if (setupA) {
        await teardownApiKeys(sql, setupA.agentId);
        await teardown(sql, ownerA, setupA.clientId);
      }
      if (setupB) {
        await teardownApiKeys(sql, setupB.agentId);
        await teardown(sql, ownerB, setupB.clientId);
      }
      await sql.end();
    }
  },
);

// ---- x402 pricing ----------------------------------------------------------

const EXACT_PRICING = {
  network: 'eip155:84532',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x1111111111111111111111111111111111111111',
};

test(
  'PUT /admin-api/agents/:id/x402 stores pricing and GET reads it back',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'c'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      // A brand-new agent is free.
      const before = await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        headers: authHeaders(setup.ownerToken),
      });
      assert.equal(before.status, 200);
      assert.equal(((await before.json()) as { x402_pricing: unknown }).x402_pricing, null);

      const put = await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        method: 'PUT',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify(EXACT_PRICING),
      });
      assert.equal(put.status, 200);
      // The stored value is the parsed one, so the scheme discriminator is
      // filled in even though the operator omitted it.
      assert.deepEqual(((await put.json()) as { x402_pricing: unknown }).x402_pricing, {
        ...EXACT_PRICING,
        scheme: 'exact',
      });

      const after = await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        headers: authHeaders(setup.ownerToken),
      });
      assert.deepEqual(((await after.json()) as { x402_pricing: unknown }).x402_pricing, {
        ...EXACT_PRICING,
        scheme: 'exact',
      });
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'PUT /admin-api/agents/:id/x402 rejects malformed pricing before it reaches the DB',
  { skip: !hasDb },
  async () => {
    // The whole point of routing pricing through the admin API is that a bad
    // payTo or a dollars-instead-of-atomic amount fails here, loudly, rather
    // than silently disabling payments at the agent's next connect.
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'d'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      for (const bad of [
        { ...EXACT_PRICING, payTo: '0xnope' },
        { ...EXACT_PRICING, amount: '0.01' },
        { ...EXACT_PRICING, amount: 10000 },
        { ...EXACT_PRICING, scheme: 'upto' }, // upto needs rates + facilitator
        // A typo'd optional field must fail rather than be dropped: every
        // optional field here changes what is charged, so silently ignoring
        // one is a silently-wrong price.
        { ...EXACT_PRICING, amout: '10000' },
      ]) {
        const res = await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
          method: 'PUT',
          headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
          body: JSON.stringify(bad),
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      }

      const rows = await sql<{ x402_pricing: unknown }[]>`
        SELECT x402_pricing FROM agents WHERE id = ${setup.agentId}
      `;
      assert.equal(rows[0]!.x402_pricing, null, 'no rejected value should have been persisted');
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'a typo in a metered pricing field is rejected by name, not silently dropped',
  { skip: !hasDb },
  async () => {
    // `minamount` would leave the floor unset, which makes every call the
    // backend cannot meter free. The operator is present at write time, so
    // this is the one chance to tell them.
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'3'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      const res = await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        method: 'PUT',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify({
          scheme: 'upto',
          network: 'eip155:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x1111111111111111111111111111111111111111',
          facilitatorAddress: '0x3333333333333333333333333333333333333333',
          maxAmount: '1000000',
          minamount: '1000',
          rates: { input: '3000000', output: '15000000' },
        }),
      });

      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /minamount/, 'the message must name the offending key');
      assert.equal(body.error.includes('\n'), false, 'must stay one line for the CLI');
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'x402 pricing routes require an owner session and are scoped by RLS',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const ownerA = `eth:0x${'e'.repeat(40)}`;
    const ownerB = `eth:0x${'f'.repeat(40)}`;
    let setupA: SetupResult | null = null;
    let setupB: SetupResult | null = null;
    try {
      setupA = await setupOwner(sql, ownerA);
      setupB = await setupOwner(sql, ownerB);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      const noAuth = await app.request(`/admin-api/agents/${setupA.agentId}/x402`);
      assert.equal(noAuth.status, 401);

      // B must not be able to reprice — or even confirm the existence of — A's
      // agent. Both surface as 404 rather than 403 for that reason.
      const cross = await app.request(`/admin-api/agents/${setupA.agentId}/x402`, {
        method: 'PUT',
        headers: { ...authHeaders(setupB.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify(EXACT_PRICING),
      });
      assert.equal(cross.status, 404);

      const rows = await sql<{ x402_pricing: unknown }[]>`
        SELECT x402_pricing FROM agents WHERE id = ${setupA.agentId}
      `;
      assert.equal(rows[0]!.x402_pricing, null, "another owner must not have repriced A's agent");
    } finally {
      if (setupA) await teardown(sql, ownerA, setupA.clientId);
      if (setupB) await teardown(sql, ownerB, setupB.clientId);
      await sql.end();
    }
  },
);

test(
  'DELETE /admin-api/agents/:id/x402 makes the agent free again',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'1'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const app = createHttpApp({ db: sql, registry });

      await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        method: 'PUT',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify(EXACT_PRICING),
      });

      const del = await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        method: 'DELETE',
        headers: authHeaders(setup.ownerToken),
      });
      assert.equal(del.status, 200);
      assert.equal(((await del.json()) as { x402_pricing: unknown }).x402_pricing, null);

      const rows = await sql<{ x402_pricing: unknown }[]>`
        SELECT x402_pricing FROM agents WHERE id = ${setup.agentId}
      `;
      assert.equal(rows[0]!.x402_pricing, null);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);

test(
  'repricing a connected agent takes effect without a reconnect',
  { skip: !hasDb },
  async () => {
    // The executor reads pricing off the live connection every turn, and the
    // AgentCard advertises it — so a write must both patch the connection and
    // evict the cached card.
    const sql = postgres(process.env.DATABASE_URL!);
    const owner = `eth:0x${'2'.repeat(40)}`;
    let setup: SetupResult | null = null;
    try {
      setup = await setupOwner(sql, owner);
      const registry = new Registry();
      const conn = fakeConnection({
        agentId: setup.agentId,
        clientId: setup.clientId,
        ownerPrincipal: owner,
      });
      registry.registerAgent(conn);
      let cardEvictions = 0;
      registry.onAgentChange(() => {
        cardEvictions += 1;
      });
      const app = createHttpApp({ db: sql, registry });

      assert.equal(registry.getAgent(setup.agentId)?.x402Pricing, undefined);

      await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        method: 'PUT',
        headers: { ...authHeaders(setup.ownerToken), 'content-type': 'application/json' },
        body: JSON.stringify(EXACT_PRICING),
      });
      assert.equal(registry.getAgent(setup.agentId)?.x402Pricing?.scheme, 'exact');
      assert.equal(cardEvictions, 1, 'the cached AgentCard must be evicted so it re-advertises');

      await app.request(`/admin-api/agents/${setup.agentId}/x402`, {
        method: 'DELETE',
        headers: authHeaders(setup.ownerToken),
      });
      assert.equal(registry.getAgent(setup.agentId)?.x402Pricing, undefined);
      assert.equal(cardEvictions, 2);
    } finally {
      if (setup) await teardown(sql, owner, setup.clientId);
      await sql.end();
    }
  },
);
