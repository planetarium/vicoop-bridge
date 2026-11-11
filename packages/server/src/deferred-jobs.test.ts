import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import { TaskState } from '@a2x/sdk';
import type { DownFrame } from '@vicoop-bridge/protocol';
import { ensureSchema } from './db.js';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { DeferredJobsService, DEFERRED_JOBS_EXTENSION } from './deferred-jobs.js';
import { issueSessionToken } from './auth/caller-token.js';
import { EXECUTION_MARKER_KEY } from './execution-marker.js';

async function waitFor(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('expected deferred transition');
}

test('durable external jobs authorize, recover and continue in the original A2A context', { skip: !process.env.DATABASE_URL }, async t => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  await ensureSchema(sql);
  const agentId = `deferred-${randomUUID()}`;
  const owner = `eth:0x${randomUUID().replaceAll('-', '')}00000000`;
  const caller = `eth:0x${randomUUID().replaceAll('-', '')}00000000`;
  const stranger = `eth:0x${randomUUID().replaceAll('-', '')}00000000`;
  const ownerToken = await issueSessionToken(sql, { principalId: owner, provider: 'siwe', audience: 'owner_session' });
  const callerToken = await issueSessionToken(sql, { principalId: caller, provider: 'siwe', audience: 'caller' });
  const strangerToken = await issueSessionToken(sql, { principalId: stranger, provider: 'siwe', audience: 'caller' });
  await sql`INSERT INTO agents (id,owner_principal,name,token_hash,allowed_callers) VALUES (${agentId},${owner},${agentId},${randomUUID()},${[caller,stranger]})`;
  const registry = new Registry();
  let service = new DeferredJobsService({ db: sql, registry });
  const app = createHttpApp({ db: sql, registry, deferredJobs: service, publicUrl: 'http://localhost' });
  const assigned: Extract<DownFrame, { type: 'task.assign' }>[] = [];
  const canceled: DownFrame[] = [];
  const ws = { close() {}, send(raw: string) {
    const frame = JSON.parse(raw) as DownFrame;
    if (frame.type === 'task.assign') assigned.push(frame);
    if (frame.type === 'task.cancel') canceled.push(frame);
  } } as unknown as WebSocket;
  const connect = () => registry.registerAgent({ agentId, clientId: agentId, ownerPrincipal: owner,
    agentCard: { name: agentId, version: '1', protocolVersion: '0.3.0', capabilities: { streaming: true } },
    allowedCallers: [caller,stranger], protocolCapabilities: ['task-replay-v1','caller-context-v2'], connectedAt: Date.now(), ws });
  const path = `/admin-api/agents/${agentId}/deferred-jobs`;
  const call = (url: string, body?: unknown, token = ownerToken.rawToken) => app.request(url, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = async (response: Response, status = 200) => {
    const body = await response.json() as any;
    assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  const source = async (state = 'completed') => {
    const id = randomUUID(), contextId = randomUUID(), executionId = randomUUID();
    const task = { id, contextId, status: { state }, metadata: { [EXECUTION_MARKER_KEY]: { executionId } } };
    await sql`INSERT INTO infra.a2a_tasks(task_id,context_id,state,task_json,owner_agent,owner_principal,dispatch_id)
      VALUES(${id},${contextId},${state},${sql.json(task)},${agentId},${caller},${executionId})`;
    return { id, contextId, executionId };
  };
  const register = async (state = 'completed') => {
    const origin = await source(state);
    const input = { operationId: randomUUID(), version: 1, payloadDigest: 'a'.repeat(64), sourceTaskId: origin.id,
      sourceExecutionId: origin.executionId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const job = (await json(await call(path, input))).job;
    return { origin, input, job };
  };
  const completion = { version: 1, payloadDigest: 'a'.repeat(64), eventId: 'provider-result', outcome: 'succeeded',
    parts: [{ kind: 'file', file: { name: 'result.txt', mimeType: 'text/plain', bytes: Buffer.from('provider result').toString('base64') } }] };
  const finish = (taskId: string) => {
    const binding = registry.getBinding(taskId)!;
    assert.ok(binding);
    binding.sink.pushArtifact({ taskId, contextId: binding.contextId, artifact: { artifactId: randomUUID(), name: 'reviewed.txt',
      parts: [{ raw: Buffer.from('reviewed bytes').toString('base64'), filename: 'reviewed.txt', mediaType: 'text/plain' }] } });
    binding.sink.pushStatus({ taskId, contextId: binding.contextId, final: true, status: { state: TaskState.COMPLETED } });
    binding.sink.finish();
  };
  t.after(async () => {
    service.stop();
    for (const frame of assigned) { const binding = registry.getBinding(frame.taskId); if (binding) { binding.sink.pushStatus({ taskId: frame.taskId, contextId: frame.contextId, final: true, status: { state: TaskState.CANCELED } }); binding.sink.finish(); } }
    await waitFor(async () => assigned.every(f => !registry.getBinding(f.taskId)));
    await sql`DELETE FROM infra.deferred_jobs WHERE agent_id=${agentId}`;
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
    await sql`DELETE FROM agents WHERE id=${agentId}`;
    await sql`DELETE FROM callers WHERE principal_id = ANY(${[owner,caller,stranger]})`;
    await sql.end();
  });

  await t.test('owner-only registration, immutable correlation and consumer-scoped durable lookup', async () => {
    const { input, job } = await register();
    assert.equal((await json(await call(path, input))).job.jobId, job.jobId);
    await json(await call(path, { ...input, version: 2 }), 409);
    await json(await call(path, { ...input, operationId: randomUUID(), sourceExecutionId: randomUUID() }), 409);
    await json(await call(path, { ...input, operationId: randomUUID() }, callerToken.rawToken), 401);
    const lookup = `/agents/${agentId}/deferred-jobs/${job.jobId}`;
    assert.equal((await json(await call(lookup, undefined, callerToken.rawToken))).job.state, 'waiting');
    await json(await call(lookup, undefined, strangerToken.rawToken), 404);
    await json(await call(`${path}/${job.jobId}/complete`, { ...completion, version: 2 }), 409);
    await json(await call(`${path}/${job.jobId}/complete`, completion, callerToken.rawToken), 401);
    await json(await call(`${path}/${job.jobId}/cancel`, {}));
  });

  await t.test('offline completion survives service restart and dispatches one linked successor with actual artifacts', async () => {
    const { origin, job } = await register('input-required');
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    await service.tick();
    assert.equal(assigned.length, 0);
    service.stop(); service = new DeferredJobsService({ db: sql, registry });
    connect();
    await service.tick();
    await waitFor(async () => assigned.length === 1);
    const frame = assigned[0]!;
    assert.notEqual(frame.taskId, origin.id);
    assert.equal(frame.contextId, origin.contextId);
    assert.ok(frame.caller && 'principal' in frame.caller);
    assert.equal(frame.caller.principal?.id, caller);
    assert.equal((frame.message.metadata?.[DEFERRED_JOBS_EXTENSION] as any).jobId, job.jobId);
    assert.deepEqual(frame.message.parts[1], completion.parts[0]);
    // Callback replay and concurrent polling cannot create another task.
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    await json(await call(`${path}/${job.jobId}/complete`, { ...completion, eventId: 'different' }), 409);
    await Promise.all([service.tick(), new DeferredJobsService({ db: sql, registry }).tick()]);
    assert.equal(assigned.length, 1);
    finish(frame.taskId);
    await waitFor(async () => (await service.inspect(agentId, job.jobId, owner)).state === 'delivered');
    const task = await sql`SELECT task_json FROM infra.a2a_tasks WHERE task_id=${frame.taskId}`;
    assert.equal(task[0]!.task_json.artifacts[0].parts[0].raw, Buffer.from('reviewed bytes').toString('base64'));
    const original = await sql`SELECT state FROM infra.a2a_tasks WHERE task_id=${origin.id}`;
    assert.equal(original[0]!.state, 'input-required');
  });

  await t.test('later same-task execution does not invalidate the immutable registered origin', async () => {
    const { origin, job } = await register();
    await sql`UPDATE infra.a2a_tasks SET dispatch_id=${randomUUID()}, task_json=jsonb_set(task_json,'{metadata}', ${sql.json({ [EXECUTION_MARKER_KEY]: { executionId: randomUUID() } })}) WHERE task_id=${origin.id}`;
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    const before = assigned.length;
    await service.tick(); await waitFor(async () => assigned.length === before + 1);
    finish(assigned.at(-1)!.taskId);
    await waitFor(async () => (await service.inspect(agentId, job.jobId, owner)).state === 'delivered');
  });

  await t.test('cancellation, source cancellation, expiry and revoked grant cannot dispatch', async () => {
    for (const reason of ['cancel','source','expiry','revocation'] as const) {
      const { origin, job } = await register();
      if (reason === 'cancel') await json(await call(`/agents/${agentId}/deferred-jobs/${job.jobId}/cancel`, {}, callerToken.rawToken));
      if (reason === 'source') await sql`UPDATE infra.a2a_tasks SET state='canceled' WHERE task_id=${origin.id}`;
      if (reason === 'expiry') await sql`UPDATE infra.deferred_jobs SET expires_at=now()-interval '1 second' WHERE id=${job.jobId}`;
      if (reason === 'revocation') await sql`UPDATE agents SET allowed_callers=${[stranger]} WHERE id=${agentId}`;
      await json(await call(`${path}/${job.jobId}/complete`, completion), 409);
      const before = assigned.length; await service.tick(); assert.equal(assigned.length, before);
      assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'canceled');
      if (reason === 'revocation') await sql`UPDATE agents SET allowed_callers=${[caller,stranger]} WHERE id=${agentId}`;
    }
  });

  await t.test('canceling dispatch cancels the actual continuation and late output cannot relabel it', async () => {
    const { job } = await register();
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    const before = assigned.length; await service.tick(); await waitFor(async () => assigned.length > before);
    const frame = assigned.at(-1)!;
    await json(await call(`${path}/${job.jobId}/cancel`, {}));
    await waitFor(async () => !registry.getBinding(frame.taskId));
    assert.ok(canceled.some(f => 'taskId' in f && f.taskId === frame.taskId));
    assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'canceled');
    const rows = await sql`SELECT state FROM infra.a2a_tasks WHERE task_id=${frame.taskId}`;
    assert.equal(rows[0]!.state, 'canceled');
  });

  await t.test('remove/re-add and owner transfer/return never resurrect registered jobs', async () => {
    for (const kind of ['grant', 'owner'] as const) {
      const { job } = await register();
      if (kind === 'grant') {
        await sql`UPDATE agents SET allowed_callers=${[stranger]} WHERE id=${agentId}`;
        await sql`UPDATE agents SET allowed_callers=${[caller,stranger]} WHERE id=${agentId}`;
      } else {
        await sql`UPDATE agents SET owner_principal=${stranger} WHERE id=${agentId}`;
        await sql`UPDATE agents SET owner_principal=${owner} WHERE id=${agentId}`;
      }
      await json(await call(`${path}/${job.jobId}/complete`, completion), 409);
      const before = assigned.length; await service.tick(); assert.equal(assigned.length, before);
      assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'canceled');
    }
  });

  await t.test('fresh token checks reject cached owner and consumer tokens after revocation', async () => {
    const { job } = await register();
    const ephemeralOwner = await issueSessionToken(sql, { principalId: owner, provider: 'siwe', audience: 'owner_session' });
    const ephemeralCaller = await issueSessionToken(sql, { principalId: caller, provider: 'siwe', audience: 'caller' });
    await json(await call(`${path}/${job.jobId}`, undefined, ephemeralOwner.rawToken));
    await json(await call(`/agents/${agentId}/deferred-jobs/${job.jobId}`, undefined, ephemeralCaller.rawToken));
    await sql`UPDATE callers SET revoked=true WHERE id = ANY(${[ephemeralOwner.callerId, ephemeralCaller.callerId]})`;
    await json(await call(`${path}/${job.jobId}/complete`, completion, ephemeralOwner.rawToken), 401);
    await json(await call(`/agents/${agentId}/deferred-jobs/${job.jobId}`, undefined, ephemeralCaller.rawToken), 401);
    await json(await call(`${path}/${job.jobId}/cancel`, {}));
  });

  await t.test('queued cancellation and active authority revocation suppress continuation effects', async () => {
    const queued = await register();
    await json(await call(`${path}/${queued.job.jobId}/complete`, completion));
    await json(await call(`${path}/${queued.job.jobId}/cancel`, {}));
    const before = assigned.length; await service.tick(); assert.equal(assigned.length, before);
    const active = await register();
    await json(await call(`${path}/${active.job.jobId}/complete`, completion));
    await service.tick(); await waitFor(async () => assigned.length > before);
    const taskId = assigned.at(-1)!.taskId;
    await sql`UPDATE agents SET allowed_callers=${[stranger]} WHERE id=${agentId}`;
    await service.tick();
    await waitFor(async () => !registry.getBinding(taskId));
    assert.equal((await service.inspect(agentId, active.job.jobId, owner)).state, 'canceled');
    const row = await sql`SELECT state FROM infra.a2a_tasks WHERE task_id=${taskId}`;
    assert.equal(row[0]!.state, 'canceled');
    await sql`UPDATE agents SET allowed_callers=${[caller,stranger]} WHERE id=${agentId}`;
  });

  await t.test('worker keyset scan reaches queued work beyond 100 waiting records', async () => {
    const { job } = await register();
    // Copies represent independently registered jobs and exercise only the
    // worker scan, without making this scheduling test a 100-request benchmark.
    await sql`INSERT INTO infra.deferred_jobs
      (id,agent_id,executor_principal,source_task_id,source_execution_id,operation_id,version,payload_digest,origin,expires_at)
      SELECT '00000000-' || n::text, agent_id,executor_principal,source_task_id,source_execution_id,
        gen_random_uuid()::text,version,payload_digest,origin,expires_at
      FROM infra.deferred_jobs CROSS JOIN generate_series(1,110) n WHERE id=${job.jobId}`;
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    const before = assigned.length;
    const worker = new DeferredJobsService({ db: sql, registry });
    await worker.tick(); await worker.tick();
    await waitFor(async () => assigned.length > before);
    finish(assigned.at(-1)!.taskId); await worker.drain();
    await sql`DELETE FROM infra.deferred_jobs WHERE agent_id=${agentId} AND id LIKE '00000000-%'`;
    assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'delivered');
  });

  await t.test('oversized callback is rejected before parsing or recording it', async () => {
    const { job } = await register();
    await json(await call(`${path}/${job.jobId}/complete`, { ...completion, parts: [{ kind: 'text', text: 'x'.repeat(1024 * 1024) }] }), 400);
    assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'waiting');
    await json(await call(`${path}/${job.jobId}/cancel`, {}));
  });

  await t.test('input-required successor settles after ordinary follow-up and cancels on revocation', async () => {
    for (const outcome of ['completed','canceled','revoked'] as const) {
      const { job } = await register();
      await json(await call(`${path}/${job.jobId}/complete`, completion));
      const before = assigned.length; await service.tick(); await waitFor(async () => assigned.length > before);
      const frame = assigned.at(-1)!;
      const binding = registry.getBinding(frame.taskId)!;
      binding.sink.pushStatus({ taskId: frame.taskId, contextId: frame.contextId, final: true, status: { state: TaskState.INPUT_REQUIRED } });
      binding.sink.finish();
      await waitFor(async () => (await service.inspect(agentId, job.jobId, owner)).state === 'awaiting_input');
      if (outcome === 'revoked') await sql`UPDATE agents SET allowed_callers=${[stranger]} WHERE id=${agentId}`;
      else await sql`UPDATE infra.a2a_tasks SET state=${outcome}, task_json=jsonb_set(task_json,'{status,state}',to_jsonb(${outcome}::text)) WHERE task_id=${frame.taskId}`;
      await service.tick();
      assert.equal((await service.inspect(agentId, job.jobId, owner)).state, outcome === 'completed' ? 'delivered' : 'canceled');
      assert.equal(assigned.length, before + 1);
      if (outcome === 'revoked') await sql`UPDATE agents SET allowed_callers=${[caller,stranger]} WHERE id=${agentId}`;
    }
  });

  await t.test('ambiguous dispatch after restart is reconciled, never automatically redispatched', async () => {
    const { job } = await register();
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    const taskId = randomUUID();
    await sql`UPDATE infra.deferred_jobs SET state='dispatching', continuation_task_id=${taskId}, lease_until=now()-interval '1 second' WHERE id=${job.jobId}`;
    const before = assigned.length;
    await new DeferredJobsService({ db: sql, registry }).tick();
    assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'reconciliation_required');
    await json(await call(`${path}/${job.jobId}/complete`, completion));
    await service.tick(); assert.equal(assigned.length, before);
    // A late persisted result resolves the uncertainty without resubmission.
    const origin = await sql`SELECT origin FROM infra.deferred_jobs WHERE id=${job.jobId}`;
    const task = { id: taskId, contextId: origin[0]!.origin.contextId, status: { state: 'completed' } };
    await sql`INSERT INTO infra.a2a_tasks(task_id,context_id,state,task_json,owner_agent,owner_principal)
      VALUES(${taskId},${task.contextId},'completed',${sql.json(task)},${agentId},${caller})`;
    await service.tick();
    assert.equal((await service.inspect(agentId, job.jobId, owner)).state, 'delivered');
    assert.equal(assigned.length, before);
  });
});
