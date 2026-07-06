import { randomUUID } from 'node:crypto';
import type {
  Task,
  Message,
  CreateTaskParams,
  TaskUpdate,
  TaskStore,
} from '@a2x/sdk';
import { TaskState, TERMINAL_STATES } from '@a2x/sdk';
import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import type { Sql, SqlExecutor } from './db.js';
import { logEvent } from './log.js';

const MAX_CONTEXT_TASKS = 10;

// Diagnostic threshold (issue #414): emit a `task_store_slow_update` log event
// when an `updateTask` takes at least this long. `updateTask` sits on the A2A
// SSE critical path — the @a2x/sdk `await`s it (un-caught) before yielding each
// streamed non-terminal status, INCLUDING every 10s liveness heartbeat, to the
// router's stream — so a slow/blocked write here freezes the outbound stream
// and can trip the router's stall watchdog while the client runs on to a normal
// completion. Logging slow writes lets a router stall be correlated against a
// concrete write duration. Configurable via `VICOOP_TASKSTORE_SLOW_MS`
// (milliseconds); default 1000. Set to 0 to log every write. Read per call
// (the cost is nil next to a DB round-trip) so it stays reconfigurable/testable.
function slowUpdateThresholdMs(): number {
  const raw = process.env.VICOOP_TASKSTORE_SLOW_MS;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

type MessageWithMetadata = Message & { metadata?: Record<string, unknown> };

function extractOwnerPrincipal(task: Task): string | undefined {
  for (const msg of task.history ?? []) {
    const principal = (msg as MessageWithMetadata).metadata?._principalId;
    if (typeof principal === 'string') return principal;
  }
  const statusPrincipal = (task.status?.message as MessageWithMetadata | undefined)?.metadata
    ?._principalId;
  if (typeof statusPrincipal === 'string') return statusPrincipal;
  return undefined;
}

function stripMessageMetadata(msg: Message): Message {
  const { _bearerToken, _principalId, ...rest } =
    (msg as MessageWithMetadata).metadata ?? {};
  void _bearerToken;
  void _principalId;
  const clean = Object.keys(rest).length ? rest : undefined;
  if (clean) return { ...msg, metadata: clean };
  const { metadata: _meta, ...m } = msg as MessageWithMetadata;
  void _meta;
  return m as Message;
}

// Drop the request-scoped `chat_completions_request` envelope from the
// persisted copy of an openai-compat task. Per the openai-compat/v1 extension
// (planetarium/oai2a2a), the gateway is stateless and re-emits the full
// request envelope on EVERY turn, so the agent/server is never expected to read
// it back from storage — persisting it just bloats the row (it is ~half of
// task_json on this deployment, see issue #408). The response side of the
// envelope (`chat_completion` / `terminal_error`, carried on message metadata)
// is the codec's read-back source and is intentionally left untouched.
//
// Non-mutating: returns the input unchanged when there is no envelope to strip
// (non-openai-compat tasks, admin agent), and otherwise returns a shallow copy
// with a pruned `metadata` so the live task object the caller still forwards
// from is never altered.
function stripPersistedEnvelope(task: Task): Task {
  const metadata = task.metadata as Record<string, unknown> | undefined;
  const ext: unknown = metadata?.[OPENAI_COMPAT_EXTENSION_URI];
  if (
    !ext ||
    typeof ext !== 'object' ||
    Array.isArray(ext) ||
    !('chat_completions_request' in ext)
  ) {
    return task;
  }
  const { chat_completions_request: _drop, ...restExt } = ext;
  void _drop;
  const nextMetadata = { ...metadata };
  if (Object.keys(restExt).length > 0) {
    nextMetadata[OPENAI_COMPAT_EXTENSION_URI] = restExt;
  } else {
    delete nextMetadata[OPENAI_COMPAT_EXTENSION_URI];
  }
  const hasMetadata = Object.keys(nextMetadata).length > 0;
  return { ...task, metadata: hasMetadata ? nextMetadata : undefined };
}

export function stripSensitiveMetadata(task: Task): Task {
  const result = { ...stripPersistedEnvelope(task) };
  if (result.history?.length) {
    result.history = result.history.map(stripMessageMetadata);
  }
  if (result.status?.message) {
    result.status = { ...result.status, message: stripMessageMetadata(result.status.message) };
  }
  return result;
}

export interface ContextAwareTaskStore extends TaskStore {
  loadByContextId(contextId: string, principalId: string, excludeTaskId?: string): Promise<Task[]>;
}

export class PostgresTaskStore implements ContextAwareTaskStore {
  constructor(private readonly sql: Sql) {}

  async createTask(params: CreateTaskParams): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      contextId: params.contextId ?? randomUUID(),
      status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
      metadata: params.metadata,
    };
    await this.writeTask(task);
    // A freshly-created task is SUBMITTED, never terminal, so retention is a
    // no-op here — skip it entirely.
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = await this.sql<{ task_json: Task }[]>`
      SELECT task_json FROM infra.a2a_tasks WHERE task_id = ${taskId} LIMIT 1
    `;
    return rows[0]?.task_json ?? null;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    // read-modify-write must be serialized per task row. Two concurrent
    // updateTask calls for the same taskId (e.g. executeStream's terminal
    // save racing message/cancel's save — separate HTTP requests) would
    // otherwise both read the same `existing`, each merge only their own
    // fields, and the later write would clobber the earlier one's changes
    // (lost update): one writes `status`, the other `history`/`artifacts`,
    // and only one survives. `ON CONFLICT DO UPDATE` serializes the row
    // write but not the JS merge spanning the read→write await boundary.
    //
    // SELECT ... FOR UPDATE inside a transaction takes a row lock so a
    // concurrent updateTask blocks until this one commits, then reads the
    // freshly-written row and merges on top of it. READ COMMITTED (the
    // default) is sufficient: FOR UPDATE blocks the second SELECT until the
    // first transaction commits, after which it reads the just-written row —
    // we don't need REPEATABLE READ because the lock, not snapshot isolation,
    // is what serializes the two read-modify-writes.
    // Diagnostic timing (issue #414): time the FOR UPDATE transaction and the
    // (terminal-only) retention DELETE separately so a slow beat can be
    // attributed to the right phase. `retentionMs` stays 0 for non-terminal
    // writes (heartbeats), where enforceRetention is a no-op — so a heartbeat's
    // cost is purely the transaction below.
    const startedAt = Date.now();
    let txnMs = 0;
    let retentionMs = 0;
    try {
      const txnStart = Date.now();
      const merged = await this.sql.begin(async (sql) => {
        const rows = await sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks WHERE task_id = ${taskId} FOR UPDATE
        `;
        const existing = rows[0]?.task_json ?? null;
        if (!existing) {
          throw new Error(`Task not found: ${taskId}`);
        }
        const next: Task = { ...existing };
        if (update.status !== undefined) next.status = update.status;
        if (update.artifacts !== undefined) next.artifacts = update.artifacts;
        if (update.history !== undefined) next.history = update.history;
        if (update.metadata !== undefined) next.metadata = update.metadata;
        await this.writeTask(next, sql);
        return next;
      });
      txnMs = Date.now() - txnStart;
      // Retention runs AFTER the transaction commits, on the pool connection —
      // deliberately NOT inside the FOR UPDATE transaction. Two same-context
      // tasks reaching a terminal state at once would otherwise each hold the
      // lock on their own row while the retention DELETE tries to remove the
      // OTHER's row, producing a lock-order cycle: Postgres aborts one and
      // rolls back its task-state write with it. Running retention post-commit
      // keeps the state write durable (it has already committed) and confines
      // the row lock to the single task being updated, so two updateTask calls
      // can never deadlock each other.
      const retentionStart = Date.now();
      await this.enforceRetention(merged);
      retentionMs = Date.now() - retentionStart;
      const totalMs = Date.now() - startedAt;
      if (totalMs >= slowUpdateThresholdMs()) {
        logEvent('task_store_slow_update', {
          taskId,
          state: merged.status.state,
          totalMs,
          txnMs,
          retentionMs,
        });
      }
      return merged;
    } catch (err) {
      // Surface the timing on the failure path too. The SDK's streamed
      // updateTask (@a2x/sdk `_handleStreamMessage`) is un-caught, so a throw
      // here otherwise tears down the SSE with no local trace of how long it
      // ran or which phase it died in.
      logEvent('task_store_update_error', {
        taskId,
        state: update.status?.state ?? null,
        totalMs: Date.now() - startedAt,
        txnMs,
        retentionMs,
        error: String(err),
      });
      throw err;
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.sql`DELETE FROM infra.a2a_tasks WHERE task_id = ${taskId}`;
  }

  async loadByContextId(
    contextId: string,
    principalId: string,
    excludeTaskId?: string,
  ): Promise<Task[]> {
    const rows = excludeTaskId
      ? await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks
          WHERE context_id = ${contextId}
            AND owner_principal = ${principalId}
            AND task_id != ${excludeTaskId}
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${MAX_CONTEXT_TASKS}
        `
      : await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks
          WHERE context_id = ${contextId}
            AND owner_principal = ${principalId}
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${MAX_CONTEXT_TASKS}
        `;
    return rows.map((r) => r.task_json).reverse();
  }

  /**
   * Time-based retention. Deletes every task belonging to a context that has
   * been idle (no task created or updated) for longer than `retentionDays`
   * AND has no in-flight (non-terminal) task.
   *
   * Pruning is context-scoped rather than per-row on purpose: an actively-used
   * long-running context keeps ALL its turns (its newest task's updated_at is
   * recent, so the whole context is spared), and only contexts with no recent
   * activity are reclaimed. This is the orthogonal axis to the count-based cap
   * in enforceRetention() (which bounds a single context to MAX_CONTEXT_TASKS):
   * the count cap stops one context from bloating, this stops the table from
   * growing monotonically with the number of stale contexts over time (the root
   * cause in #385). It also reclaims old terminal contexts whose rows have no
   * owner_principal, which the count-based path skips.
   *
   * Any context that still holds a non-terminal task is spared regardless of
   * age: the executor only persists a task at terminal/stream-end (no
   * intermediate writes), so a legitimately long-running task's updated_at
   * stays frozen at creation time, and a per-row age test would reap it out
   * from under the live executor. Genuinely-stuck non-terminal tasks are
   * therefore not collected here by design — handle those separately if needed.
   *
   * Purely timestamp-driven (no dependence on task_json contents). Deletion
   * relies on autovacuum to return space for reuse; it does not shrink the
   * relation on disk (run VACUUM FULL / pg_repack once for the historical
   * backlog). Returns the number of rows deleted.
   */
  async pruneStaleContexts(retentionDays: number): Promise<number> {
    const res = await this.sql`
      DELETE FROM infra.a2a_tasks
      WHERE context_id IN (
        SELECT context_id FROM infra.a2a_tasks
        GROUP BY context_id
        HAVING max(updated_at) < now() - ${retentionDays} * interval '1 day'
           AND count(*) FILTER (
                 WHERE state NOT IN ('completed', 'failed', 'canceled', 'rejected')
               ) = 0
      )
    `;
    return res.count;
  }

  // Write (insert-or-replace) the full task row. `sql` defaults to the pool
  // connection but updateTask passes its transaction-scoped connection so the
  // row write participates in the same FOR UPDATE transaction that read it.
  private async writeTask(task: Task, sql: SqlExecutor = this.sql): Promise<void> {
    const ownerPrincipal = extractOwnerPrincipal(task);
    const sanitized = stripSensitiveMetadata(task);
    const contextId = task.contextId ?? task.id;

    await sql`
      INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_principal)
      VALUES (
        ${task.id},
        ${contextId},
        ${task.status.state},
        ${sql.json(JSON.parse(JSON.stringify(sanitized)))},
        ${ownerPrincipal ?? null}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state = EXCLUDED.state,
        task_json = EXCLUDED.task_json,
        owner_principal = COALESCE(infra.a2a_tasks.owner_principal, EXCLUDED.owner_principal),
        updated_at = now()
    `;
  }

  // Trim a context's terminal tasks down to MAX_CONTEXT_TASKS. Always runs on
  // the pool connection (never a caller's transaction) so it can't hold a
  // task-row lock while scanning/deleting sibling rows — that held lock is
  // what let the old in-transaction version deadlock (see the note in
  // updateTask), and dropping it removes the cycle entirely. Two concurrent
  // retention passes for the same context could in principle still contend on
  // the same victim rows, but the blast radius is tiny: retention only fires
  // for owned terminal tasks, deletes a short tail beyond the cap, and holds
  // no other lock — so they serialize on row locks rather than deadlocking in
  // practice. (Lock-acquisition order across a `DELETE ... WHERE task_id IN
  // (SELECT ... ORDER BY ...)` is planner-dependent, so this is a
  // probabilistic argument, not a guarantee — acceptable given the rarity.)
  // No-op unless the task is terminal and owned.
  private async enforceRetention(task: Task): Promise<void> {
    const ownerPrincipal = extractOwnerPrincipal(task);
    if (!ownerPrincipal || !TERMINAL_STATES.has(task.status.state)) return;
    const contextId = task.contextId ?? task.id;

    await this.sql`
      DELETE FROM infra.a2a_tasks
      WHERE task_id IN (
        SELECT task_id FROM infra.a2a_tasks
        WHERE context_id = ${contextId}
          AND owner_principal = ${ownerPrincipal}
          AND state IN ('completed', 'failed', 'canceled', 'rejected')
        ORDER BY created_at DESC, task_id DESC
        OFFSET ${MAX_CONTEXT_TASKS}
      )
    `;
  }
}
