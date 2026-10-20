import type { Sql, SqlExecutor } from './db.js';
import type { Registry } from './registry.js';
import { isAdmin } from './admin-scope.js';
import { AdminApiError } from './admin-api.js';
import { logEvent } from './log.js';

export const OWNER_CHANNEL = 'agent_owner_changed';

// Google token issuance follows verified OAuth (including email_verified).
// Keep historical rows when resolving: two subjects claiming an email must
// be treated as ambiguous, even if one of their sessions has expired.
export async function resolveTransferOwner(db: SqlExecutor, target: string) {
  const value = target.trim();
  const principal = /^google:(?:sub:)?([0-9]+)$/.exec(value);
  const wallet = /^eth:0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
  const email = /^[^\s@:]+@[^\s@:]+$/.test(value) ? value.toLowerCase() : null;
  if (!principal && !wallet && !email) throw new AdminApiError('Unsupported owner identity', 400);
  const canonical = principal ? `google:${principal[1]}` : wallet;
  const rows = await db<{ principal_id: string; email: string | null }[]>`
    SELECT DISTINCT principal_id, CASE WHEN provider = 'google' THEN lower(email) ELSE NULL END AS email
    FROM callers
    WHERE (provider = 'google' AND principal_id ~ '^google:[0-9]+$'
      AND (${email}::text IS NULL OR lower(email) = ${email}))
      AND (${canonical}::text IS NULL OR principal_id = ${canonical})
    UNION
    SELECT DISTINCT principal_id, NULL AS email FROM callers
    WHERE provider = 'siwe' AND principal_id = ${wallet}
  `;
  const identities = [...new Set(rows.map((r) => r.principal_id))];
  if (!identities.length) throw new AdminApiError('Unknown owner; target must first log in to the bridge', 404);
  if (identities.length !== 1) throw new AdminApiError('Ambiguous email; specify a verified canonical principal', 409);
  // A principal may have used several verified emails; do not guess a contact.
  const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))];
  return { principal: identities[0]!, email: emails.length === 1 ? emails[0]! : null };
}

export async function transferAgent(
  db: Sql, registry: Registry, actor: string, agentId: string,
  input: { to: string; expectedOwner?: string; expectedRevision?: string; expectedClientId?: string; preview?: boolean },
) {
  let previousOwner: string | null = null;
  let newOwner: string | null = null;
  try {
    if (!isAdmin(actor)) throw new AdminApiError('Agent transfer requires a bridge administrator', 403);
    if (typeof input.to !== 'string' || !input.to.trim()) throw new AdminApiError('to is required', 400);
    if (!input.preview && (typeof input.expectedOwner !== 'string' ||
        typeof input.expectedClientId !== 'string' || !input.expectedClientId ||
        typeof input.expectedRevision !== 'string' || !/^\d+$/.test(input.expectedRevision))) {
      throw new AdminApiError('expectedOwner, expectedRevision and expectedClientId from a preview are required', 400);
    }
    const result = await db.begin(async (tx) => {
      const rows = await tx`SELECT owner_principal, owner_revision::text, client_id FROM agents WHERE id = ${agentId} FOR UPDATE`;
      const agent = rows[0];
      if (!agent) throw new AdminApiError('Agent not found', 404);
      previousOwner = agent.owner_principal;
      const owner = await resolveTransferOwner(tx, input.to);
      newOwner = owner.principal;
      if (!input.preview && (input.expectedOwner !== previousOwner || input.expectedRevision !== agent.owner_revision ||
          input.expectedClientId !== agent.client_id)) {
        throw new AdminApiError('Ownership or registration changed since preview; preview again', 409);
      }
      const unchanged = previousOwner === newOwner;
      if (!input.preview && !unchanged) {
        const clients = await tx`SELECT id, allowed_agent_ids FROM clients WHERE id = ${agent.client_id} OR ${agentId} = ANY(allowed_agent_ids) FOR UPDATE`;
        if (clients.some((c) => c.allowed_agent_ids.some((id: string) => id !== agentId))) {
          throw new AdminApiError('Compatibility client covers other agents; split registration before transfer', 409);
        }
        await tx`UPDATE agents SET owner_principal = ${owner.principal}, owner_email = ${owner.email}, updated_at = now() WHERE id = ${agentId}`;
        for (const client of clients) {
          await tx`UPDATE clients SET owner_principal = ${owner.principal}, owner_email = ${owner.email} WHERE id = ${client.id}`;
        }
        await tx`UPDATE agent_policies SET owner_principal = ${owner.principal}, updated_at = now() WHERE agent_id = ${agentId}`;
        // Transactional NOTIFY: never broadcast a rolled-back transfer.
        await tx`SELECT pg_notify(${OWNER_CHANNEL}, ${agentId})`;
      }
      return { agent_id: agentId, client_id: agent.client_id as string, previous_owner: previousOwner!, owner_principal: owner.principal,
        owner_email: owner.email, expected_revision: (!input.preview && !unchanged ? (BigInt(agent.owner_revision) + 1n).toString() : agent.owner_revision) as string,
        outcome: input.preview ? 'preview' : unchanged ? 'unchanged' : 'transferred',
        token_handling: 'preserved' };
    });
    let sessionSync = input.preview ? 'not_requested' : 'refresh_queued';
    if (!input.preview) {
      try { await refreshAgentOwners(db, registry); sessionSync = 'local_refreshed_remote_eventual'; }
      catch { sessionSync = 'refresh_pending'; }
    }
    logEvent('agent_transfer', { actor, agentId, previousOwner, newOwner, outcome: result.outcome, sessionSync });
    return { ...result, session_sync: sessionSync };
  } catch (error) {
    logEvent('agent_transfer', { actor, agentId, previousOwner, newOwner, outcome: 'rejected',
      status: error instanceof AdminApiError ? error.status : 500 });
    throw error;
  }
}

// Management authorization reads Postgres directly; this cache is only for
// display/telemetry. Periodic reconciliation also repairs missed NOTIFY events
// and a hello that raced with the transfer. In-flight tasks are untouched.
export async function refreshAgentOwners(db: Sql, registry: Registry): Promise<void> {
  const ids = registry.listAgents().map((a) => a.agentId);
  if (!ids.length) return;
  const rows = await db`SELECT id, owner_principal, owner_email FROM agents WHERE id = ANY(${ids})`;
  for (const row of rows) {
    const conn = registry.getAgent(row.id);
    if (conn) { conn.ownerPrincipal = row.owner_principal; conn.ownerEmail = row.owner_email; }
  }
}

export async function watchAgentOwners(db: Sql, registry: Registry) {
  let running = false;
  const refresh = () => {
    // Coalesce notifications while a query is outstanding. The next timer
    // repairs changes racing that query without an unbounded outage backlog.
    if (running) return;
    running = true;
    void refreshAgentOwners(db, registry)
      .catch(() => { logEvent('agent_owner_refresh_failed', {}); })
      .finally(() => { running = false; });
  };
  const timer = setInterval(refresh, 5000);
  timer.unref();
  refresh();
  try {
    const listener = await db.listen(OWNER_CHANNEL, refresh);
    return { stop: async () => { clearInterval(timer); await listener.unlisten(); } };
  } catch {
    logEvent('agent_owner_watch_failed', {});
    return { stop: async () => { clearInterval(timer); } };
  }
}
