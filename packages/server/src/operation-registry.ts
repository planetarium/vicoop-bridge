import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { MAX_OPERATION_FIELDS } from '@vicoop-bridge/protocol';
import { isOAuthFederationMethodUri } from '@mentionable/connector-kit';
import { operationCallerScheme, operationOperatorMethod } from './operation-callers.js';
import type postgres from 'postgres';
import { hashCallerToken } from './auth/caller-token.js';
import type { Sql, SqlExecutor } from './db.js';

const maxActiveDefinitions = 256;
export const operationName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const operationScalar = z.union([z.string().max(2048), z.number().int().safe(), z.boolean()]);
const definition = z
  .object({
    agentId: z.string().min(1),
    ownerPrincipal: z.string().min(1),
    operation: operationName,
    version: z.string().min(1).max(128),
    executorId: operationName,
    ownerRevision: z.number().int().nonnegative().safe(),
    ttlSeconds: z.number().int().min(3600).max(604800),
    executorTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    operators: z
      .array(
        z
          .object({
            principalId: z.string().min(1),
            actorId: z.string().min(1).optional(),
            method: z.string().max(256).refine(isOAuthFederationMethodUri).optional(),
          })
          .strict().refine(operator => operationCallerScheme(operator) !== undefined,
            { message: 'Direct operators require a canonical Google or SIWE principal' })
          .refine(operator => operator.method === undefined || operator.actorId !== undefined,
            { message: 'Only federated operators have an authentication method' }),
      )
      .min(1),
    fields: z.record(
      operationName,
      z
        .object({
          type: z.enum(['string', 'integer', 'boolean']),
          allowedValues: z.array(operationScalar).min(1).optional(),
        })
        .strict(),
    ).refine(fields => Object.keys(fields).length <= MAX_OPERATION_FIELDS),
  })
  .strict();
export type OperationDefinition = z.infer<typeof definition>;

