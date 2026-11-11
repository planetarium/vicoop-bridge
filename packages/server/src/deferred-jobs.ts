import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Part } from '@vicoop-bridge/protocol';
import { TaskState, type Message, type Task } from '@a2x/sdk';
import type { Hono, Context } from 'hono';
import type { Sql, SqlExecutor } from './db.js';
import type { Registry } from './registry.js';
import { OWNER_SESSION_PREFIX, CALLER_TOKEN_PREFIX, verifySessionToken } from './auth/caller-token.js';
import { TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX } from './oauth/token-exchange/types.js';
import { verifyTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import { matchPrincipal, type VerifiedCaller } from './auth/principal.js';
import { executionMarker, executionWriter } from './execution-marker.js';
import { PostgresTaskStore } from './postgres-task-store.js';
import { WSForwardingExecutor } from './executor.js';
import { partToA2X } from './parts.js';
import { logEvent } from './log.js';

export const DEFERRED_JOBS_EXTENSION = 'https://github.com/planetarium/vicoop-bridge/blob/main/docs/deferred-jobs-v1.md';
const MAX_BYTES = 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);
const Registration = z.object({
  operationId: z.string().uuid(), version: z.number().int().positive(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTaskId: z.string().min(1).max(256), sourceExecutionId: z.string().uuid(), expiresAt: z.string().datetime(),
}).strict();
const Completion = z.object({
  version: z.number().int().positive(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  eventId: z.string().min(1).max(256), outcome: z.enum(['succeeded', 'failed']), parts: z.array(Part).max(100),
}).strict();
export type DeferredJobRegistration = z.infer<typeof Registration>;
export type DeferredJobCompletion = z.infer<typeof Completion>;
interface Origin {
  principalId: string; contextId: string; actorId: string | null; authorizationProfile: string | null;
  authorizationKey: string | null; allowedCaller: string | null; ownerRevision: string; policyRevision: string;
}
interface Job {
  id: string; agent_id: string; executor_principal: string; source_task_id: string; source_execution_id: string;
  operation_id: string; version: number; payload_digest: string; origin: Origin; state: string;
  expires_at: Date; completion: DeferredJobCompletion | null; completion_digest: string | null;
  continuation_task_id: string | null; lease_until: Date | null; failure_code: string | null;
}
class JobError extends Error {
  constructor(public status: 400 | 401 | 404 | 409, message: string) { super(message); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function view(job: Job) {
  return { jobId: job.id, operationId: job.operation_id, version: job.version, payloadDigest: job.payload_digest,
    sourceTaskId: job.source_task_id, sourceExecutionId: job.source_execution_id, contextId: job.origin.contextId,
    state: job.state, expiresAt: job.expires_at, continuationTaskId: job.continuation_task_id,
    ...(job.completion ? { outcome: job.completion.outcome } : {}),
    ...(job.failure_code ? { failureCode: job.failure_code } : {}) };
}

/** Trusted host adapter API. Registration authorizes one operator-funded continuation,
 * not a paid operation. The adapter must enforce its operation/consumer approval first. */
export class DeferredJobsService {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private cursor = '';
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly opts: { db: Sql; registry: Registry }) {}
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(error => logEvent('deferred_jobs_poll_failed', { error: String(error) })); }, intervalMs);
    this.timer.unref();
    void this.tick().catch(error => logEvent('deferred_jobs_poll_failed', { error: String(error) }));
  }
  // Stop admitting new continuations; in-flight drains finish normally. A
  // process crash instead leaves a persisted lease for fail-closed recovery.
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async drain(): Promise<void> { await Promise.allSettled([...this.running.values()]); }
  async owner(agentId: string, principal: string, sql: SqlExecutor = this.opts.db): Promise<void> {
    const rows = await sql`SELECT owner_principal FROM agents WHERE id=${agentId} FOR SHARE`;
    if (rows[0]?.owner_principal !== principal) throw new JobError(404, 'Not found');
  }
  private async get(agentId: string, jobId: string, sql: SqlExecutor = this.opts.db, lock = false): Promise<Job> {
    const rows = lock
      ? await sql<Job[]>`SELECT * FROM infra.deferred_jobs WHERE id=${jobId} AND agent_id=${agentId} FOR UPDATE`
      : await sql<Job[]>`SELECT * FROM infra.deferred_jobs WHERE id=${jobId} AND agent_id=${agentId}`;
    if (!rows[0]) throw new JobError(404, 'Not found');
    return rows[0];
  }
  private async directGrant(sql: SqlExecutor, principalId: string, allowed: string[]): Promise<string | null | undefined> {
    if (allowed.length === 0) return null;
    // A task persists the authenticated principal, not a verified email claim.
    // Do not manufacture that claim from another caller token's stored email.
    return allowed.find(entry => matchPrincipal(entry, { principalId }));
  }
  async register(agentId: string, executorPrincipal: string, input: DeferredJobRegistration) {
    const parsed = Registration.parse(input);
    const deadline = Date.parse(parsed.expiresAt);
    if (deadline <= Date.now() || deadline > Date.now() + 30 * 24 * 60 * 60_000) throw new JobError(400, 'Expiry must be within 30 days');
    return this.opts.db.begin(async sql => {
      await this.owner(agentId, executorPrincipal, sql);
      // Serializes retries of the same operation before a row exists.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`deferred:${agentId}:${parsed.operationId}`}))`;
      const previous = await sql<Job[]>`SELECT * FROM infra.deferred_jobs WHERE agent_id=${agentId} AND operation_id=${parsed.operationId}`;
      if (previous[0]) {
        const j = previous[0];
        if (j.executor_principal !== executorPrincipal || j.version !== parsed.version || j.payload_digest !== parsed.payloadDigest ||
          j.source_task_id !== parsed.sourceTaskId || j.source_execution_id !== parsed.sourceExecutionId || j.expires_at.getTime() !== deadline)
          throw new JobError(409, 'Operation already registered with different immutable inputs');
        return view(j);
      }
      const rows = await sql`SELECT * FROM infra.a2a_tasks WHERE owner_agent=${agentId} AND task_id=${parsed.sourceTaskId} FOR SHARE`;
      const source = rows[0];
      if (!source?.owner_principal || source.authorization_revoked_at || ['canceled', 'rejected', 'failed'].includes(source.state)) throw new JobError(409, 'Origin is unavailable');
      if (executionMarker((source.task_json as Task).metadata) !== parsed.sourceExecutionId) throw new JobError(409, 'Stale source execution');
      const agents = await sql`SELECT allowed_callers, owner_revision::text, caller_policy_revision::text FROM agents WHERE id=${agentId}`;
      const allowed = agents[0]!.allowed_callers as string[];
      const grant = source.authorization_key
        ? (allowed.includes(source.authorization_key) ? source.authorization_key as string : undefined)
        : await this.directGrant(sql, source.owner_principal, allowed);
      if (grant === undefined) throw new JobError(409, 'Origin authority revoked');
      const origin: Origin = { principalId: source.owner_principal, contextId: source.context_id,
        actorId: source.owner_actor, authorizationProfile: source.authorization_profile,
        authorizationKey: source.authorization_key, allowedCaller: grant,
        ownerRevision: agents[0]!.owner_revision, policyRevision: agents[0]!.caller_policy_revision };
      const created = await sql<Job[]>`INSERT INTO infra.deferred_jobs
        (id, agent_id, executor_principal, source_task_id, source_execution_id, operation_id, version, payload_digest, origin, expires_at)
        VALUES (${randomUUID()}, ${agentId}, ${executorPrincipal}, ${parsed.sourceTaskId}, ${parsed.sourceExecutionId},
          ${parsed.operationId}, ${parsed.version}, ${parsed.payloadDigest}, ${sql.json(JSON.parse(JSON.stringify(origin)))}, ${parsed.expiresAt}) RETURNING *`;
      return view(created[0]!);
    });
  }
  private async invalidReason(job: Job, sql: SqlExecutor = this.opts.db): Promise<string | undefined> {
    if (job.expires_at.getTime() <= Date.now()) return 'expired';
    const agents = await sql`SELECT owner_principal, allowed_callers, owner_revision::text, caller_policy_revision::text FROM agents WHERE id=${job.agent_id}`;
    if (agents[0]?.owner_principal !== job.executor_principal || agents[0]?.owner_revision !== job.origin.ownerRevision) return 'executor_revoked';
    if (agents[0]?.caller_policy_revision !== job.origin.policyRevision) return 'authority_revoked';
    const rows = await sql`SELECT * FROM infra.a2a_tasks WHERE task_id=${job.source_task_id} AND owner_agent=${job.agent_id}`;
    const source = rows[0];
    if (!source) return 'origin_unavailable';
    if (source.authorization_revoked_at) return 'authority_revoked';
    if (['canceled', 'rejected', 'failed'].includes(source.state)) return 'origin_canceled';
    if (source.owner_principal !== job.origin.principalId || source.context_id !== job.origin.contextId ||
      source.owner_actor !== job.origin.actorId || source.authorization_profile !== job.origin.authorizationProfile ||
      source.authorization_key !== job.origin.authorizationKey) return 'origin_changed';
    const allowed = agents[0]!.allowed_callers as string[];
    if (job.origin.allowedCaller !== null && !allowed.includes(job.origin.allowedCaller)) return 'authority_revoked';
    if (job.origin.allowedCaller === null && await this.directGrant(sql, job.origin.principalId, allowed) === undefined) return 'authority_revoked';
    return undefined;
  }
  async inspect(agentId: string, jobId: string, principal: string) {
    await this.owner(agentId, principal); return view(await this.get(agentId, jobId));
  }
  async complete(agentId: string, jobId: string, executorPrincipal: string, input: DeferredJobCompletion) {
    const completion = Completion.parse(input);
    if (JSON.stringify(completion).length > MAX_BYTES) throw new JobError(400, 'Completion too large');
    return this.opts.db.begin(async sql => {
      await this.owner(agentId, executorPrincipal, sql);
      const job = await this.get(agentId, jobId, sql, true);
      if (job.executor_principal !== executorPrincipal) throw new JobError(404, 'Not found');
      if (job.version !== completion.version || job.payload_digest !== completion.payloadDigest) throw new JobError(409, 'Stale operation');
      const hash = digest(completion);
      if (job.completion_digest) {
        if (job.completion_digest !== hash) throw new JobError(409, 'Conflicting completion');
        return view(job);
      }
      if (job.state !== 'waiting') throw new JobError(409, 'Job is no longer waiting');
      const invalid = await this.invalidReason(job, sql);
      if (invalid) throw new JobError(409, invalid);
      const rows = await sql<Job[]>`UPDATE infra.deferred_jobs SET completion=${sql.json(JSON.parse(JSON.stringify(completion)))}, completion_digest=${hash},
        state='queued', updated_at=now() WHERE id=${jobId} RETURNING *`;
      return view(rows[0]!);
    });
  }
  async cancel(agentId: string, jobId: string, principal: string, consumer = false) {
    if (!consumer) await this.owner(agentId, principal);
    const rows = await this.opts.db.begin(async sql => {
      const job = await this.get(agentId, jobId, sql, true);
      if (consumer && job.origin.principalId !== principal) throw new JobError(404, 'Not found');
      if (['delivered', 'failed', 'canceled', 'reconciliation_required'].includes(job.state)) return [job];
      return sql<Job[]>`UPDATE infra.deferred_jobs SET state='canceled', failure_code='canceled', updated_at=now() WHERE id=${jobId} RETURNING *`;
    });
    const job = rows[0]!;
    if (job.state === 'canceled' && job.continuation_task_id) {
      const store = new PostgresTaskStore(this.opts.db, { ownerAgent: agentId });
      const task = await store.getTask(job.continuation_task_id);
      if (task && !TERMINAL.has(task.status.state)) {
        // Same serialization primitive as normal tasks/cancel vs task.assign.
        await this.opts.registry.serializeDispatch(task.id, async () => {
          await store.updateTask(task.id, { status: { state: TaskState.CANCELED, timestamp: new Date().toISOString() } });
          const binding = this.opts.registry.getBinding(task.id);
          if (binding) {
            this.opts.registry.sendToAgent(agentId, { type: 'task.cancel', taskId: task.id, ...(binding.executionId ? { executionId: binding.executionId } : {}) });
            binding.sink.pushStatus({ taskId: task.id, contextId: task.contextId ?? task.id, final: true, status: { state: TaskState.CANCELED } });
            binding.sink.finish();
          }
        });
      }
    }
    return view(job);
  }
  async consumer(agentId: string, jobId: string, authorization: string | undefined, cancel = false): Promise<Job> {
    const raw = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!raw) throw new JobError(401, 'Caller bearer required');
    let caller: VerifiedCaller;
    let tokenTask: string | undefined;
    try {
      if (raw.startsWith(CALLER_TOKEN_PREFIX)) caller = await verifySessionToken(this.opts.db, raw, { expectedAudience: 'caller', bypassCache: true });
      else if (raw.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)) {
        const token = await verifyTokenExchangeAccessToken(this.opts.db, raw, agentId);
        if (!token.scopes.includes(cancel ? 'a2a:task.cancel' : 'a2a:task.read')) throw new Error('Scope');
        caller = { principalId: token.principalId, actorId: token.actorId,
          tokenExchange: { ...token, tokenId: token.tokenId, profileId: token.profileId } } as VerifiedCaller;
        tokenTask = token.taskId;
      } else throw new Error('Unsupported bearer');
    } catch { throw new JobError(401, 'Invalid caller bearer'); }
    const job = await this.get(agentId, jobId);
    if (caller.principalId !== job.origin.principalId || (caller.actorId ?? null) !== job.origin.actorId ||
      (caller.tokenExchange?.profileId ?? null) !== job.origin.authorizationProfile ||
      (caller.tokenExchange?.allowedCaller ?? null) !== job.origin.authorizationKey ||
      (tokenTask !== undefined && tokenTask !== job.source_task_id && tokenTask !== job.continuation_task_id)) throw new JobError(404, 'Not found');
    // Terminal states remain inspectable, but revoked origins do not.
    const invalid = await this.invalidReason({ ...job, expires_at: new Date(Date.now() + 1000) });
    if (invalid && invalid !== 'origin_canceled') throw new JobError(404, 'Not found');
    return job;
  }
  async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Every running execution maintains its lease. A second instance cannot
      // infer a crash merely from not holding the WebSocket for this agent.
      for (const id of this.running.keys()) await this.opts.db`UPDATE infra.deferred_jobs SET lease_until=now() + interval '60 seconds' WHERE id=${id} AND state='dispatching'`;
      const jobs = await this.opts.db<Job[]>`SELECT * FROM infra.deferred_jobs WHERE state IN ('waiting','queued','dispatching') AND id > ${this.cursor} ORDER BY id LIMIT 100`;
      this.cursor = jobs.length === 100 ? jobs.at(-1)!.id : '';
      for (const job of jobs) {
        const invalid = await this.invalidReason(job);
        if (invalid) {
          await this.opts.db`UPDATE infra.deferred_jobs SET state='canceled', failure_code=${invalid}, updated_at=now() WHERE id=${job.id} AND state IN ('waiting','queued','dispatching')`;
          if (job.continuation_task_id) await this.cancel(job.agent_id, job.id, job.origin.principalId, true).catch(() => {});
          continue;
        }
        if (job.state === 'dispatching') {
          if (this.running.has(job.id) || (job.lease_until && job.lease_until.getTime() > Date.now())) continue;
          const task = job.continuation_task_id ? await new PostgresTaskStore(this.opts.db, { ownerAgent: job.agent_id }).getTask(job.continuation_task_id) : null;
          const state = task?.status.state === 'completed' ? 'delivered' : task?.status.state === 'canceled' ? 'canceled' : task && TERMINAL.has(task.status.state) ? 'failed' : 'reconciliation_required';
          await this.opts.db`UPDATE infra.deferred_jobs SET state=${state}, failure_code=${state === 'reconciliation_required' ? 'dispatch_outcome_unknown' : null}, updated_at=now()
            WHERE id=${job.id} AND state='dispatching' AND lease_until <= now()`;
          continue;
        }
        if (job.state !== 'queued' || !this.opts.registry.getAgent(job.agent_id)) continue;
        // Do not start the continuation while its originating execution is
        // still active; caller runtime queues serialize other context turns.
        if (this.opts.registry.getBinding(job.source_task_id)) continue;
        const taskId = randomUUID();
        const task: Task = { id: taskId, contextId: job.origin.contextId, status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
          metadata: { [DEFERRED_JOBS_EXTENSION]: { jobId: job.id, operationId: job.operation_id, version: job.version, payloadDigest: job.payload_digest, sourceTaskId: job.source_task_id } } };
        const claimed = await this.opts.db.begin(async sql => {
          const locked = await this.get(job.agent_id, job.id, sql, true);
          if (locked.state !== 'queued' || await this.invalidReason(locked, sql)) return false;
          await sql`INSERT INTO infra.a2a_tasks (task_id,context_id,state,task_json,owner_agent,owner_principal,owner_actor,authorization_profile,authorization_key)
            VALUES (${taskId},${job.origin.contextId},'submitted',${sql.json(JSON.parse(JSON.stringify(task)))},${job.agent_id},${job.origin.principalId},${job.origin.actorId},${job.origin.authorizationProfile},${job.origin.authorizationKey})`;
          await sql`UPDATE infra.deferred_jobs SET state='dispatching', continuation_task_id=${taskId}, lease_until=now() + interval '60 seconds', updated_at=now() WHERE id=${job.id}`;
          return true;
        });
        if (!claimed) continue;
        const running = this.dispatch(job, task).catch(error => {
          logEvent('deferred_job_dispatch_failed', { jobId: job.id, error: String(error) });
        }).finally(() => { this.running.delete(job.id); });
        this.running.set(job.id, running);
      }
    } finally { this.polling = false; }
  }
  private async dispatch(job: Job, task: Task): Promise<void> {
    const store = new PostgresTaskStore(this.opts.db, { ownerAgent: job.agent_id });
    const origin = job.origin;
    const message: Message = { role: 'user', messageId: randomUUID(), taskId: task.id, contextId: origin.contextId,
      parts: [{ text: `External operation ${job.operation_id} (${job.completion!.outcome}) completed. Review the attached result and deliver the appropriate artifacts. Do not submit or repeat the external operation.` },
        ...job.completion!.parts.map(partToA2X)],
      metadata: { _principalId: origin.principalId, ...(origin.actorId ? { _actorId: origin.actorId } : {}),
        ...(origin.authorizationProfile ? { _authorizationProfile: origin.authorizationProfile } : {}),
        ...(origin.authorizationKey ? { _authorizationKey: origin.authorizationKey } : {}),
        [DEFERRED_JOBS_EXTENSION]: { jobId: job.id, operationId: job.operation_id, version: job.version, payloadDigest: job.payload_digest, sourceTaskId: job.source_task_id, outcome: job.completion!.outcome } } };
    // Host registration explicitly authorizes this follow-up. It is not a new
    // consumer payment and must never replay the provider operation.
    await executionWriter.run({}, async () => {
      const executor = new WSForwardingExecutor(job.agent_id, this.opts.registry, store);
      await executor.execute(task, message);
      await store.updateTask(task.id, { status: task.status, history: task.history, artifacts: task.artifacts });
    });
    const result = await store.getTask(task.id);
    const state = result?.status.state === 'completed' ? 'delivered' : result?.status.state === 'input-required' || result?.status.state === 'auth-required' ? 'awaiting_input' : result?.status.state === 'canceled' ? 'canceled' : 'failed';
    await this.opts.db`UPDATE infra.deferred_jobs SET state=${state}, lease_until=NULL, updated_at=now() WHERE id=${job.id} AND state='dispatching'`;
  }
}

