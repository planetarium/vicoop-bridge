import type { Sql } from '../db.js';
import type { Registry } from '../registry.js';
import { logEvent, truncate } from '../log.js';
import { parseX402Pricing } from './pricing.js';

// Cross-instance pricing invalidation.
//
// Pricing is read once per connection and cached on the live
// `ClientConnection`, which the executor consults every turn. An admin write
// patches that copy — but only on the instance that served the HTTP request.
// The bridge runs several Fly instances and the agent's WebSocket lives on
// exactly one of them, which is usually not the one that handled the write, so
// without this the agent keeps charging the old price until it reconnects.
//
// The dangerous direction is `clear`: an agent made free on one instance goes
// on billing from another. That is money taken after the operator believes
// they turned it off, which is why this is a NOTIFY rather than a TTL.

export const X402_PRICING_CHANNEL = 'x402_pricing_changed';

/** Announce that an agent's pricing row changed. Best-effort. */
export async function notifyX402PricingChanged(sql: Sql, agentId: string): Promise<void> {
  try {
    await sql.notify(X402_PRICING_CHANNEL, agentId);
  } catch (err) {
    // A failed notification degrades to the pre-existing behavior — other
    // instances stay stale until the agent reconnects — so it must not fail
    // the admin write that already committed.
    logEvent('x402_pricing_notify_failed', {
      agentId: truncate(String(agentId), 128),
      error: String(err),
    });
  }
}

/**
 * Re-read an agent's pricing from the database and push it into the registry.
 *
 * Re-reads rather than trusting the payload: the notification carries only an
 * agent id, so two writes racing cannot leave an instance holding whichever
 * message happened to arrive last.
 */
async function refresh(sql: Sql, registry: Registry, agentId: string): Promise<void> {
  // Only instances actually holding this agent's socket have anything to
  // update; everyone else can drop the notification without a query.
  if (!registry.getAgent(agentId)) return;

  const rows = await sql<{ x402_pricing: unknown }[]>`
    SELECT x402_pricing FROM agents WHERE id = ${agentId}
  `;
  if (rows.length === 0) return;

  let pricing;
  try {
    pricing = parseX402Pricing(rows[0]!.x402_pricing);
  } catch (err) {
    // Same posture as the connect-time read: an unreadable row makes the agent
    // free rather than taking it offline, and nobody is charged against
    // configuration the server could not parse.
    logEvent('x402_pricing_invalid', {
      agentId: truncate(String(agentId), 128),
      error: String(err),
    });
    pricing = undefined;
  }
  registry.updateX402Pricing(agentId, pricing);
  logEvent('x402_pricing_refreshed', {
    agentId: truncate(String(agentId), 128),
    paid: pricing !== undefined,
  });
}

/**
 * Subscribe to pricing changes for the lifetime of the process.
 *
 * Resolves once the subscription is live. Returns `undefined` if it could not
 * be established — the deployment still works, it just falls back to
 * pricing being refreshed when an agent reconnects.
 */
export async function watchX402PricingChanges(
  sql: Sql,
  registry: Registry,
): Promise<{ unlisten: () => Promise<void> } | undefined> {
  try {
    const subscription = await sql.listen(X402_PRICING_CHANNEL, (payload) => {
      void refresh(sql, registry, payload).catch((err) => {
        logEvent('x402_pricing_refresh_failed', {
          agentId: truncate(String(payload), 128),
          error: String(err),
        });
      });
    });
    return { unlisten: () => subscription.unlisten() };
  } catch (err) {
    logEvent('x402_pricing_watch_failed', { error: String(err) });
    return undefined;
  }
}
