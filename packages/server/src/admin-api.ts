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

// Single source of truth for the invalid-principal 400 message. Must stay
// aligned with the formats validatePrincipal() accepts in auth/principal.ts —
// in particular a plain `0x<40 hex>` (no eth: prefix) is normalized to
// eth:0x<…>, so operators hitting this error need to know that's a valid
// input form.
const INVALID_PRINCIPAL_MESSAGE =
  'Invalid principal format. Expected eth:0x<40 hex>, 0x<40 hex>, ' +
  'google:sub:<sub>, google:email:<addr>, or google:domain:<d>.';

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
    throw new AdminApiError(INVALID_PRINCIPAL_MESSAGE, 400);
  }

  const updateExisting = async (): Promise<CallerMutationResult | null> => {
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
    if (result.length > 0) {
      const callers = result[0].allowed_callers as string[];
      registry.updateAllowedCallers(agentId, callers);
      return { agent_id: agentId, principal: normalized, allowed_callers: callers };
    }

    const existing = await db.begin(async (tx) => {
      await setRlsContext(tx, principalId);
      return tx`SELECT allowed_callers FROM agent_policies WHERE agent_id = ${agentId}`;
    });
    if (existing.length === 0) return null;

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
  };

  const updated = await updateExisting();
  if (updated) return updated;

  const created = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      WITH owning_client AS (
        SELECT id, owner_principal
        FROM clients
        WHERE ${agentId} = ANY(allowed_agent_ids)
          AND revoked = false
        ORDER BY created_at DESC
        LIMIT 1
      )
      INSERT INTO agent_policies (agent_id, owner_principal, client_id, allowed_callers)
      SELECT ${agentId}, owner_principal, id, ARRAY[${normalized}]::text[]
      FROM owning_client
      ON CONFLICT (agent_id) DO UPDATE
        SET allowed_callers = array_append(agent_policies.allowed_callers, ${normalized}),
            updated_at = now()
        WHERE NOT (${normalized} = ANY(agent_policies.allowed_callers))
      RETURNING agent_id, owner_principal, allowed_callers
    `;
  });
  if (created.length > 0) {
    const callers = created[0].allowed_callers as string[];
    registry.updateAllowedCallers(agentId, callers);
    return { agent_id: agentId, principal: normalized, allowed_callers: callers };
  }

  // Another process may have created the policy with this caller already in
  // place, or RLS may have blocked the conflict update. Retry the normal
  // update/idempotency path once so races converge before reporting 404.
  const retried = await updateExisting();
  if (retried) return retried;
  throw new AdminApiError('Agent policy not found or not authorized.', 404);
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
    throw new AdminApiError(INVALID_PRINCIPAL_MESSAGE, 400);
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

export interface ClientListItem {
  client_id: string;
  client_name: string;
  owner_principal: string;
  allowed_agent_ids: string[];
  revoked: boolean;
  created_at: string;
  /**
   * True iff at least one agent owned by this client is currently registered
   * in the in-memory WebSocket registry. Distinguishes orphaned `clients`
   * rows (daemon never started, or has since exited) from rows whose daemon
   * is alive — the original motivation for the issue.
   */
  connected: boolean;
}

export async function listClientsForOwner(
  db: Sql,
  registry: Registry,
  principalId: string,
): Promise<ClientListItem[]> {
  const rows = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      SELECT id, owner_principal, client_name, allowed_agent_ids, revoked, created_at
      FROM clients
      ORDER BY created_at DESC
    `;
  });

  // Build the set of client_ids whose agents are currently connected.
  // listAgents() returns the registry's in-memory view; deduplicating by
  // clientId keeps the set small even if a client has many agents bound.
  const connectedClientIds = new Set<string>();
  for (const conn of registry.listAgents()) {
    connectedClientIds.add(conn.clientId);
  }

  return rows.map((r) => ({
    client_id: r.id as string,
    client_name: r.client_name as string,
    owner_principal: r.owner_principal as string,
    allowed_agent_ids: (r.allowed_agent_ids as string[]) ?? [],
    revoked: r.revoked as boolean,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : (r.created_at as string),
    connected: connectedClientIds.has(r.id as string),
  }));
}

export interface RevokeClientResult {
  client_id: string;
  client_name: string;
  revoked: boolean;
  /** Number of live WebSocket connections closed as part of this revoke. */
  closed_connections: number;
}

// Resolve a CLI argument (either a UUID `client_id` or a `client_name`) to a
// unique client row owned by `principalId`. Returns 404 when nothing matches
// and a distinct 409 when a name is ambiguous, so the CLI can tell the user
// to retry with the id.
async function resolveClient(
  db: Sql,
  principalId: string,
  target: string,
): Promise<{ id: string; client_name: string }> {
  // Try id-match first — if `target` is a valid id and resolves to a row,
  // we're done. If it doesn't, fall through to name lookup. We deliberately
  // do NOT pre-filter on UUID shape: ids are TEXT in this schema (the table
  // happens to default-generate UUIDs, but the column is `TEXT PRIMARY KEY`),
  // so any string can in principle be an id.
  const byId = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`SELECT id, client_name FROM clients WHERE id = ${target}`;
  });
  if (byId.length === 1) {
    return { id: byId[0].id as string, client_name: byId[0].client_name as string };
  }

  const byName = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`SELECT id, client_name FROM clients WHERE client_name = ${target}`;
  });
  if (byName.length === 0) {
    throw new AdminApiError(`No client found matching "${target}".`, 404);
  }
  if (byName.length > 1) {
    const ids = byName.map((r) => r.id as string).join(', ');
    throw new AdminApiError(
      `Ambiguous client name "${target}" matches multiple clients (${ids}). ` +
        'Specify client_id instead.',
      409,
    );
  }
  return { id: byName[0].id as string, client_name: byName[0].client_name as string };
}

export async function revokeClientForOwner(
  db: Sql,
  registry: Registry,
  principalId: string,
  target: string,
): Promise<RevokeClientResult> {
  const resolved = await resolveClient(db, principalId, target);

  await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    // revoke_client() is SECURITY INVOKER and re-checks RLS; resolveClient()
    // already verified the row is visible to this principal so the UPDATE
    // inside will succeed (or NOT FOUND if a concurrent delete happened, in
    // which case the function raises — we let that propagate as 500 because
    // it's a genuinely unexpected race, not a user-facing error condition).
    await tx`SELECT revoke_client(${resolved.id})`;
  });

  // Close every live WebSocket session bound to this client. The daemon
  // sees close code 4012 and exits without reconnecting (see client.ts).
  const closedConnections = registry.disconnectClient(resolved.id);

  return {
    client_id: resolved.id,
    client_name: resolved.client_name,
    revoked: true,
    closed_connections: closedConnections,
  };
}
