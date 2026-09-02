import type { Sql } from './db.js';
import { logEvent, truncate } from './log.js';
import type { Registry } from './registry.js';

// allowed_callers is DB-owned but cached on the instance holding an agent's
// outbound WebSocket. Admin writes can land on another instance, so cards and
// non-federated ingress need the same LISTEN/NOTIFY convergence used by x402
// pricing. Federated token/task checks additionally read Postgres directly.
export const CALLER_POLICY_CHANNEL = 'caller_policy_changed';

export async function notifyCallerPolicyChanged(sql: Sql, agentId: string): Promise<void> {
  try {
    await sql.notify(CALLER_POLICY_CHANNEL, agentId);
  } catch (error) {
    logEvent('caller_policy_notify_failed', {
      agentId: truncate(agentId, 128),
      error: String(error),
    });
  }
}

async function refresh(sql: Sql, registry: Registry, agentId: string): Promise<void> {
  if (!registry.getAgent(agentId)) return;
  const rows = await sql<{ allowed_callers: string[] }[]>`
    SELECT allowed_callers FROM agents WHERE id = ${agentId}
  `;
  const callers = rows[0]?.allowed_callers;
  if (!callers) return;
  registry.updateAllowedCallers(agentId, callers);
  logEvent('caller_policy_refreshed', {
    agentId: truncate(agentId, 128),
    callerCount: callers.length,
  });
}

export async function watchCallerPolicyChanges(
  sql: Sql,
  registry: Registry,
): Promise<{ unlisten: () => Promise<void> } | undefined> {
  try {
    const subscription = await sql.listen(CALLER_POLICY_CHANNEL, (payload) => {
      void refresh(sql, registry, payload).catch((error) => {
        logEvent('caller_policy_refresh_failed', {
          agentId: truncate(payload, 128),
          error: String(error),
        });
      });
    });
    return { unlisten: () => subscription.unlisten() };
  } catch (error) {
    logEvent('caller_policy_watch_failed', { error: String(error) });
    return undefined;
  }
}
