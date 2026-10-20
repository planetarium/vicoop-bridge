import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import { Registry, type ClientConnection } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';

const admin = 'eth:0x0000000000000000000000000000000000000525';
process.env.ADMIN_WALLET_ADDRESSES = admin.slice(4);
const { transferAgent, resolveTransferOwner, watchAgentOwners } = await import('./agent-transfer.js');
const { createHttpApp } = await import('./http.js');
const { listActiveAgents } = await import('./admin-api.js');

test('ownership transfer: identity, authorization, atomicity, concurrency and remote sessions', { skip: !process.env.DATABASE_URL }, async () => {
  const db = postgres(process.env.DATABASE_URL!);
  const suffix = crypto.randomUUID();
  const agentId = `transfer-${suffix}`;
  const old = `eth:0x${'1'.repeat(40)}`;
  const google = `google:${Date.now()}525`;
  const email = `${suffix}@example.com`;
  const registry = new Registry();
  const remote = new Registry();
  let stop: (() => Promise<void>) | undefined;
  const issued: string[] = [];
  try {
    const tokens = {} as Record<string, string>;
    for (const [principalId, provider, contact] of [[admin, 'siwe', undefined], [old, 'siwe', undefined], [google, 'google', email]] as const) {
      const token = await issueSessionToken(db, { principalId, provider, email: contact, audience: 'owner_session' });
      issued.push(token.callerId); tokens[principalId] = token.rawToken;
    }
    const [agent] = await db`INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
      VALUES (${agentId}, ${old}, 'transfer-test', ${suffix}, ARRAY['google:sub:42']) RETURNING *`;
    await db`INSERT INTO clients (id, owner_principal, client_name, token_hash, allowed_agent_ids)
      VALUES (${agent!.client_id}, ${old}, 'transfer-test', ${suffix}, ARRAY[${agentId}])`;
    await db`INSERT INTO agent_policies (agent_id, client_id, owner_principal, allowed_callers)
      VALUES (${agentId}, ${agent!.client_id}, ${old}, ARRAY['google:sub:42'])`;
    const conn: ClientConnection = { agentId, clientId: agent!.client_id, ownerPrincipal: old,
      agentCard: { name: 'transfer', version: '1', protocolVersion: '0.3.0' }, allowedCallers: ['google:sub:42'],
      ws: { close() { assert.fail('transfer must not close the daemon'); } } as unknown as WebSocket, connectedAt: Date.now() };
    remote.registerAgent(conn);
    stop = (await watchAgentOwners(db, remote)).stop;
    const app = createHttpApp({ db, registry: remote });
    const request = (actor: string, body: unknown) => app.request(`/admin-api/agents/${agentId}/transfer`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokens[actor]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await app.request(`/admin-api/agents/${agentId}/transfer`, { method: 'POST' })).status, 401);
    assert.equal((await request(old, { to: email, preview: true })).status, 403);
    assert.equal((await request(admin, { to: 'unknown@example.com', preview: true })).status, 404);
    assert.equal((await request(admin, { to: email })).status, 400);
    await assert.rejects(transferAgent(db, registry, admin, 'missing', { to: email, preview: true }), /not found/);
    assert.deepEqual(await resolveTransferOwner(db, `google:sub:${google.slice(7)}`), { principal: google, email });
    assert.deepEqual(await resolveTransferOwner(db, old), { principal: old, email: null });
    await assert.rejects(resolveTransferOwner(db, 'google:email:' + email), /Unsupported/);
    const ambiguous = await issueSessionToken(db, { principalId: 'google:999999999999525', provider: 'google', email, audience: 'caller' });
    issued.push(ambiguous.callerId);
    await assert.rejects(resolveTransferOwner(db, email), /Ambiguous/);
    await db`DELETE FROM callers WHERE id = ${ambiguous.callerId}`;
    await db`UPDATE agents SET x402_pricing = '{"scheme":"exact","network":"eip155:8453","amount":"100","asset":"test","payTo":"test"}'::jsonb WHERE id = ${agentId}`;
    const pricing = (await db`SELECT x402_pricing FROM agents WHERE id = ${agentId}`)[0]!.x402_pricing;
    remote.bindTask({ agentId, taskId: suffix, contextId: suffix, principalId: 'google:42',
      sink: { pushStatus() { assert.fail('transfer must not interrupt tasks'); }, pushArtifact() {}, finish() { assert.fail('transfer must not finish tasks'); } } });
    const previewResponse = await request(admin, { to: email, preview: true });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { expected_revision: string };
    const input = { to: email, expectedOwner: old, expectedRevision: preview.expected_revision };
    // Force a compatibility write failure and verify the authoritative update rolls back.
    await db`ALTER TABLE clients ADD CONSTRAINT transfer_test_guard CHECK (client_name <> 'transfer-test' OR owner_principal = 'eth:0x1111111111111111111111111111111111111111')`;
    await assert.rejects(transferAgent(db, registry, admin, agentId, input));
    assert.equal((await db`SELECT owner_principal FROM agents WHERE id = ${agentId}`)[0]!.owner_principal, old);
    await db`ALTER TABLE clients DROP CONSTRAINT transfer_test_guard`;
    const results = await Promise.allSettled([
      transferAgent(db, registry, admin, agentId, input), transferAgent(db, registry, admin, agentId, input),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.match(rejected.reason.message, /changed since preview/);
    for (let i = 0; i < 100 && conn.ownerPrincipal !== google; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(conn.ownerPrincipal, google);
    assert.equal(conn.ownerEmail, email);
    const [after] = await db`SELECT * FROM agents WHERE id = ${agentId}`;
    assert.equal(after!.token_hash, agent!.token_hash);
    assert.deepEqual(after!.allowed_callers, agent!.allowed_callers);
    assert.deepEqual(after!.x402_pricing, pricing);
    assert.equal(remote.getBinding(suffix)?.principalId, 'google:42');
    assert.equal((await db`SELECT owner_principal FROM clients WHERE id = ${agent!.client_id}`)[0]!.owner_principal, google);
    assert.equal((await db`SELECT owner_principal FROM agent_policies WHERE agent_id = ${agentId}`)[0]!.owner_principal, google);
    // Even a deliberately stale cache must never authorize the previous owner.
    conn.ownerPrincipal = old;
    assert.deepEqual(await listActiveAgents(db, remote, old), []);
    assert.equal((await listActiveAgents(db, remote, google)).length, 1);
    const usage = await app.request(`/admin-api/agents/${agentId}/usage`, { headers: { Authorization: `Bearer ${tokens[old]}` } });
    assert.equal(usage.status, 404);
    for (const [who, status] of [[old, 404], [google, 200]] as const) {
      assert.equal((await app.request(`/admin-api/agents/${agentId}/callers`, { headers: { Authorization: `Bearer ${tokens[who]}` } })).status, status);
    }
    // Polling repairs a missed notification / stale hello snapshot as well.
    for (let i = 0; i < 120 && conn.ownerPrincipal !== google; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(conn.ownerPrincipal, google);
    const same = await transferAgent(db, registry, admin, agentId, { to: google, expectedOwner: google, expectedRevision: '1' });
    assert.equal(same.outcome, 'unchanged');
    // ABA still invalidates the original preview.
    await db`UPDATE agents SET owner_principal = ${old} WHERE id = ${agentId}`;
    await assert.rejects(transferAgent(db, registry, admin, agentId, input), /changed since preview/);
  } finally {
    await stop?.();
    await db`ALTER TABLE clients DROP CONSTRAINT IF EXISTS transfer_test_guard`;
    await db`DELETE FROM agent_policies WHERE agent_id = ${agentId}`;
    await db`DELETE FROM clients WHERE ${agentId} = ANY(allowed_agent_ids)`;
    await db`DELETE FROM agents WHERE id = ${agentId}`;
    await db`DELETE FROM callers WHERE id = ANY(${issued})`;
    await db.end();
  }
});
