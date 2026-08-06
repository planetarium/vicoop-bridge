import {
  BaseX402Store,
  type X402StoreEntry,
  type X402StoreEntryPatch,
} from '@a2x/sdk/x402';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Sql } from '../db.js';
import { parseX402Pricing, type X402Pricing } from './pricing.js';

// The pricing an in-flight `requestPayment` is publishing.
//
// The SDK owns the offering write, so the terms cannot be passed to it as an
// argument — but they must land in the *same* statement. Storing them
// separately leaves a window where two concurrent turn-1s racing a reprice
// interleave into one offering paired with the other's terms: same scheme, so
// no shape check catches it, and the caller is metered at rates they never
// signed against.
//
// A module-level variable would have the same race. Async context is per-call,
// so each `requestPayment` sees exactly the terms it is publishing no matter
// how many run concurrently.
const publishingPricing = new AsyncLocalStorage<{ taskId: string; pricing: X402Pricing }>();

// Postgres-backed x402 offering store.
//
// The SDK's default `InMemoryX402Store` cannot back this deployment: the
// payment round-trip spans two HTTP requests (turn 1 advertises the offering,
// turn 2 submits the signed payload), and the bridge runs multiple Fly
// instances behind a load balancer. Turn 2 routinely lands on an instance
// that never saw turn 1, and an in-memory offering would classify it as
// `no-stored-offering` — the payer signs, gets rejected, and is not charged,
// but the call fails. Restarts have the same effect on a single instance.
//
// Expiry is lazy per the store contract: `get` filters on `expires_at`, so a
// lapsed offering reads as absent without a background reaper. Rows are
// deleted by `clearOffering` after a task terminates; `sweepExpired` exists
// for the rows whose task never terminated at all.

interface OfferingRow {
  task_id: string;
  entry: unknown;
}

// The entry round-trips through JSONB, which has no Date type. Every Date
// field is written as an ISO string by `JSON.stringify` and must be revived
// on read — a string where the SDK expects a Date silently breaks the
// `expiresAt` comparison and `receipt.settledAt` arithmetic.
function reviveEntry(raw: unknown): X402StoreEntry {
  const e = raw as Record<string, unknown>;
  const date = (v: unknown): Date | undefined =>
    typeof v === 'string' ? new Date(v) : undefined;

  const storedAt = date(e.storedAt);
  const updatedAt = date(e.updatedAt);
  const expiresAt = date(e.expiresAt);
  const verifiedAt = date(e.verifiedAt);
  const receipt = e.receipt as Record<string, unknown> | undefined;
  const failure = e.failure as Record<string, unknown> | undefined;

  return {
    ...(e as unknown as X402StoreEntry),
    // storedAt/updatedAt are non-optional on the entry; a row that somehow
    // lacks them is more useful with a placeholder than as a crash on an
    // audit read.
    storedAt: storedAt ?? new Date(0),
    updatedAt: updatedAt ?? new Date(0),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    ...(receipt !== undefined
      ? {
          receipt: {
            ...(receipt as unknown as NonNullable<X402StoreEntry['receipt']>),
            settledAt: date(receipt.settledAt) ?? new Date(0),
          },
        }
      : {}),
    ...(failure !== undefined
      ? {
          failure: {
            ...(failure as unknown as NonNullable<X402StoreEntry['failure']>),
            failedAt: date(failure.failedAt) ?? new Date(0),
          },
        }
      : {}),
  };
}

export class PostgresX402Store extends BaseX402Store {
  constructor(
    private readonly sql: Sql,
    /**
     * The agent this store is scoped to. **Every** operation filters on it.
     *
     * Not merely a label for operational queries: tasks resolve by id from a
     * store shared across all agents (#453), so a task created at agent A can
     * be resumed at agent B's endpoint. Were offerings keyed on `taskId`
     * alone, B's gate would load A's offering and accept A's cheap signature
     * as payment for B's work.
     */
    private readonly agentId: string,
  ) {
    super();
  }

  /**
   * Run `fn` with `pricing` attached to the offering it publishes.
   *
   * The write that `fn` triggers inside the SDK carries these terms in the
   * same statement as the offering, which is what makes the pair atomic.
   */
  async publishing<T>(taskId: string, pricing: X402Pricing, fn: () => Promise<T>): Promise<T> {
    return publishingPricing.run({ taskId, pricing }, fn);
  }