export function readOperationRegistry(raw: string | undefined): OperationDefinition[] {
  if (!raw) return [];
  const entries = z.array(definition).max(maxActiveDefinitions).parse(JSON.parse(raw));
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

export function policyDigest(policy: OperationDefinition) {
  // Credential rotation preserves the identity of this named executor.
  const { executorTokenSha256: _credential, ...definition } = policy;
  // Materialize the method even for policies passed directly to mountOperations.
  // A previously method-unbound federation policy must get a new digest.
  const operators = policy.operators.map(operator => ({
    ...operator, method: operationOperatorMethod(operator),
  }));
  return hash(canonicalOperationJson({ ...definition, operators }));
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const canonicalOperationJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

// Cancel requests whose policy is absent from the legacy import.
export async function reconcileOperationPolicies(db: SqlExecutor, policies: OperationDefinition[]) {
  const hashes = policies.map(policyDigest);
  await db`UPDATE infra.operation_requests SET state='cancelled', result='Operation policy changed',
    history=history||jsonb_build_object('event', 'policy_changed', 'at',clock_timestamp())
    WHERE state IN ('pending','approved') AND expires_at > clock_timestamp()
    AND NOT (policy_digest = ANY(${hashes}::text[]))`;
}

const ownerInput = definition.omit({ agentId: true, ownerPrincipal: true, ownerRevision: true, operation: true });
type Entry = { definition: OperationDefinition; active: boolean };

export async function activeDefinitions(db: SqlExecutor, agent: string, operation?: string) {
  const rows = await db<Entry[]>`SELECT d.definition FROM infra.operation_definitions d
    JOIN agents a ON a.id=d.agent_id AND a.owner_revision=d.owner_revision
    WHERE d.agent_id=${agent} AND d.active
    ${operation === undefined ? db`` : db`AND d.operation=${operation}`}
    ORDER BY d.operation`;
  return rows.map(row => row.definition);
}

export type OperationPolicyRef = Pick<OperationDefinition, 'agentId' | 'ownerPrincipal' | 'ownerRevision' | 'operation'>;
export async function operationPolicyRefs(db: SqlExecutor, agent: string): Promise<OperationPolicyRef[]> {
  return db<OperationPolicyRef[]>`SELECT d.agent_id AS "agentId", a.owner_principal AS "ownerPrincipal",
    a.owner_revision::float8 AS "ownerRevision", d.operation FROM infra.operation_definitions d
    JOIN agents a ON a.id=d.agent_id AND a.owner_revision=d.owner_revision
    WHERE d.agent_id=${agent} AND d.active ORDER BY d.operation`;
}

export async function executorDefinition(db: SqlExecutor, agent: string, operation: string, digest: string) {
  const [row] = await db<Entry[]>`SELECT definition, active FROM infra.operation_definitions
    WHERE agent_id=${agent} AND operation=${operation} AND token_digest=${digest} AND credential_enabled`;
  return row;
}

// The caller holds the agent row FOR UPDATE. Registration, decisions and
// executor claims hold it FOR SHARE, giving edits one order with ledger writes.
async function storeDefinition(tx: SqlExecutor, p: OperationDefinition, active: boolean) {
  const [reserved] = await tx<{owner_revision: string; executor_id: string}[]>`SELECT owner_revision, executor_id
    FROM infra.operation_definitions WHERE agent_id=${p.agentId} AND operation=${p.operation}
      AND token_digest=${p.executorTokenSha256}`;
  if (reserved && (Number(reserved.owner_revision) !== p.ownerRevision || reserved.executor_id !== p.executorId)) {
    throw new HTTPException(409, { message: 'Choose a new credential for this executor identity' });
  }
  await tx`UPDATE infra.operation_definitions SET active=false,
    credential_enabled=credential_enabled AND executor_id<>${p.executorId}
    WHERE agent_id=${p.agentId} AND operation=${p.operation} AND owner_revision=${p.ownerRevision}
    AND (active OR (credential_enabled AND executor_id=${p.executorId}))`;
  await tx`INSERT INTO infra.operation_definitions
    (agent_id,operation,owner_revision,executor_id,token_digest,definition,active)
    VALUES (${p.agentId},${p.operation},${p.ownerRevision},${p.executorId},${p.executorTokenSha256},${tx.json(p)},${active})
    ON CONFLICT (agent_id,operation,token_digest) DO UPDATE SET
      definition=EXCLUDED.definition, active=EXCLUDED.active, credential_enabled=true`;
}

async function invalidateQueued(tx: SqlExecutor, agent: string, operation: string, digest?: string) {
  await tx`UPDATE infra.operation_requests SET state='cancelled', result='Operation policy changed',
    history=history||jsonb_build_object('event','policy_changed','at',clock_timestamp())
    WHERE agent_id=${agent} AND operation=${operation} AND state IN ('pending','approved')
    AND expires_at>clock_timestamp() AND policy_digest IS DISTINCT FROM ${digest ?? null}`;
}

// Run inside a transaction. A stale deployment environment must never
// overwrite an owner's later changes (including retirement) on a replica restart.
export async function migrateOperationRegistry(tx: postgres.TransactionSql, legacy: string | undefined) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('vicoop-bridge:operation-registry-migration'))`;
  if ((await tx`SELECT singleton FROM infra.operation_registry_migration`).length) return;
  if (!legacy && (await tx`SELECT id FROM infra.operation_requests
    WHERE state IN ('executing','unknown') OR (state IN ('pending','approved') AND expires_at>clock_timestamp()) LIMIT 1`).length) {
    throw new Error('Set VICOOP_OPERATIONS for the one-time registry migration (use [] for an intentionally empty legacy registry)');
  }
  const policies = readOperationRegistry(legacy);
  const active = [];
  for (const p of policies) {
    const [a] = await tx`SELECT owner_principal, owner_revision FROM agents WHERE id=${p.agentId} FOR UPDATE`;
    if (!a || p.ownerRevision > Number(a.owner_revision) ||
      (p.ownerRevision === Number(a.owner_revision) && p.ownerPrincipal !== a.owner_principal)) {
      throw new Error(`Legacy operation ${p.agentId}/${p.operation} does not match an existing ownership epoch`);
    }
    const current = p.ownerRevision === Number(a.owner_revision);
    await storeDefinition(tx, p, current);
    if (current) active.push(p);
  }
  await reconcileOperationPolicies(tx, active);
  await tx`INSERT INTO infra.operation_registry_migration VALUES (true)`;
}

type OwnerSession = { ok: true; principalId: string; bearerToken: string } | { ok: false; message: string };

export function mountOperationRegistry(app: Hono, db: Sql, authenticate: (c: Context) => Promise<OwnerSession>) {
  const base = '/admin-api/agents/:agent/operations';
  const item = base + '/:operation';
  const handle = async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticate(c);
    if (!auth.ok) return c.json({ error: auth.message }, 401);
    const agent = c.req.param('agent')!;
    const operation = c.req.param('operation');
    if (operation !== undefined && !operationName.safeParse(operation).success) {
      return c.json({ error: 'Invalid operation name' }, 400);
    }
    const input = c.req.method === 'PUT' ? ownerInput.safeParse(await c.req.json().catch(() => null)) : undefined;
    if (input && !input.success) return c.json({ error: 'Invalid operation definition' }, 400);
    return db.begin(async tx => {
      const [owner] = await tx<{owner_revision: string}[]>`SELECT owner_revision FROM agents
        WHERE id=${agent} AND owner_principal=${auth.principalId}
        ${c.req.method === 'GET' ? tx`FOR SHARE` : tx`FOR UPDATE`}`;
      if (!owner) return c.json({ error: 'Agent not found' }, 404);
      // The HTTP session cache may outlive a revocation. Validate the locked
      // credential after waiting for the agent lock, using time at acquisition.
      const [session] = await tx`WITH locked AS MATERIALIZED (
        SELECT principal_id, audience, revoked, expires_at FROM callers
        WHERE token_hash=${hashCallerToken(auth.bearerToken)} FOR SHARE
      ) SELECT 1 FROM locked WHERE principal_id=${auth.principalId} AND audience='owner_session'
        AND NOT revoked AND expires_at>clock_timestamp()`;
      if (!session) return c.json({ error: 'Owner session is no longer valid' }, 401);
      const policies = await activeDefinitions(tx, agent, operation);
      if (!operation) return c.json({ operations: policies });
      if (input?.success) {
        if (!policies.length) {
          const [row] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM infra.operation_definitions
            WHERE agent_id=${agent} AND owner_revision=${owner.owner_revision} AND active`;
          if (row.count >= maxActiveDefinitions) {
            return c.json({ error: `An agent can have up to ${maxActiveDefinitions} active operations` }, 409);
          }
        }
        const policy = { ...input.data, agentId: agent, ownerPrincipal: auth.principalId,
          ownerRevision: Number(owner.owner_revision), operation };
        await storeDefinition(tx, policy, true);
        await invalidateQueued(tx, agent, operation, policyDigest(policy));
        return c.json(policy, policies.length ? 200 : 201);
      }
      if (!policies.length) return c.json({ error: 'Operation not found' }, 404);
      if (c.req.method === 'DELETE') {
        await tx`UPDATE infra.operation_definitions SET active=false
          WHERE agent_id=${agent} AND owner_revision=${owner.owner_revision} AND operation=${operation} AND active`;
        await invalidateQueued(tx, agent, operation);
        return c.body(null, 204);
      }
      return c.json(policies[0]);
    });
  };
  app.get(base, handle);
  app.get(item, handle);
  app.put(item, bodyLimit({ maxSize: 64 * 1024 }), handle);
  app.delete(item, handle);
}
