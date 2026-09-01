// Deterministic admin operations exposed by the admin agent's LLM tools and
// by the /admin-api/* HTTP routes. Centralising the logic here means both
// callers share the same RLS handling, registry hot-reload, and idempotency
// rules — without an LLM round-trip on the HTTP path.

import type postgres from 'postgres';
import type { Sql } from './db.js';
import type { Registry } from './registry.js';
import {
  formatFederatedPrincipal,
  parseFederatedPrincipal,
  validatePrincipal,
  type FederatedPrincipalInput,
} from './auth/principal.js';
import { generateApiKeyId, issueSessionToken } from './auth/caller-token.js';
import { isAdmin } from './admin-scope.js';
import { notifyCallerPolicyChanged } from './caller-policy-watch.js';
import {
  X402PricingWriteSchema,
  formatPricingError,
  parseX402Pricing,
  type X402Pricing,
} from './x402/pricing.js';
import { notifyX402PricingChanged } from './x402/pricing-watch.js';

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
  'google:sub:<sub>, google:email:<addr>, google:domain:<d>, apikey:<id>, ' +
  'or a canonical federated:v1 principal.';

const INVALID_FEDERATED_CALLER_MESSAGE =
  'Invalid federated caller. Expected an exact did:web issuer, method, and subject ' +
  'whose canonical encoding is at most 512 bytes.';

export interface FederatedCallerResult extends FederatedPrincipalInput {
  principal: string;
}

