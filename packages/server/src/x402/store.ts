import {
  BaseX402Store,
  type X402StoreEntry,
  type X402StoreEntryPatch,
} from '@a2x/sdk/x402';
import type { Sql } from '../db.js';

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
    // Recorded on the row so operational queries ("what did agent X charge
    // this week") don't have to join through the task table. Not part of the
    // SDK entry, which is keyed by taskId alone.
    private readonly agentId: string,
  ) {
    super();
  }

  async put(entry: X402StoreEntry): Promise<void> {
    const expiresAt = entry.expiresAt ?? null;
    // The entry is round-tripped through JSON — the repo's pattern for JSONB
    // writes — which also lowers every Date to an ISO string, exactly what
    // `reviveEntry` reverses on the way back out.
    await this.sql`
      INSERT INTO x402_offerings (task_id, agent_id, entry, expires_at, updated_at)
      VALUES (
        ${entry.taskId},
        ${this.agentId},
        ${this.sql.json(JSON.parse(JSON.stringify(entry)))},
        ${expiresAt},
        now()
      )
      ON CONFLICT (task_id) DO UPDATE
        SET entry = EXCLUDED.entry,
            agent_id = EXCLUDED.agent_id,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
    `;
  }

  async get(taskId: string): Promise<X402StoreEntry | undefined> {
    const rows = await this.sql<OfferingRow[]>`
      SELECT task_id, entry
      FROM x402_offerings
      WHERE task_id = ${taskId}
        AND (expires_at IS NULL OR expires_at > now())
    `;
    const row = rows[0];
    return row ? reviveEntry(row.entry) : undefined;
  }

  async update(taskId: string, patch: X402StoreEntryPatch): Promise<void> {
    // Read-modify-write rather than a JSONB merge: the patch carries nested
    // Date values that would have to be hand-serialized into a jsonb_set
    // chain anyway, and the round-trip stays inside one statement's worth of
    // latency. Concurrent patches for one task don't occur — a task's
    // payment round-trip is driven by a single in-flight request.
    const current = await this.get(taskId);
    if (!current) return;
    await this.put({ ...current, ...patch, updatedAt: new Date() });
  }

  async delete(taskId: string): Promise<void> {
    await this.sql`DELETE FROM x402_offerings WHERE task_id = ${taskId}`;
  }

  /**
   * Drop rows whose expiry has passed. Lazy expiry already hides them from
   * `get`, so this only reclaims space for offerings whose task was never
   * completed or cancelled. Returns the number of rows removed.
   */
  async sweepExpired(): Promise<number> {
    const rows = await this.sql`
      DELETE FROM x402_offerings
      WHERE expires_at IS NOT NULL AND expires_at <= now()
      RETURNING task_id
    `;
    return rows.length;
  }
}
