import { createHash, randomBytes } from 'node:crypto';
import {
  CallerAttestationV2,
  type CallerAttestationV2 as CallerAttestationV2Value,
} from '@vicoop-bridge/protocol';
import type { Sql } from '../db.js';
import { OAUTH_FEDERATION_ACCESS_TOKEN_PREFIX } from './profile.js';

export interface FederatedAccessToken {
  tokenId: string;
  agentId: string;
  resource: string;
  principalId: string;
  actorId: string;
  allowedCaller: string;
  attestation?: CallerAttestationV2Value;
  scopes: string[];
  taskId?: string;
  expiresAt: Date;
}

export interface FederatedTaskAuthorization {
  principalId?: string;
  actorId?: string;
  authorizationKey?: string;
}

export class FederatedTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederatedTokenError';
  }
}

export class FederatedReplayError extends Error {
  constructor() {
    super('OAuth federation assertion replayed');
    this.name = 'FederatedReplayError';
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function federationReplayDigest(issuer: string, jti: string): Buffer {
  return createHash('sha256')
    .update(`${Buffer.byteLength(issuer)}:${issuer}`)
    .update(`${Buffer.byteLength(jti)}:${jti}`)
    .digest();
}

export async function consumeFederationReplays(
  sql: Sql,
  tuples: Array<{ issuer: string; jti: string; expiresAt: Date }>,
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const tuple of tuples) {
      const digest = federationReplayDigest(tuple.issuer, tuple.jti);
      const rows = await tx<{ digest: Buffer }[]>`
        INSERT INTO infra.oauth_federation_replays (digest, expires_at)
        VALUES (${digest}, ${tuple.expiresAt})
        ON CONFLICT (digest) DO NOTHING
        RETURNING digest
      `;
      // Throwing rolls the transaction back, so a replay in either assertion
      // cannot partially consume the other assertion's fresh jti.
      if (rows.length !== 1) throw new FederatedReplayError();
    }
  });
}

export async function issueFederatedAccessToken(
  sql: Sql,
  input: {
    agentId: string;
    resource: string;
    principalId: string;
    actorId: string;
    allowedCaller: string;
    attestation?: CallerAttestationV2Value;
    scopes: string[];
    taskId?: string;
    expiresAt: Date;
  },
): Promise<{ rawToken: string; token: FederatedAccessToken }> {
  const rawToken = OAUTH_FEDERATION_ACCESS_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const rows = await sql<{ id: string }[]>`
    INSERT INTO infra.oauth_federation_access_tokens
      (token_hash, agent_id, resource, principal_id, actor_id, allowed_caller,
       attestation, scopes, task_id, expires_at)
    SELECT
      ${hashToken(rawToken)}, a.id, ${input.resource}, ${input.principalId},
      ${input.actorId}, ${input.allowedCaller},
      ${input.attestation ? JSON.stringify(input.attestation) : null}::jsonb,
      ${input.scopes}, ${input.taskId ?? null}, ${input.expiresAt}
    FROM agents a
    WHERE a.id = ${input.agentId}
      AND ${input.allowedCaller} = ANY(a.allowed_callers)
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new FederatedTokenError('Failed to persist OAuth federation access token');
  return {
    rawToken,
    token: {
      tokenId: id,
      agentId: input.agentId,
      resource: input.resource,
      principalId: input.principalId,
      actorId: input.actorId,
      allowedCaller: input.allowedCaller,
      ...(input.attestation !== undefined ? { attestation: input.attestation } : {}),
      scopes: input.scopes,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      expiresAt: input.expiresAt,
    },
  };
}

export async function verifyFederatedAccessToken(
  sql: Sql,
  rawToken: string,
  expectedAgentId: string,
): Promise<FederatedAccessToken> {
  if (!rawToken.startsWith(OAUTH_FEDERATION_ACCESS_TOKEN_PREFIX)) {
    throw new FederatedTokenError('Invalid OAuth federation token format');
  }
  const rows = await sql<{
    id: string;
    agent_id: string;
    resource: string | null;
    principal_id: string | null;
    actor_id: string;
    allowed_caller: string | null;
    attestation: unknown | null;
    scopes: string[];
    task_id: string | null;
    expires_at: Date;
    revoked: boolean;
    policy_active: boolean;
  }[]>`
    SELECT t.id, t.agent_id, t.resource, t.principal_id, t.actor_id,
           t.allowed_caller, t.attestation, t.scopes, t.task_id,
           t.expires_at, t.revoked,
           (t.allowed_caller = ANY(a.allowed_callers)) AS policy_active
    FROM infra.oauth_federation_access_tokens t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.token_hash = ${hashToken(rawToken)}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new FederatedTokenError('OAuth federation token not found');
  if (row.agent_id !== expectedAgentId) {
    throw new FederatedTokenError('OAuth federation token resource mismatch');
  }
  if (row.resource === null || row.principal_id === null || row.allowed_caller === null) {
    throw new FederatedTokenError('OAuth federation token has incomplete authorization context');
  }
  if (row.revoked || row.expires_at.getTime() <= Date.now()) {
    throw new FederatedTokenError('OAuth federation token expired or revoked');
  }
  if (!row.policy_active) {
    throw new FederatedTokenError('OAuth federation authorization was removed');
  }
  const attestation =
    row.attestation === null ? undefined : CallerAttestationV2.safeParse(row.attestation);
  if (attestation !== undefined && !attestation.success) {
    throw new FederatedTokenError('OAuth federation token has invalid normalized context');
  }
  // Observability only; never fail an otherwise valid request because this
  // best-effort stamp could not be written.
  void sql`
    UPDATE infra.oauth_federation_access_tokens SET last_used_at = now()
    WHERE id = ${row.id}
  `.catch(() => undefined);
  return {
    tokenId: row.id,
    agentId: row.agent_id,
    resource: row.resource,
    principalId: row.principal_id,
    actorId: row.actor_id,
    allowedCaller: row.allowed_caller,
    ...(attestation?.success === true ? { attestation: attestation.data } : {}),
    scopes: row.scopes,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    expiresAt: row.expires_at,
  };
}