export interface CallerListResult {
  agent_id: string;
  owner_principal: string;
  allowed_callers: string[];
  federated_callers: FederatedCallerResult[];
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
        UPDATE agents
        SET allowed_callers = array_append(allowed_callers, ${normalized}),
            updated_at = now()
        WHERE id = ${agentId}
          AND NOT (${normalized} = ANY(allowed_callers))
        RETURNING id AS agent_id, owner_principal, allowed_callers
      `;
    });
    if (result.length > 0) {
      const callers = result[0].allowed_callers as string[];
      registry.updateAllowedCallers(agentId, callers);
      await notifyCallerPolicyChanged(db, agentId);
      return { agent_id: agentId, principal: normalized, allowed_callers: callers };
    }

    const existing = await db.begin(async (tx) => {
      await setRlsContext(tx, principalId);
      return tx`SELECT allowed_callers FROM agents WHERE id = ${agentId}`;
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
    throw new AdminApiError('Not authorized to modify this agent.', 403);
  };

  const updated = await updateExisting();
  if (updated) return updated;

  throw new AdminApiError('Agent not found or not authorized.', 404);
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
      UPDATE agents
      SET allowed_callers = array_remove(allowed_callers, ${normalized}),
          updated_at = now()
      WHERE id = ${agentId}
        AND ${normalized} = ANY(allowed_callers)
      RETURNING id AS agent_id, owner_principal, allowed_callers
    `;
  });

  if (result.length === 0) {
    const existing = await db.begin(async (tx) => {
      await setRlsContext(tx, principalId);
      return tx`SELECT allowed_callers FROM agents WHERE id = ${agentId}`;
    });
    if (existing.length === 0) {
      throw new AdminApiError('Agent not found or not authorized.', 404);
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

  // Unify model (#308): an `apikey:<id>` principal IS a bridge-minted
  // credential, not an external identity. Removing it from the allowlist must
  // also kill the underlying token — otherwise the secret stays valid (just
  // unauthorized for this agent) and could be re-added elsewhere. Privileged
  // write; `callers` is server-only. No-op for eth/google principals, whose
  // session tokens are ephemeral and identity-scoped (de-authorizing the
  // identity in allowed_callers is sufficient).
  if (normalized.startsWith('apikey:')) {
    await db`
      UPDATE callers
      SET revoked = true
      WHERE provider = 'apikey' AND principal_id = ${normalized}
    `;
  }

  registry.updateAllowedCallers(agentId, callers);
  await notifyCallerPolicyChanged(db, agentId);
  return { agent_id: agentId, principal: normalized, allowed_callers: callers };
}

export async function addFederatedCaller(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
  input: FederatedPrincipalInput,
): Promise<CallerMutationResult> {
  const principal = formatFederatedPrincipal(input);
  if (!principal) throw new AdminApiError(INVALID_FEDERATED_CALLER_MESSAGE, 400);
  return addCaller(db, registry, principalId, agentId, principal);
}

export async function removeFederatedCaller(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
  input: FederatedPrincipalInput,
): Promise<CallerMutationResult> {
  const principal = formatFederatedPrincipal(input);
  if (!principal) throw new AdminApiError(INVALID_FEDERATED_CALLER_MESSAGE, 400);
  return removeCaller(db, registry, principalId, agentId, principal);
}

export async function listCallers(
  db: Sql,
  principalId: string,
  agentId: string,
): Promise<CallerListResult> {
  const result = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      SELECT id AS agent_id, owner_principal, allowed_callers, created_at, updated_at
      FROM agents WHERE id = ${agentId}
    `;
  });
  if (result.length === 0) {
    throw new AdminApiError('Agent not found.', 404);
  }
  const policy = result[0];
  const callers = policy.allowed_callers as string[];
  return {
    agent_id: policy.agent_id as string,
    owner_principal: policy.owner_principal as string,
    allowed_callers: callers,
    federated_callers: callers.flatMap((principal) => {
      const parsed = parseFederatedPrincipal(principal);
      return parsed ? [{ principal, ...parsed }] : [];
    }),
    is_public: callers.length === 0,
    created_at: policy.created_at instanceof Date ? policy.created_at.toISOString() : policy.created_at as string | undefined,
    updated_at: policy.updated_at instanceof Date ? policy.updated_at.toISOString() : policy.updated_at as string | undefined,
  };
}

// ----- x402 pricing ---------------------------------------------------------
//
// `agents.x402_pricing` is DB-owned rather than declared in the WS hello
// frame, because `payTo` names the wallet that receives money and the hello
// frame is authored by the connecting agent. That makes this the only write
// path, so it validates through the same `parseX402Pricing` the runtime uses:
// a bad address or a dollars-instead-of-atomic-units amount is rejected here,
// at write time, rather than silently disabling payments at the agent's next
// connect.

export interface X402PricingResult {
  agent_id: string;
  x402_pricing: X402Pricing | null;
}

export async function getX402Pricing(
  db: Sql,
  principalId: string,
  agentId: string,
): Promise<X402PricingResult> {
  const rows = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`SELECT id AS agent_id, x402_pricing FROM agents WHERE id = ${agentId}`;
  });
  if (rows.length === 0) throw new AdminApiError('Agent not found.', 404);

  // A row that fails to parse is reported rather than thrown: the operator
  // asking "what does this agent charge?" is exactly who needs to be told it
  // is currently unreadable (and therefore being served for free).
  let pricing: X402Pricing | null = null;
  try {
    pricing = parseX402Pricing(rows[0].x402_pricing) ?? null;
  } catch (err) {
    throw new AdminApiError(
      `Stored pricing for this agent is invalid and is being ignored at runtime: ${String(err)}`,
      409,
    );
  }
  return { agent_id: agentId, x402_pricing: pricing };
}

export async function setX402Pricing(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
  pricing: unknown,
): Promise<X402PricingResult> {
  // The strict schema: an unrecognized key fails here rather than being
  // dropped. Every optional field on a pricing object changes what is
  // charged, so a silently-ignored typo is a silently-wrong price.
  let parsed: X402Pricing;
  try {
    parsed = X402PricingWriteSchema.parse(pricing);
  } catch (err) {
    throw new AdminApiError(`Invalid x402 pricing: ${formatPricingError(err)}`, 400);
  }

  const rows = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      UPDATE agents
      SET x402_pricing = ${tx.json(JSON.parse(JSON.stringify(parsed)))},
          updated_at = now()
      WHERE id = ${agentId}
      RETURNING id AS agent_id
    `;
  });
  // RLS hides agents the operator doesn't own, so zero rows is
  // indistinguishable from "no such agent" — and deliberately so, since
  // distinguishing them would confirm the existence of someone else's agent.
  if (rows.length === 0) throw new AdminApiError('Agent not found or not authorized.', 404);

  // Patch this instance, then tell the others. The agent's WebSocket usually
  // lives on a different instance than the one that served this request, and
  // that one is the one whose cached pricing decides what the agent charges.
  registry.updateX402Pricing(agentId, parsed);
  await notifyX402PricingChanged(db, agentId);
  return { agent_id: agentId, x402_pricing: parsed };
}