  async put(entry: X402StoreEntry): Promise<void> {
    const expiresAt = entry.expiresAt ?? null;
    // Terms are present only on the publishing write; the SDK's later
    // lifecycle patches (verified, completed, failed) run outside that context
    // and must leave the frozen snapshot alone. The taskId is checked rather
    // than assumed: the context belongs to one offering, and applying its
    // terms to a different task would be the very mix-up this exists to stop.
    const ctx = publishingPricing.getStore();
    const pricing = ctx?.taskId === entry.taskId ? ctx.pricing : undefined;

    // The entry is round-tripped through JSON — the repo's pattern for JSONB
    // writes — which also lowers every Date to an ISO string, exactly what
    // `reviveEntry` reverses on the way back out.
    //
    // `claimed_at` is never touched here: the SDK patches the entry repeatedly
    // through the round-trip, and under `exact` settlement happens before the
    // work, so resetting the claim mid-task would let a resubmission be
    // charged a second time.
    await this.sql`
      INSERT INTO x402_offerings (task_id, agent_id, entry, pricing, expires_at, updated_at)
      VALUES (
        ${entry.taskId},
        ${this.agentId},
        ${this.sql.json(JSON.parse(JSON.stringify(entry)))},
        ${pricing === undefined ? null : this.sql.json(JSON.parse(JSON.stringify(pricing)))},
        ${expiresAt},
        now()
      )
      ON CONFLICT (agent_id, task_id) DO UPDATE
        SET entry = EXCLUDED.entry,
            pricing = COALESCE(EXCLUDED.pricing, x402_offerings.pricing),
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
    `;
  }

  async get(taskId: string): Promise<X402StoreEntry | undefined> {
    const rows = await this.sql<OfferingRow[]>`
      SELECT task_id, entry
      FROM x402_offerings
      WHERE agent_id = ${this.agentId}
        AND task_id = ${taskId}
        AND (expires_at IS NULL OR expires_at > now())
    `;
    const row = rows[0];
    return row ? reviveEntry(row.entry) : undefined;
  }

  async update(taskId: string, patch: X402StoreEntryPatch): Promise<void> {
    // Read-modify-write rather than a JSONB merge: the patch carries nested
    // Date values that would have to be hand-serialized into a jsonb_set
    // chain anyway, and the round-trip stays inside one statement's worth of
    // latency. Racing writers are not a correctness problem here because the
    // one operation that must not run twice — accepting a submission — is
    // gated by `claim()` below rather than by the entry's status.
    const current = await this.get(taskId);
    if (!current) return;
    await this.put({ ...current, ...patch, updatedAt: new Date() });
  }

  async delete(taskId: string): Promise<void> {
    await this.sql`
      DELETE FROM x402_offerings
      WHERE agent_id = ${this.agentId} AND task_id = ${taskId}
    `;
  }

  /** The terms the offering was published under, written alongside it. */
  async getPricing(taskId: string): Promise<X402Pricing | undefined> {
    const rows = await this.sql<{ pricing: unknown }[]>`
      SELECT pricing
      FROM x402_offerings
      WHERE agent_id = ${this.agentId} AND task_id = ${taskId}
    `;
    const raw = rows[0]?.pricing;
    if (raw === undefined || raw === null) return undefined;
    // Read-side parsing is lenient about unknown keys on purpose (see
    // pricing.ts) — a snapshot written by a newer build must still price here.
    return parseX402Pricing(raw);
  }

  /**
   * Take the one-shot right to act on this task's submission.
   *
   * Returns `true` for the caller that wins and `false` for every other. The
   * SDK's `classify()` does not inspect the entry's status, so without this a
   * replayed submission classifies valid twice and the backend runs the work
   * twice against a single authorization.
   *
   * Deliberately never released. A failed verify leaves the offering claimed
   * and the payer starts a new task; re-opening the window on failure would
   * restore the double-spend it exists to prevent, and nothing has been
   * charged at that point.
   */
  async claim(taskId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE x402_offerings
      SET claimed_at = now(), updated_at = now()
      WHERE agent_id = ${this.agentId}
        AND task_id = ${taskId}
        AND claimed_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING task_id
    `;
    return rows.length > 0;
  }
}

/**
 * Drop offerings whose expiry has passed, across every agent.
 *
 * Lazy expiry already hides them from `get`, so this only reclaims space — but
 * it has to run: a caller that walks away at the `input-required` turn leaves
 * a row behind, and on a public paid agent that is an unauthenticated way to
 * grow the table. Returns the number of rows removed.
 */
export async function sweepExpiredX402Offerings(sql: Sql): Promise<number> {
  const rows = await sql`
    DELETE FROM x402_offerings
    WHERE expires_at IS NOT NULL AND expires_at <= now()
    RETURNING task_id
  `;
  return rows.length;
}