export async function revokeFederatedAccessTokenByRaw(
  sql: Sql,
  rawToken: string,
): Promise<void> {
  if (!rawToken.startsWith(OAUTH_FEDERATION_ACCESS_TOKEN_PREFIX)) return;
  await sql`
    UPDATE infra.oauth_federation_access_tokens
    SET revoked = true
    WHERE token_hash = ${hashToken(rawToken)}
  `;
}

export async function loadFederatedTaskAuthorization(
  sql: Sql,
  agentId: string,
  taskId: string,
): Promise<FederatedTaskAuthorization | null> {
  const rows = await sql<{
    owner_principal: string | null;
    owner_actor: string | null;
    authorization_key: string | null;
  }[]>`
    SELECT owner_principal, owner_actor, authorization_key
    FROM infra.a2a_tasks
    WHERE owner_agent = ${agentId} AND task_id = ${taskId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...(row.owner_principal !== null ? { principalId: row.owner_principal } : {}),
    ...(row.owner_actor !== null ? { actorId: row.owner_actor } : {}),
    ...(row.authorization_key !== null ? { authorizationKey: row.authorization_key } : {}),
  };
}

export async function isFederatedAuthorizationActive(
  sql: Sql,
  agentId: string,
  authorizationKey: string,
): Promise<boolean> {
  const rows = await sql<{ active: boolean }[]>`
    SELECT (${authorizationKey} = ANY(allowed_callers)) AS active
    FROM agents WHERE id = ${agentId}
  `;
  return rows[0]?.active === true;
}

export async function agentHasFederatedTaskBindings(
  sql: Sql,
  agentId: string,
): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM infra.a2a_tasks
      WHERE owner_agent = ${agentId} AND authorization_key IS NOT NULL
    ) AS present
  `;
  return rows[0]?.present === true;
}

export async function sweepExpiredFederationState(sql: Sql): Promise<{
  tokens: number;
  replays: number;
}> {
  const tokens = await sql`
    DELETE FROM infra.oauth_federation_access_tokens
    WHERE expires_at <= now() OR revoked = true
  `;
  const replays = await sql`
    DELETE FROM infra.oauth_federation_replays WHERE expires_at <= now()
  `;
  return { tokens: tokens.count, replays: replays.count };
}