export async function clearX402Pricing(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
): Promise<X402PricingResult> {
  const rows = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      UPDATE agents
      SET x402_pricing = NULL, updated_at = now()
      WHERE id = ${agentId}
      RETURNING id AS agent_id
    `;
  });
  if (rows.length === 0) throw new AdminApiError('Agent not found or not authorized.', 404);

  // The direction that matters most: an agent made free here must stop being
  // billed everywhere, not just on this instance.
  registry.updateX402Pricing(agentId, undefined);
  await notifyX402PricingChanged(db, agentId);
  return { agent_id: agentId, x402_pricing: null };
}

// ----- Static API keys (issue #308) -----------------------------------------
//
// An API key is a regular caller token (provider='apikey', audience='caller')
// whose principal is `apikey:<key-id>`, with that principal auto-added to the
// target agent's allowed_callers so the key authorizes exactly that agent and
// nothing else. Verification reuses the existing caller-token path entirely.
//
// Unified model: an API key is just "a caller the bridge minted a secret for",
// so the only apikey-specific operation is minting (issueAgentApiKey). Listing
// and de-authorizing fold into the regular caller surface — `agent callers
// list` shows `apikey:<id>` rows (TYPE=apikey) and `removeCaller` both drops
// the principal AND revokes the underlying token (see its apikey branch).
//
// RLS note: ownership is enforced against the `agents` table under the
// operator's app_authenticated context (RLS hides agents they don't own). The
// server-managed `callers` table has no app_authenticated policy (it is
// `@omit` / server-only), so its reads/writes go through the privileged
// top-level `db` connection, which bypasses RLS as the table owner. We scope
// those callers queries to principals we just read out of the owner's own
// agent row, so the privileged access never leaks another operator's keys.

const DEFAULT_API_KEY_TTL_DAYS = 365;
// Sanity cap so a typo (ttlDays: 100000) can't mint a de-facto immortal key.
const MAX_API_KEY_TTL_DAYS = 365 * 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ApiKeyIssueResult {
  agent_id: string;
  key_id: string;
  principal: string;
  /** Raw bearer token — shown exactly once; never recoverable afterwards. */
  api_key: string;
  label: string | null;
  expires_at: string;
  allowed_callers: string[];
}

// Append `principal` to an owned agent's allowed_callers under RLS and return
// the new array, or null if the agent is not visible to this principal (not
// found / not owned). Used by apikey issuance; listing/removal of keys goes
// through the unified `agent callers list` / `removeCaller` path.
async function appendAllowedCallerOwned(
  db: Sql,
  principalId: string,
  agentId: string,
  principal: string,
): Promise<string[] | null> {
  const rows = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`
      UPDATE agents
      SET allowed_callers = array_append(allowed_callers, ${principal}),
          updated_at = now()
      WHERE id = ${agentId}
      RETURNING allowed_callers
    `;
  });
  if (rows.length === 0) return null;
  return rows[0].allowed_callers as string[];
}

