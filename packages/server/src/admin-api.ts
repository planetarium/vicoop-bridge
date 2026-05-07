// Deterministic admin operations exposed by the admin agent's LLM tools and
// by the /admin-api/* HTTP routes. Centralising the logic here means both
// callers share the same RLS handling, registry hot-reload, and idempotency
// rules — without an LLM round-trip on the HTTP path.

import type postgres from 'postgres';
import type { Sql } from './db.js';
import type { Registry } from './registry.js';
import { validatePrincipal } from './auth/principal.js';
import { isAdmin } from './admin-scope.js';

type Tx = postgres.TransactionSql;

export class AdminApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export interface CallerListResult {
  agent_id: string;
  owner_principal: string;
  allowed_callers: string[];
  is_public: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface CallerMutationResult {
  agent_id: string;
  principal: string;
  allowed_callers: string[];
  /** Set when the operation was a no-op (principal already present / already absent). */
  message?: string;
}

export interface ActiveAgentInfo {
  agent_id: string;
  client_id: string;
  agent_name: string;
  allowed_callers: string[];
  connected_at: string;
}

function adminAddresses(): string {
  return process.env.ADMIN_WALLET_ADDRESSES ?? '';
}

// Sets the per-transaction RLS context the operator's row-level predicates
// need. `app.admin_addresses` is read by the SQL helper that implements
// is_admin() in the database, so it must match the in-process adminWallets
// set used by isAdmin(). Call inside a db.begin() block before issuing the
// real query so it stays within the same transaction.
async function setRlsContext(tx: Tx, principalId: string): Promise<void> {
  await tx`SELECT set_config('role', 'app_authenticated', true)`;
  await tx`SELECT set_config('jwt.claims.principal_id', ${principalId}, true)`;
  await tx`SELECT set_config('app.admin_addresses', ${adminAddresses()}, true)`;
}

export async function addCaller(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
  principal: string,
): Promise<CallerMutationResult> {
  const normalized = validatePrincipal(principal);
  if (!normalized) {
    throw new AdminApiError(
      'Invalid principal format. Expected eth:0x<40 hex>, google:sub:<sub>, google:email:<addr>, or google:domain:<d>.',
      400,
    );
  }

  const result = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      UPDATE agent_policies
      SET allowed_callers = array_append(allowed_callers, ${normalized}),
          updated_at = now()
      WHERE agent_id = ${agentId}
        AND NOT (${normalized} = ANY(allowed_callers))
      RETURNING agent_id, owner_principal, allowed_callers
    `;
  });

  if (result.length === 0) {
    // Either: policy missing, principal already present, or RLS blocked the
    // update. Disambiguate with a follow-up SELECT (still under RLS).
    const existing = await db.begin(async (tx) => {
      await setRlsContext(tx, principalId);
      return tx`SELECT allowed_callers FROM agent_policies WHERE agent_id = ${agentId}`;
    });
    if (existing.length === 0) {
      throw new AdminApiError('Agent policy not found or not authorized.', 404);
    }
    const callers = existing[0].allowed_callers as string[];
    if (callers.includes(normalized)) {
      // Idempotent path also pushes the canonical DB state into the registry
      // so a stale in-memory copy (e.g. a missed caller-change notification)
      // converges on every call. Cheap; the registry update is a single map
      // assignment plus listener fan-out.
      registry.updateAllowedCallers(agentId, callers);
      return {
        agent_id: agentId,
        principal: normalized,
        allowed_callers: callers,
        message: 'Principal already in allowed callers',
      };
    }
    throw new AdminApiError('Not authorized to modify this agent policy.', 403);
  }

  const callers = result[0].allowed_callers as string[];
  registry.updateAllowedCallers(agentId, callers);
  return { agent_id: agentId, principal: normalized, allowed_callers: callers };
}

export async function removeCaller(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
  principal: string,
): Promise<CallerMutationResult> {
  const normalized = validatePrincipal(principal);
  if (!normalized) {
    throw new AdminApiError(
      'Invalid principal format. Expected eth:0x<40 hex>, google:sub:<sub>, google:email:<addr>, or google:domain:<d>.',
      400,
    );
  }

  const result = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      UPDATE agent_policies
      SET allowed_callers = array_remove(allowed_callers, ${normalized}),
          updated_at = now()
      WHERE agent_id = ${agentId}
        AND ${normalized} = ANY(allowed_callers)
      RETURNING agent_id, owner_principal, allowed_callers
    `;
  });

  if (result.length === 0) {
    const existing = await db.begin(async (tx) => {
      await setRlsContext(tx, principalId);
      return tx`SELECT allowed_callers FROM agent_policies WHERE agent_id = ${agentId}`;
    });
    if (existing.length === 0) {
      throw new AdminApiError('Agent policy not found or not authorized.', 404);
    }
    const callers = existing[0].allowed_callers as string[];
    // Same convergence as addCaller's no-op path: hot-reload the registry
    // even when nothing changed so a stale in-memory copy lines up with DB.
    registry.updateAllowedCallers(agentId, callers);
    return {
      agent_id: agentId,
      principal: normalized,
      allowed_callers: callers,
      message: 'Principal not in allowed callers',
    };
  }

  const callers = result[0].allowed_callers as string[];
  registry.updateAllowedCallers(agentId, callers);
  return { agent_id: agentId, principal: normalized, allowed_callers: callers };
}

export async function listCallers(
  db: Sql,
  principalId: string,
  agentId: string,
): Promise<CallerListResult> {
  const result = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      SELECT agent_id, owner_principal, allowed_callers, created_at, updated_at
      FROM agent_policies WHERE agent_id = ${agentId}
    `;
  });
  if (result.length === 0) {
    throw new AdminApiError('Agent policy not found.', 404);
  }
  const policy = result[0];
  const callers = policy.allowed_callers as string[];
  return {
    agent_id: policy.agent_id as string,
    owner_principal: policy.owner_principal as string,
    allowed_callers: callers,
    is_public: callers.length === 0,
    created_at: policy.created_at instanceof Date ? policy.created_at.toISOString() : policy.created_at as string | undefined,
    updated_at: policy.updated_at instanceof Date ? policy.updated_at.toISOString() : policy.updated_at as string | undefined,
  };
}

export function listActiveAgents(
  registry: Registry,
  principalId: string,
): ActiveAgentInfo[] {
  const admin = isAdmin(principalId);
  return registry.listAgents()
    .filter((a) => admin || a.ownerPrincipal === principalId)
    .map((a) => ({
      agent_id: a.agentId,
      client_id: a.clientId,
      agent_name: a.agentCard.name,
      allowed_callers: a.allowedCallers,
      connected_at: new Date(a.connectedAt).toISOString(),
    }));
}
