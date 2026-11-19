import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context, Hono } from 'hono';
import { MAX_OPERATION_FIELDS, MAX_OPERATION_REGISTRATION_BYTES, OPERATION_APPROVAL_EXTENSION_URI, OPERATION_PROPOSAL_TYPE } from '@vicoop-bridge/protocol';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Sql, SqlExecutor } from './db.js';
import {
  verifyTokenExchangeAccessToken,
  type TokenExchangeAccessToken,
} from './oauth/token-exchange/store.js';

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const scalar = z.union([z.string().max(2048), z.number().int().safe(), z.boolean()]);
const args = z.record(name, scalar).refine((a) => Object.keys(a).length <= MAX_OPERATION_FIELDS);
const definition = z
  .object({
    agentId: z.string().min(1),
    ownerPrincipal: z.string().min(1),
    operation: name,
    version: z.string().min(1).max(128),
    executorId: name,
    ownerRevision: z.number().int().nonnegative().safe(),
    ttlSeconds: z.number().int().min(3600).max(604800),
    executorTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    operators: z
      .array(
        z
          .object({
            principalId: z.string().min(1),
            actorId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    fields: z.record(
      name,
      z
        .object({
          type: z.enum(['string', 'integer', 'boolean']),
          allowedValues: z.array(scalar).min(1).optional(),
        })
        .strict(),
    ).refine(fields => Object.keys(fields).length <= MAX_OPERATION_FIELDS),
  })
  .strict();
export type OperationDefinition = z.infer<typeof definition>;

export function readOperationRegistry(raw: string | undefined): OperationDefinition[] {
  if (!raw) return [];
  const entries = z.array(definition).max(256).parse(JSON.parse(raw));
  const epochs = new Set<string>();
  const credentials = new Set<string>();
  for (const entry of entries) {
    const key = [entry.agentId, entry.operation];
    const epoch = JSON.stringify([...key, entry.ownerRevision]);
    const credential = JSON.stringify([...key, entry.executorTokenSha256]);
    if (epochs.has(epoch)) throw new Error('Duplicate registered operation for ownership revision');
    if (credentials.has(credential))
      throw new Error('Ownership revisions require distinct executor credentials');
    epochs.add(epoch);
    credentials.add(credential);
  }
  return entries;
}

const registration = z
  .object({
    taskId: z.string().min(1).max(200),
    proposalKey: z.string().min(1).max(200),
    operation: name,
    arguments: args,
  })
  .strict();
const decision = z
  .object({
    decision: z.enum(['approve', 'deny']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const outcome = z
  .object({
    state: z.enum(['succeeded', 'failed', 'unknown']),
    result: z.string().max(1024),
  })
  .strict();
function policyDigest(policy: OperationDefinition) {
  // Credential rotation preserves the identity of this named executor.
  const { executorTokenSha256: _credential, ...definition } = policy;
  return hash(canonical(definition));
}
// Run before serving connections with the new immutable registry.
export async function reconcileOperationPolicies(db: Sql, policies: OperationDefinition[]) {
  const hashes = policies.map(policyDigest);
  await db`UPDATE infra.operation_requests SET state='cancelled', result='Operation policy changed',
    history=history||jsonb_build_object('event', CASE WHEN requester=decided_principal THEN 'self_approval_revoked'
      ELSE 'policy_changed' END, 'at',clock_timestamp())
    WHERE state IN ('pending','approved') AND expires_at > clock_timestamp()
    AND (NOT (policy_digest = ANY(${hashes}::text[])) OR (state='approved' AND requester=decided_principal))`;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

function error(status: 400 | 401 | 404 | 409, message: string): never {
  throw new HTTPException(status, { message });
}
function missing(): never {
  return error(404, 'Not found');
}
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) error(400, 'Invalid request');
  return parsed.data;
}
function token(c: Context): string {
  return c.req.header('authorization')?.match(/^Bearer (\S+)$/i)?.[1] ?? '';
}
type RequestRow = {
  id: string;
  agent_id: string;
  agent_owner: string;
  owner_revision: string;
  task_id: string;
  artifact_id: string;
  requester: string;
  requester_revoked: boolean;
  actor: string;
  profile: string;
  grant_key: string;
  executor_id: string;
  version: string;
  operation: string;
  policy_digest: string;
  arguments: Record<string, string | number | boolean>;
  digest: string;
  expires_at: Date;
  expired: boolean;
  state: string;
  decision: string | null;
  decided_by: string | null;
  decided_principal: string | null;
  decided_actor: string | null;
  result: string | null;
};
type Source = {
  state: string;
  owner_principal: string;
  owner_actor: string;
  authorization_profile: string;
  authorization_key: string;
  authorization_revoked_at: Date | null;
  task_json: {
    artifacts?: { artifactId: string; extensions?: string[]; parts?: { data?: unknown }[] }[];
  };
};
function view(row: RequestRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    operation: row.operation,
    version: row.version,
    executorId: row.executor_id,
    arguments: row.arguments,
    digest: row.digest,
    expiresAt: row.expires_at.toISOString(),
    state: row.expired && ['pending', 'approved'].includes(row.state) ? 'expired' : row.state,
    result: row.result,
  };
}
async function record(db: SqlExecutor, agent: string, id: string, lock = false) {
  if (!z.string().uuid().safeParse(id).success) missing();
  const [row] = await db<RequestRow[]>`SELECT *, expires_at <= clock_timestamp() AS expired
    FROM infra.operation_requests WHERE agent_id=${agent} AND id=${id} ${
    lock ? db`FOR UPDATE` : db``
  }`;
  return row ?? missing();
}
async function source(db: SqlExecutor, agent: string, task: string) {
  const [row] = await db<
    Source[]
  >`SELECT t.state, t.owner_principal, t.owner_actor, t.authorization_profile,
    t.authorization_key, t.authorization_revoked_at, t.task_json FROM infra.a2a_tasks t
    JOIN agents a ON a.id=t.owner_agent AND t.authorization_key=ANY(a.allowed_callers)
    WHERE t.owner_agent=${agent} AND t.task_id=${task} AND t.operation_owner_revision=a.owner_revision AND t.created_at>=a.created_at FOR SHARE OF t,a`;
  if (!row || row.authorization_revoked_at) missing();
  return row;
}
function isRequester(row: RequestRow, user: TokenExchangeAccessToken) {
  return (
    !row.requester_revoked &&
    user.principalId === row.requester &&
    user.actorId === row.actor &&
    user.profileId === row.profile &&
    user.allowedCaller === row.grant_key
  );
}
function hasPlatformDecisionCredential(user: TokenExchangeAccessToken) {
  return user.taskId === undefined && user.scopes.includes('a2a:message.send');
}
function eligibleOperator(row: RequestRow, policy: OperationDefinition, user: TokenExchangeAccessToken) {
  // The platform subject includes the Slack workspace and user. A second
  // connector or a different grant cannot turn that same person into a reviewer.
  if (row.requester === user.principalId) return false;
  return policy.operators.some(
    (o) => o.principalId === user.principalId && o.actorId === user.actorId,
  );
}

export function mountOperations(
  app: Hono,
  db: Sql,
  policies = readOperationRegistry(process.env.VICOOP_OPERATIONS),
) {
  const path = '/agents/:agent/operations';
  const workerPath = '/operation-executors/:agent/:operation';
  const limit = bodyLimit({ maxSize: MAX_OPERATION_REGISTRATION_BYTES });
  for (const route of [path, path + '/*', workerPath + '/*']) {
    app.use(
      route,
      async (c, next) => {
        c.header('Cache-Control', 'private, no-store');
        await next();
      },
      limit,
    );
  }
  async function user(
    db: SqlExecutor,
    c: Context,
    agent: string,
    allowRetainedOperationRead = false,
  ) {
    // Take policy then credential locks in the same order as revocation.
    if (!token(c)) error(401, 'Invalid credential');
    await db`SELECT id FROM agents WHERE id=${agent} FOR SHARE`;
    // The verifier stamps last_used_at on this transaction. Acquire its write
    // lock immediately so parallel reviews never need to upgrade shared locks.
    await db`SELECT id FROM infra.oauth_token_exchange_access_tokens WHERE token_hash=${hash(
      token(c),
    )} FOR UPDATE`;
    const identity = await verifyTokenExchangeAccessToken(db, token(c), agent, {
      allowRetainedOperationRead,
    }).catch(() => error(401, 'Invalid credential'));
    if (!identity.scopes.includes('a2a:task.read')) missing();
    return identity;
  }
  async function ownerFor(tx: SqlExecutor, agent: string) {
    const [owner] = await tx<{ owner_principal: string; owner_revision: string }[]>`
      SELECT owner_principal, owner_revision::text FROM agents WHERE id=${agent} FOR SHARE`;
    if (!owner) missing();
    return owner;
  }
  function policyFor(
    agent: string,
    operation: string,
    owner: Awaited<ReturnType<typeof ownerFor>>,
  ) {
    return policies.find(
      (p) =>
        p.agentId === agent &&
        p.operation === operation &&
        p.ownerPrincipal === owner.owner_principal &&
        p.ownerRevision === Number(owner.owner_revision),
    );
  }
  function samePolicy(row: RequestRow, policy: OperationDefinition) {
    return (
      row.agent_owner === policy.ownerPrincipal &&
      Number(row.owner_revision) === policy.ownerRevision &&
      row.policy_digest === policyDigest(policy)
    );
  }
  app.post(path, async (c) => {
    const agent = c.req.param('agent');
    const input = await body(c, registration);
    return c.json(
      await db.begin(async (tx) => {
        const identity = await user(tx, c, agent);
        if (identity.taskId && identity.taskId !== input.taskId) missing();
        const policy = policyFor(agent, input.operation, await ownerFor(tx, agent)) ?? missing();
        const data = {
          type: OPERATION_PROPOSAL_TYPE,
          operation: input.operation,
          arguments: input.arguments,
        };
        const g = identity.allowedCaller;
        const policyHash = policyDigest(policy);
        const digest = hash(
          canonical({
            agent,
            task: input.taskId,
            artifact: input.proposalKey,
            requester: identity.principalId,
            actor: identity.actorId,
            grant: g,
            policyDigest: policyHash,
            data,
          }),
        );
        const existing = async () =>
          (
            await tx<RequestRow[]>`SELECT *,expires_at <= clock_timestamp() AS expired
        FROM infra.operation_requests WHERE agent_id=${agent} AND task_id=${input.taskId} AND artifact_id=${input.proposalKey}`
          )[0];
        const prior = await existing();
        if (prior && !isRequester(prior, identity)) missing();
        if (prior && prior.digest === digest) return view(prior);
        if (prior) error(409, 'Proposal changed');
        const origin = await source(tx, agent, input.taskId);
        if (
          origin.owner_principal !== identity.principalId ||
          origin.owner_actor !== identity.actorId ||
          origin.authorization_profile !== identity.profileId ||
          origin.authorization_key !== identity.allowedCaller
        )
          missing();
        if (['failed', 'canceled', 'rejected'].includes(origin.state))
          error(400, 'Source task did not complete');
        if (!['completed', 'input-required'].includes(origin.state))
          error(409, 'Proposal task is not ready');
        const artifact =
          origin.task_json.artifacts?.filter((a) => a.artifactId === input.proposalKey) ?? [];
        if (!artifact.length) error(400, 'Proposal artifact missing from ready task');
        if (
          artifact.length !== 1 ||
          !artifact[0].extensions?.includes(OPERATION_APPROVAL_EXTENSION_URI) ||
          artifact[0].parts?.length !== 1 ||
          !isDeepStrictEqual(artifact[0].parts[0].data, data)
        )
          error(409, 'Proposal artifact mismatch');
        if (Object.keys(input.arguments).length !== Object.keys(policy.fields).length)
          error(400, 'Invalid operation fields');
        for (const [key, field] of Object.entries(policy.fields)) {
          const value = input.arguments[key];
          if (
            typeof value !== (field.type === 'integer' ? 'number' : field.type) ||
            (field.allowedValues && !field.allowedValues.includes(value))
          )
            error(400, 'Invalid operation field');
        }
        await tx`INSERT INTO infra.operation_requests
        (id, agent_id,agent_owner,owner_revision,task_id,artifact_id,requester,actor,profile,grant_key,operation,version,executor_id,policy_digest,arguments,digest,expires_at,history)
        VALUES (${randomUUID()},${agent},${policy.ownerPrincipal},${policy.ownerRevision},${
          input.taskId
        },${input.proposalKey},
        ${identity.principalId},${identity.actorId},${identity.profileId},${g},${input.operation},${
          policy.version
        },${policy.executorId},${policyHash},
        ${tx.json(input.arguments)},${digest},clock_timestamp()+${
          policy.ttlSeconds
        } * interval '1 second',
        jsonb_build_array(jsonb_build_object('event','proposed','by',${
          identity.principalId
        }::text,'actor',${identity.actorId}::text,'grant',${g}::text,'at',clock_timestamp())))
        ON CONFLICT(agent_id,task_id,artifact_id) DO NOTHING`;
        const saved = await existing();
        if (!saved || saved.digest !== digest) error(409, 'Proposal changed');
        return view(saved);
      }),
    );
  });

  async function access<T>(
    c: Context,
    action: (
      tx: SqlExecutor,
      row: RequestRow,
      identity: TokenExchangeAccessToken,
      policy: OperationDefinition | undefined,
    ) => Promise<T>,
    allowRetainedOperationRead = false,
  ) {
    const agent = c.req.param('agent')!;
    return db.begin(async (tx) => {
      const identity = await user(tx, c, agent, allowRetainedOperationRead);
      const row = await record(tx, agent, c.req.param('id')!, c.req.method !== 'GET');
      const owner = await ownerFor(tx, agent);
      const policy = policyFor(agent, row.operation, owner);
      if (identity.taskId && identity.taskId !== row.task_id) missing();
      if (
        identity.operationReadRevision !== undefined &&
        (identity.operationReadRevision !== row.owner_revision ||
          identity.taskId !== row.task_id ||
          !isRequester(row, identity))
      )
        missing();
      if (!isRequester(row, identity) && !(policy && eligibleOperator(row, policy, identity))) missing();
      if (owner.owner_principal !== row.agent_owner || owner.owner_revision !== row.owner_revision)
        missing();
      return action(tx, row, identity, policy);
    });
  }
  app.get(path + '/:id', async (c) =>
    c.json(
      await access(
        c,
        async (_tx, row, identity, policy) => ({
          ...view(row),
          canDecide:
            hasPlatformDecisionCredential(identity) &&
            row.state === 'pending' &&
            !row.expired &&
            !!policy &&
            samePolicy(row, policy) &&
            eligibleOperator(row, policy, identity),
        }),
        true,
      ),
    ),
  );
  app.get(path + '/:id/audit', async (c) =>
    c.json(
      await access(c, async (tx, row) => {
        const [entry] = await tx`SELECT history FROM infra.operation_requests WHERE id=${row.id}`;
        return { id: row.id, history: entry.history };
      }),
    ),
  );
  app.post(path + '/:id/decision', async (c) => {
    const input = await body(c, decision);
    return c.json(
      await access(c, async (tx, row, identity, policy) => {
        if (!policy || !eligibleOperator(row, policy, identity) || !hasPlatformDecisionCredential(identity)) missing();
        if (!samePolicy(row, policy) || input.digest !== row.digest) error(409, 'Proposal changed');
        const next = input.decision === 'approve' ? 'approved' : 'denied';
        if (
          row.decision === input.decision &&
          row.decided_by === identity.allowedCaller &&
          row.decided_principal === identity.principalId &&
          row.decided_actor === identity.actorId
        )
          return view(row);
        if (row.state !== 'pending') error(409, 'Decision already taken');
        const updated =
          await tx`UPDATE infra.operation_requests SET state=${next}, decision=${input.decision}, decided_by=${identity.allowedCaller},
        decided_principal=${identity.principalId}, decided_actor=${identity.actorId},
        history=history||jsonb_build_object('event',${next}::text,'by',${identity.principalId}::text,
          'actor',${identity.actorId}::text,'grant',${identity.allowedCaller}::text,'at',clock_timestamp())
        WHERE id=${row.id} AND expires_at > clock_timestamp() RETURNING id`;
        if (!updated.length) error(409, 'Expired');
        return view(await record(tx, row.agent_id, row.id));
      }),
    );
  });
  app.post(path + '/:id/cancel', async (c) =>
    c.json(
      await access(c, async (tx, row, identity) => {
        if (!isRequester(row, identity) || !identity.scopes.includes('a2a:task.cancel')) missing();
        if (row.state === 'cancelled') return view(row);
        if (row.expired || !['pending', 'approved'].includes(row.state))
          error(409, 'Already expired or consumed');
        await tx`UPDATE infra.operation_requests SET state='cancelled', history=history||jsonb_build_object(
      'event','cancelled','by',${identity.principalId}::text,'actor',${identity.actorId}::text,'grant',${identity.allowedCaller}::text,'at',clock_timestamp()) WHERE id=${row.id}`;
        return view(await record(tx, row.agent_id, row.id));
      }),
    ),
  );

  function worker(c: Context) {
    const raw = token(c);
    if (!raw) error(401, 'Invalid executor credential');
    const digest = Buffer.from(hash(raw), 'hex');
    const policy = policies.find(
      (p) =>
        p.agentId === c.req.param('agent') &&
        p.operation === c.req.param('operation') &&
        timingSafeEqual(digest, Buffer.from(p.executorTokenSha256, 'hex')),
    );
    return policy ?? error(401, 'Invalid executor credential');
  }
  app.post(workerPath + '/claim', async (c) =>
    c.json(
      await db.begin(async (tx) => {
        const p = worker(c);
        // A credential from a previous ownership revision can reconcile its
        // existing effects, but has no authority to acquire new work.
        if (p !== policyFor(p.agentId, p.operation, await ownerFor(tx, p.agentId))) missing();
        // One irrevocable claim; a lost HTTP response can require reconciliation,
        // but cannot cause a second dispatch. Removed grants invalidate queued jobs.
        const [row] = await tx<RequestRow[]>`WITH candidate AS (
      SELECT r.id FROM infra.operation_requests r JOIN agents a ON a.id=r.agent_id
      WHERE r.agent_id=${p.agentId} AND r.operation=${p.operation} AND r.state='approved'
      AND r.decided_principal <> r.requester
      AND r.grant_key=ANY(a.allowed_callers) AND r.decided_by=ANY(a.allowed_callers)
      AND r.policy_digest=${policyDigest(p)} AND r.expires_at > clock_timestamp()
      ORDER BY r.expires_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED)
      UPDATE infra.operation_requests r SET state='executing', history=history||jsonb_build_object(
      'event','claimed','at',clock_timestamp()) FROM candidate c WHERE r.id=c.id
      AND r.expires_at > clock_timestamp() RETURNING r.*,false AS expired`;
        return { operation: row ? view(row) : null };
      }),
    ),
  );
  app.get(workerPath + '/unresolved', async (c) =>
    c.json(
      await db.begin(async (tx) => {
        const p = worker(c);
        const after = c.req.query('after') ?? null;
        if (after && !z.string().uuid().safeParse(after).success) error(400, 'Invalid cursor');
        const rows = await tx<RequestRow[]>`SELECT *, false AS expired FROM infra.operation_requests
          WHERE agent_id=${p.agentId} AND operation=${p.operation} AND agent_owner=${p.ownerPrincipal}
          AND owner_revision=${p.ownerRevision} AND executor_id=${p.executorId}
          AND state IN ('executing','unknown') AND (${after}::uuid IS NULL OR id > ${after}::uuid)
          ORDER BY id LIMIT 101`;
        return {
          operations: rows.slice(0, 100).map(view),
          next: rows.length > 100 ? rows[99].id : null,
        };
      }),
    ),
  );
  app.post(workerPath + '/:id/result', async (c) => {
    const input = await body(c, outcome);
    return c.json(
      await db.begin(async (tx) => {
        const p = worker(c);
        const row = await record(tx, p.agentId, c.req.param('id')!, true);
        if (
          row.operation !== p.operation ||
          row.agent_owner !== p.ownerPrincipal ||
          Number(row.owner_revision) !== p.ownerRevision ||
          row.executor_id !== p.executorId
        )
          missing();
        if (row.state === input.state && row.result === input.result) return view(row);
        if (!['executing', 'unknown'].includes(row.state)) error(409, 'No unresolved execution');
        await tx`UPDATE infra.operation_requests SET state=${input.state}, result=${input.result},
        history=history||jsonb_build_object('event',${input.state}::text,'at',clock_timestamp())
        WHERE id=${row.id}`;
        return view(await record(tx, row.agent_id, row.id));
      }),
    );
  });
}
