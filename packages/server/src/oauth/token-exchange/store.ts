import { createHash, randomBytes } from 'node:crypto';
import {
  CallerAttestationV2,
  type CallerAttestationV2 as CallerAttestationV2Value,
} from '@vicoop-bridge/protocol';
import type { Sql } from '../../db.js';
import { TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX } from './types.js';

export interface TokenExchangeAccessToken {
  tokenId: string;
  profileId: string;
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

export interface TokenExchangeTaskAuthorization {
  principalId?: string;
  actorId?: string;
  profileId?: string;
  authorizationKey?: string;
}

export class TokenExchangeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExchangeTokenError';
  }
}

export class TokenExchangeReplayError extends Error {
  constructor() {
    super('OAuth token-exchange assertion replayed');
    this.name = 'TokenExchangeReplayError';
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function tokenExchangeReplayDigest(profileId: string, issuer: string, jti: string): Buffer {
  return createHash('sha256')
    .update(`${Buffer.byteLength(profileId)}:${profileId}`)
    .update(`${Buffer.byteLength(issuer)}:${issuer}`)
    .update(`${Buffer.byteLength(jti)}:${jti}`)
    .digest();
}

export async function consumeTokenExchangeReplays(
  sql: Sql,
  profileId: string,
  tuples: Array<{ issuer: string; jti: string; expiresAt: Date }>,
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const tuple of tuples) {
      const digest = tokenExchangeReplayDigest(profileId, tuple.issuer, tuple.jti);
      const rows = await tx<{ digest: Buffer }[]>`
        INSERT INTO infra.oauth_token_exchange_replays (digest, profile_id, expires_at)
        VALUES (${digest}, ${profileId}, ${tuple.expiresAt})
        ON CONFLICT (digest) DO NOTHING
        RETURNING digest
      `;
      // Throwing rolls the transaction back, so a replay in either assertion
      // cannot partially consume the other assertion's fresh jti.
      if (rows.length !== 1) throw new TokenExchangeReplayError();
    }
  });
}

export async function issueTokenExchangeAccessToken(
  sql: Sql,
  input: {
    profileId: string;
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
): Promise<{ rawToken: string; token: TokenExchangeAccessToken }> {
  const rawToken = TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const rows = await sql<{ id: string }[]>`
    INSERT INTO infra.oauth_token_exchange_access_tokens
      (token_hash, profile_id, agent_id, resource, principal_id, actor_id, allowed_caller,
       attestation, scopes, task_id, expires_at)
    SELECT
      ${hashToken(rawToken)}, ${input.profileId}, a.id, ${input.resource}, ${input.principalId},
      ${input.actorId}, ${input.allowedCaller},
      ${input.attestation ? JSON.stringify(input.attestation) : null}::jsonb,
      ${input.scopes}, ${input.taskId ?? null}, ${input.expiresAt}
    FROM agents a
    WHERE a.id = ${input.agentId}
      AND ${input.allowedCaller} = ANY(a.allowed_callers)
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new TokenExchangeTokenError('Failed to persist OAuth token-exchange access token');
  return {
    rawToken,
    token: {
      tokenId: id,
      profileId: input.profileId,
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

export async function verifyTokenExchangeAccessToken(
  sql: Sql,
  rawToken: string,
  expectedAgentId: string,
): Promise<TokenExchangeAccessToken> {
  if (!rawToken.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)) {
    throw new TokenExchangeTokenError('Invalid OAuth token-exchange token format');
  }
  const rows = await sql<
    {
      id: string;
      profile_id: string;
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
    }[]
  >`
    SELECT t.id, t.profile_id, t.agent_id, t.resource, t.principal_id, t.actor_id,
           t.allowed_caller, t.attestation, t.scopes, t.task_id,
           t.expires_at, t.revoked,
           (t.allowed_caller = ANY(a.allowed_callers)) AS policy_active
    FROM infra.oauth_token_exchange_access_tokens t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.token_hash = ${hashToken(rawToken)}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new TokenExchangeTokenError('OAuth token-exchange token not found');
  if (row.agent_id !== expectedAgentId) {
    throw new TokenExchangeTokenError('OAuth token-exchange token resource mismatch');
  }
  if (row.resource === null || row.principal_id === null || row.allowed_caller === null) {
    throw new TokenExchangeTokenError(
      'OAuth token-exchange token has incomplete authorization context',
    );
  }
  if (row.revoked || row.expires_at.getTime() <= Date.now()) {
    throw new TokenExchangeTokenError('OAuth token-exchange token expired or revoked');
  }
  if (!row.policy_active) {
    throw new TokenExchangeTokenError('OAuth token-exchange authorization was removed');
  }
  const attestation =
    row.attestation === null ? undefined : CallerAttestationV2.safeParse(row.attestation);
  if (attestation !== undefined && !attestation.success) {
    throw new TokenExchangeTokenError('OAuth token-exchange token has invalid normalized context');
  }
  // Observability only; never fail an otherwise valid request because this
  // best-effort stamp could not be written.
  void sql`
    UPDATE infra.oauth_token_exchange_access_tokens SET last_used_at = now()
    WHERE id = ${row.id}
  `.catch(() => undefined);
  return {
    tokenId: row.id,
    profileId: row.profile_id,
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

export async function revokeTokenExchangeAccessTokenByRaw(
  sql: Sql,
  rawToken: string,
): Promise<void> {
  if (!rawToken.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)) return;
  await sql`
    UPDATE infra.oauth_token_exchange_access_tokens
    SET revoked = true
    WHERE token_hash = ${hashToken(rawToken)}
  `;
}

export async function loadTokenExchangeTaskAuthorization(
  sql: Sql,
  agentId: string,
  taskId: string,
): Promise<TokenExchangeTaskAuthorization | null> {
  const rows = await sql<
    {
      owner_principal: string | null;
      owner_actor: string | null;
      authorization_profile: string | null;
      authorization_key: string | null;
    }[]
  >`
    SELECT owner_principal, owner_actor, authorization_profile, authorization_key
    FROM infra.a2a_tasks
    WHERE owner_agent = ${agentId} AND task_id = ${taskId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...(row.owner_principal !== null ? { principalId: row.owner_principal } : {}),
    ...(row.owner_actor !== null ? { actorId: row.owner_actor } : {}),
    ...(row.authorization_profile !== null ? { profileId: row.authorization_profile } : {}),
    ...(row.authorization_key !== null ? { authorizationKey: row.authorization_key } : {}),
  };
}

export async function isTokenExchangeAuthorizationActive(
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

export async function agentHasTokenExchangeTaskBindings(
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

export async function sweepExpiredTokenExchangeState(sql: Sql): Promise<{
  tokens: number;
  replays: number;
}> {
  const tokens = await sql`
    DELETE FROM infra.oauth_token_exchange_access_tokens
    WHERE expires_at <= now() OR revoked = true
  `;
  const replays = await sql`
    DELETE FROM infra.oauth_token_exchange_replays WHERE expires_at <= now()
  `;
  return { tokens: tokens.count, replays: replays.count };
}
