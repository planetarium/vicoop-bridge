// Integration tests for requester tool approvals: the federated requester's
// GET/POST /agents/:id/approvals/:requestId route and the owner-controlled
// /admin-api/agents/:id/requester-approval-policy opt-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import { REMOTE_APPROVAL_CAPABILITY, TASK_REPLAY_CAPABILITY, CALLER_CONTEXT_V2_CAPABILITY,
  type DownFrame, type TaskAssignFrame } from '@vicoop-bridge/protocol';
import { createHttpApp } from './http.js';
import { ensureSchema } from './db.js';
import { Registry, type TaskBinding } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';
import { formatFederatedPrincipal } from './auth/principal.js';
import { issueTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import {
  MENTIONABLE_OAUTH_PROFILE_ID,
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_TASK_READ,
} from './oauth/profiles/mentionable-v0.1.js';

const hasDb = !!process.env.DATABASE_URL;
const SECRET = `secret-arg-${randomUUID()}`;
const METHOD = 'urn:mentionable:auth:slack-workspace-member:v0.1';

test('requester approvals: opt-in policy, exact origin binding, liveness, idempotency and privacy',
  { skip: !hasDb }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  await ensureSchema(sql);
  const owner = `eth:0x${randomUUID().replaceAll('-', '')}00000000`;
  const agentId = `requester-approval-${randomUUID()}`;
  const otherAgentId = `${agentId}-other`;
  const actor = 'did:web:connector.example';
  const tuple = { issuer: actor, method: METHOD, subject: 'slack:T123/U456' };
  const tuples = {
    origin: tuple,
    // Same workspace, different user; different workspace; different Connector.
    principal: { ...tuple, subject: 'slack:T123/U999' },
    workspace: { ...tuple, subject: 'slack:T999/U456' },
    actor: { ...tuple, issuer: 'did:web:other-connector.example' },
  };
  const keys = Object.fromEntries(Object.entries(tuples)
    .map(([k, v]) => [k, formatFederatedPrincipal(v)!])) as Record<keyof typeof tuples, string>;
  const sessions: string[] = [];
  const sent: DownFrame[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  const pending: Array<{ binding: TaskBinding; response: Promise<Response> }> = [];
  t.after(async () => {
    for (const { binding, response } of pending) {
      if (registry.getBinding(binding.taskId) === binding) finish(binding);
      await response;
    }
    console.log = originalLog;
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent IN (${agentId}, ${otherAgentId})`;
    await sql`DELETE FROM infra.oauth_token_exchange_access_tokens WHERE agent_id IN (${agentId}, ${otherAgentId})`;
    await sql`DELETE FROM agents WHERE id IN (${agentId}, ${otherAgentId})`;
    if (sessions.length) await sql`DELETE FROM callers WHERE id = ANY(${sessions})`;
    await sql.end();
  });

  for (const id of [agentId, otherAgentId]) {
    await sql`INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
      VALUES (${id}, ${owner}, 'requester-approval', ${`hash-${id}`}, ${Object.values(keys)})`;
  }
  const registry = new Registry();
  for (const id of [agentId, otherAgentId]) {
    assert.deepEqual(registry.registerAgent({ agentId: id, clientId: `${id}-client`, ownerPrincipal: owner,
      agentCard: { name: id, version: '1', protocolVersion: '0.3.0', capabilities: { streaming: true }, skills: [] },
      allowedCallers: Object.values(keys),
      protocolCapabilities: [TASK_REPLAY_CAPABILITY, CALLER_CONTEXT_V2_CAPABILITY, REMOTE_APPROVAL_CAPABILITY],
      connectedAt: Date.now(),
      ws: { readyState: 1, OPEN: 1, close() {}, send(raw: string) {
        sent.push(JSON.parse(raw) as DownFrame);
      } } as unknown as WebSocket,
    }), { ok: true });
  }
  const app = createHttpApp({ registry, db: sql, publicUrl: 'http://localhost' });

  async function token(which: keyof typeof tuples, opts: { scopes?: string[]; taskId?: string; agent?: string } = {}) {
    const v = tuples[which];
    const issued = await issueTokenExchangeAccessToken(sql, {
      profileId: MENTIONABLE_OAUTH_PROFILE_ID, agentId: opts.agent ?? agentId,
      resource: `http://localhost/agents/${opts.agent ?? agentId}`,
      principalId: v.subject, actorId: v.issuer, allowedCaller: keys[which],
      scopes: opts.scopes ?? [OAUTH_FEDERATION_SCOPE_MESSAGE_SEND, OAUTH_FEDERATION_SCOPE_TASK_READ],
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    return issued.rawToken;
  }
  async function session(principalId: string, audience: 'owner_session' | 'caller') {
    const issued = await issueSessionToken(sql, { principalId, provider: 'siwe', audience });
    sessions.push(issued.callerId);
    return issued.rawToken;
  }
  const bearer = (raw?: string): Record<string, string> => raw ? { Authorization: `Bearer ${raw}` } : {};
  const url = (requestId: string, agent = agentId) => `/agents/${encodeURIComponent(agent)}/approvals/${requestId}`;
  const get = (requestId: string, raw?: string, agent = agentId) => app.request(url(requestId, agent), { headers: bearer(raw) });
  const post = (requestId: string, raw: string | undefined, body: unknown, agent = agentId) =>
    app.request(url(requestId, agent), { method: 'POST',
      headers: { ...bearer(raw), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const policy = (raw: string, enabled?: unknown, agent = agentId) =>
    app.request(`/admin-api/agents/${encodeURIComponent(agent)}/requester-approval-policy`, enabled === undefined
      ? { headers: bearer(raw) }
      : { method: 'PUT', headers: { ...bearer(raw), 'Content-Type': 'application/json' }, body: JSON.stringify(enabled) });
  async function denied(res: Response, status: number) {
    const text = await res.text();
    assert.equal(res.status, status, text);
    assert.ok(!text.includes(SECRET), 'denied responses must not reveal native arguments');
  }

  // A federated message creates the execution whose binding is snapshotted.
  // The blocking send stays open until the test finishes the binding.
  async function startTask(raw: string): Promise<TaskBinding> {
    const known = new Set(sent.filter(f => f.type === 'task.assign').map(f => f.taskId));
    const response = Promise.resolve(app.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'POST',
      headers: { ...bearer(raw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {
        message: { messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'work' }],
          // Forged internal metadata must not reach the binding.
          metadata: { _principalId: owner, _authorizationKey: keys.principal } },
        configuration: { blocking: true } } }) }));
    let assign: TaskAssignFrame | undefined;
    for (let i = 0; i < 200 && !assign; i++) {
      assign = sent.find((f): f is TaskAssignFrame => f.type === 'task.assign' && !known.has(f.taskId));
      if (!assign) await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(assign, 'task.assign not sent');
    const binding = registry.getBinding(assign.taskId);
    assert.ok(binding);
    pending.push({ binding, response });
    assert.equal(binding.principalId, tuple.subject);
    assert.equal(binding.actorId, actor);
    assert.equal(binding.authorizationProfile, MENTIONABLE_OAUTH_PROFILE_ID);
    assert.equal(binding.authorizationKey, keys.origin);
    return binding;
  }
  function request(binding: TaskBinding, input: Record<string, unknown> = { command: `echo ${SECRET}` }) {
    return registry.approvals.request(binding, { requestId: randomUUID(), toolName: 'Bash', input,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
  }
  function finish(binding: TaskBinding) {
    binding.sink.pushStatus({ taskId: binding.taskId, contextId: binding.contextId, final: true,
      status: { state: 'completed', timestamp: new Date().toISOString() } } as never);
    binding.sink.finish();
  }

  const ownerToken = await session(owner, 'owner_session');
  const strangerOwner = await session(`eth:0x${randomUUID().replaceAll('-', '')}11111111`, 'owner_session');
  const callerToken = await session(tuple.subject, 'caller');
  const requester = await token('origin');

  await t.test('policy defaults to false and is owner-scoped', async () => {
    const res = await policy(ownerToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { agent_id: agentId, enabled: false });
    assert.equal((await policy(strangerOwner)).status, 404);
    assert.equal((await policy(strangerOwner, { enabled: true })).status, 404);
    assert.equal((await policy(callerToken)).status, 401);
    assert.equal((await policy(requester, { enabled: true })).status, 401);
    assert.equal((await policy(ownerToken, { enabled: 'yes' })).status, 400);
    assert.equal((await policy(ownerToken, { enabled: true, principal: 'x' })).status, 400);
  });

  const b1 = await startTask(requester);
  const a1 = request(b1);
  const original = structuredClone(a1.input);

  await t.test('opt-in off denies even the exact originating requester', async () => {
    await denied(await get(a1.requestId, requester), 404);
    await denied(await post(a1.requestId, requester, { decision: 'allow_once' }), 404);
    assert.equal(a1.state, 'pending');
  });

  assert.equal((await policy(ownerToken, { enabled: true })).status, 200);
  assert.deepEqual(await (await policy(ownerToken)).json(), { agent_id: agentId, enabled: true });

  await t.test('rejects public, owner-session and caller tokens at the requester route', async () => {
    await denied(await get(a1.requestId), 401);
    await denied(await get(a1.requestId, ownerToken), 401);
    await denied(await get(a1.requestId, callerToken), 401);
    await denied(await post(a1.requestId, ownerToken, { decision: 'allow_once' }), 401);
    await denied(await get(a1.requestId, 'vbc_oauth_not-a-real-token'), 401);
    // Token minted for a different agent is not valid for this resource.
    await denied(await get(a1.requestId, await token('origin', { agent: otherAgentId })), 401);
    await denied(await get(a1.requestId, requester, otherAgentId), 401);
    await denied(await get(a1.requestId, await token('origin', { agent: otherAgentId }), otherAgentId), 404);
  });

  await t.test('rejects wrong principal, workspace, actor, scope and task', async () => {
    for (const which of ['principal', 'workspace', 'actor'] as const) {
      const raw = await token(which);
      await denied(await get(a1.requestId, raw), 404);
      await denied(await post(a1.requestId, raw, { decision: 'allow_once' }), 404);
    }
    await denied(await get(a1.requestId, await token('origin', { scopes: [OAUTH_FEDERATION_SCOPE_MESSAGE_SEND] })), 404);
    await denied(await get(a1.requestId, await token('origin', { taskId: 'some-other-task' })), 404);
    await denied(await get(randomUUID(), requester), 404);
    assert.equal(a1.state, 'pending');
  });

  await t.test('GET returns the original immutable input and nothing about the origin', async () => {
    const scoped = await token('origin', { taskId: b1.taskId });
    for (const raw of [requester, scoped]) {
      const res = await get(a1.requestId, raw);
      assert.equal(res.status, 200);
      const body = await res.json() as { approval: Record<string, unknown> };
      assert.deepEqual(body, { approval: { requestId: a1.requestId, agentId, taskId: b1.taskId,
        executionId: b1.executionId, toolName: 'Bash', input: original, expiresAt: a1.expiresAt, state: 'pending' } });
    }
  });

  await t.test('POST accepts only {decision}; body cannot supply a principal', async () => {
    await denied(await post(a1.requestId, requester, { decision: 'acceptForSession' }), 400);
    await denied(await post(a1.requestId, requester, { decision: 'allow_once', principalId: owner }), 400);
    await denied(await post(a1.requestId, requester, { decision: 'allow_once', decidedBy: owner }), 400);
    assert.equal(a1.state, 'pending');
  });

  await t.test('concurrent identical decisions are idempotent; conflicting ones 409', async () => {
    const before = sent.filter(f => f.type === 'approval.resolve').length;
    const results = await Promise.all([0, 1, 2].map(() => post(a1.requestId, requester, { decision: 'allow_once' })));
    for (const res of results) {
      assert.equal(res.status, 200);
      const body = await res.json() as { approval: Record<string, unknown> };
      assert.equal(body.approval.state, 'decided');
      assert.equal(body.approval.decision, 'allow_once');
      assert.equal(body.approval.decidedBy, tuple.subject);
      assert.deepEqual(body.approval.input, original);
    }
    assert.equal(sent.filter(f => f.type === 'approval.resolve').length, before + 1);
    await denied(await post(a1.requestId, requester, { decision: 'deny' }), 409);
    // The owner fallback still exists but cannot override a requester decision.
    const ownerDecide = await app.request(`/admin-api/agents/${agentId}/approvals/${a1.requestId}`, { method: 'POST',
      headers: { ...bearer(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) });
    assert.equal(ownerDecide.status, 409);
    // After the client consumes the decision, retry stays idempotent while live.
    registry.approvals.received(b1, a1.requestId, 'allow_once');
    const retry = await post(a1.requestId, requester, { decision: 'allow_once' });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { approval: { state: string } }).approval.state, 'received');
  });

  await t.test('concurrent conflicting decisions: exactly one wins', async () => {
    const a = request(b1);
    const results = await Promise.all([post(a.requestId, requester, { decision: 'allow_once' }),
      post(a.requestId, requester, { decision: 'deny' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    registry.approvals.received(b1, a.requestId, a.decision!);
  });

  await t.test('owner fallback decision is visible to but not overridable by the requester', async () => {
    const a = request(b1);
    const ownerDecide = await app.request(`/admin-api/agents/${agentId}/approvals/${a.requestId}`, { method: 'POST',
      headers: { ...bearer(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) });
    assert.equal(ownerDecide.status, 200);
    const view = await (await get(a.requestId, requester)).json() as { approval: { state: string; decision: string } };
    assert.equal(view.approval.state, 'decided');
    assert.equal(view.approval.decision, 'deny');
    await denied(await post(a.requestId, requester, { decision: 'deny' }), 409);
    registry.approvals.received(b1, a.requestId, 'deny');
  });

  await t.test('expired approvals are 409', async () => {
    const a = request(b1);
    a.expiresAt = new Date(Date.now() - 1).toISOString();
    await denied(await get(a.requestId, requester), 409);
    await denied(await post(a.requestId, requester, { decision: 'allow_once' }), 409);
    a.expiresAt = new Date(Date.now() + 60_000).toISOString();
    registry.approvals.received(b1, a.requestId, 'deny');
  });

  await t.test('disabling the policy takes effect on the next access', async () => {
    const a = request(b1);
    assert.equal((await get(a.requestId, requester)).status, 200);
    assert.equal((await policy(ownerToken, { enabled: false })).status, 200);
    await denied(await get(a.requestId, requester), 404);
    await denied(await post(a.requestId, requester, { decision: 'allow_once' }), 404);
    assert.equal((await policy(ownerToken, { enabled: true })).status, 200);
    registry.approvals.received(b1, a.requestId, 'deny');
  });

  await t.test('a different execution on the same task ID cannot reuse the old origin', async () => {
    const stale = request(b1);
    // Execution displaced by a continuation that carries a different origin.
    const replacement: TaskBinding = { ...b1, executionId: randomUUID(), nextClientSeq: 0,
      principalId: tuples.principal.subject, authorizationKey: keys.principal };
    assert.ok(registry.bindTask(replacement));
    await denied(await get(stale.requestId, requester), 404);
    await denied(await post(stale.requestId, requester, { decision: 'allow_once' }), 404);
    const foreign = request(replacement);
    await denied(await get(foreign.requestId, requester), 404);
    await denied(await post(foreign.requestId, requester, { decision: 'allow_once' }), 404);
    registry.unbindTask(replacement.taskId, replacement);
    await denied(await get(foreign.requestId, requester), 404);
  });

  await t.test('an approval whose live binding no longer matches its snapshot is 409', async () => {
    const b = await startTask(requester);
    const a = request(b);
    b.authorizationKey = keys.principal; // Live binding mutated after snapshot.
    await denied(await get(a.requestId, requester), 409);
    b.authorizationKey = keys.origin;
    assert.equal((await get(a.requestId, requester)).status, 200);
    finish(b);
  });

  await t.test('approvals raised by non-federated executions are not requester-decidable', async () => {
    const b: TaskBinding = { agentId, taskId: randomUUID(), executionId: randomUUID(), nextClientSeq: 0,
      contextId: 'ctx', principalId: tuple.subject, sink: { pushStatus() {}, pushArtifact() {}, finish() {} } };
    assert.ok(registry.bindTask(b));
    const a = request(b);
    await denied(await get(a.requestId, requester), 404);
    registry.unbindTask(b.taskId, b);
  });

  await t.test('revoking the exact grant denies the requester immediately', async () => {
    const b = await startTask(requester);
    const a = request(b);
    assert.equal((await get(a.requestId, requester)).status, 200);
    const fresh = await token('origin');
    const del = await app.request(`/admin-api/agents/${agentId}/federated-callers`, { method: 'DELETE',
      headers: { ...bearer(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify(tuples.origin) });
    assert.equal(del.status, 200);
    await denied(await get(a.requestId, requester), 401);
    await denied(await post(a.requestId, fresh, { decision: 'allow_once' }), 401);
    // Re-adding the grant must not resurrect authority bound to the old one.
    const add = await app.request(`/admin-api/agents/${agentId}/federated-callers`, { method: 'POST',
      headers: { ...bearer(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify(tuples.origin) });
    assert.equal(add.status, 200);
    await denied(await get(a.requestId, await token('origin')), 404);
    assert.equal(a.state, 'pending');
  });

  await t.test('A2A metadata carries the requester URL; audit logs omit native arguments', () => {
    assert.ok(logs.some(l => l.includes('"event":"tool_approval_decided"') && l.includes('"decidedVia":"requester"')
      && l.includes(`"originPrincipal":"${tuple.subject}"`)));
    for (const reason of ['origin_mismatch', 'policy_disabled', 'task_grant_mismatch', 'execution_not_live',
      'origin_not_federated', 'insufficient_scope', 'token_task_mismatch', 'decision_conflict']) {
      assert.ok(logs.some(l => l.includes('"event":"requester_approval_rejected"') && l.includes(`"reason":"${reason}"`)), reason);
    }
    assert.ok(logs.every(l => !l.includes(SECRET)), 'logs must not contain tool input');
  });
});