export function mountDeferredJobs(app: Hono, opts: { db: Sql; registry: Registry; service?: DeferredJobsService }): DeferredJobsService {
  const service = opts.service ?? new DeferredJobsService(opts);
  const route = (action: (c: Context, principal: string) => Promise<unknown>) => async (c: Context) => {
    try {
      const raw = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!raw?.startsWith(OWNER_SESSION_PREFIX)) throw new JobError(401, 'Owner bearer required');
      let principal: string;
      try { principal = (await verifySessionToken(opts.db, raw, { expectedAudience: 'owner_session', bypassCache: true })).principalId; }
      catch { throw new JobError(401, 'Invalid owner bearer'); }
      return c.json({ job: await action(c, principal) });
    } catch (error) { return failure(c, error); }
  };
  const body = async (c: Context) => {
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new JobError(400, 'JSON body required');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new JobError(400, 'Body too large'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new JobError(400, 'Invalid JSON'); }
  };
  const base = '/admin-api/agents/:id/deferred-jobs';
  app.post(base, route(async (c, principal) => service.register(c.req.param('id')!, principal, await body(c))));
  app.get(`${base}/:jobId`, route(async (c, principal) => service.inspect(c.req.param('id')!, c.req.param('jobId')!, principal)));
  app.post(`${base}/:jobId/complete`, route(async (c, principal) => service.complete(c.req.param('id')!, c.req.param('jobId')!, principal, await body(c))));
  app.post(`${base}/:jobId/cancel`, route(async (c, principal) => service.cancel(c.req.param('id')!, c.req.param('jobId')!, principal)));
  for (const method of ['get', 'post'] as const) app[method](`/agents/:id/deferred-jobs/:jobId${method === 'post' ? '/cancel' : ''}`, async c => {
    try {
      const job = await service.consumer(c.req.param('id'), c.req.param('jobId'), c.req.header('Authorization'), method === 'post');
      return c.json({ job: method === 'post' ? await service.cancel(job.agent_id, job.id, job.origin.principalId, true) : view(job) });
    } catch (error) { return failure(c, error); }
  });
  return service;
}
function failure(c: Context, error: unknown) {
  if (error instanceof JobError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid deferred job request' }, 400);
  logEvent('deferred_job_api_failed', { error: String(error) });
  return c.json({ error: 'Internal error' }, 500);
}