export async function issueAgentApiKey(
  db: Sql,
  registry: Registry,
  principalId: string,
  agentId: string,
  opts: { label?: string; ttlDays?: number },
): Promise<ApiKeyIssueResult> {
  const ttlDays = opts.ttlDays ?? DEFAULT_API_KEY_TTL_DAYS;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_API_KEY_TTL_DAYS) {
    throw new AdminApiError(
      `ttlDays must be an integer between 1 and ${MAX_API_KEY_TTL_DAYS}.`,
      400,
    );
  }
  const label = opts.label?.trim() ? opts.label.trim() : undefined;

  const keyId = generateApiKeyId();
  const principal = 'apikey:' + keyId;

  // Step 1: enforce ownership by appending under RLS. A non-owner sees no row
  // (RLS) → null → 404, and crucially no token is ever minted for them.
  const allowedCallers = await appendAllowedCallerOwned(db, principalId, agentId, principal);
  if (!allowedCallers) {
    throw new AdminApiError('Agent not found or not authorized.', 404);
  }

  // Step 2: mint the bearer token (privileged path; callers is server-only).
  // If this fails after the append, roll the principal back so we don't leave
  // an orphan entry in allowed_callers.
  let issued;
  try {
    issued = await issueSessionToken(db, {
      principalId: principal,
      provider: 'apikey',
      audience: 'caller',
      label,
      ttlMs: ttlDays * MS_PER_DAY,
    });
  } catch (err) {
    try {
      await db.begin(async (tx) => {
        await setRlsContext(tx, principalId);
        await tx`
          UPDATE agents
          SET allowed_callers = array_remove(allowed_callers, ${principal}),
              updated_at = now()
          WHERE id = ${agentId}
        `;
      });
    } catch {
      // Best-effort compensation; surface the original failure regardless.
    }
    throw err;
  }

  registry.updateAllowedCallers(agentId, allowedCallers);
  await notifyCallerPolicyChanged(db, agentId);

  return {
    agent_id: agentId,
    key_id: keyId,
    principal,
    api_key: issued.rawToken,
    label: label ?? null,
    expires_at: issued.expiresAt.toISOString(),
    allowed_callers: allowedCallers,
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
  agent_id: string;
  client_name: string;
  owner_principal: string;
  allowed_agent_ids: string[];
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
      SELECT client_id, id, owner_principal, name, created_at
      FROM agents
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
    client_id: r.client_id as string,
    agent_id: r.id as string,
    client_name: r.name as string,
    owner_principal: r.owner_principal as string,
    allowed_agent_ids: [r.id as string],
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : (r.created_at as string),
    connected: connectedClientIds.has(r.client_id as string),
  }));
}

export interface DeleteClientResult {
  client_id: string;
  client_name: string;
  deleted: true;
  /** Number of live WebSocket connections closed as part of this delete. */
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
    return tx`SELECT client_id AS id, name AS client_name FROM agents WHERE client_id = ${target} OR id = ${target}`;
  });
  if (byId.length === 1) {
    return { id: byId[0].id as string, client_name: byId[0].client_name as string };
  }

  const byName = await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    return tx`SELECT client_id AS id, name AS client_name FROM agents WHERE name = ${target}`;
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

export async function deleteClientForOwner(
  db: Sql,
  registry: Registry,
  principalId: string,
  target: string,
): Promise<DeleteClientResult> {
  const resolved = await resolveClient(db, principalId, target);

  await db.begin(async (tx) => {
    await setRlsContext(tx, principalId);
    // RLS-scoped DELETE; resolveClient() already verified the row is visible
    // to this principal so the DELETE inside will succeed (or affect zero
    // rows if a concurrent delete happened, which is acceptable — the
    // resulting closed_connections=0 is still a correct response).
    await tx`
      DELETE FROM agents
      WHERE client_id = ${resolved.id}
    `;
    await tx`
      DELETE FROM clients
      WHERE id = ${resolved.id}
    `;
  });

  // Close every live WebSocket session bound to this client. The daemon
  // sees close code 4014 and exits without reconnecting (see client.ts).
  const closedConnections = registry.disconnectClient(resolved.id);

  return {
    client_id: resolved.id,
    client_name: resolved.client_name,
    deleted: true,
    closed_connections: closedConnections,
  };
}
