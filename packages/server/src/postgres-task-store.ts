import { randomUUID } from 'node:crypto';
import type {
  Task,
  Message,
  CreateTaskParams,
  ListTasksParams,
  ListTasksResult,
  TaskUpdate,
  TaskStore,
} from '@a2x/sdk';
import { TaskState, TERMINAL_STATES } from '@a2x/sdk';
import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import type { Sql, SqlExecutor } from './db.js';
import { logEvent, truncate } from './log.js';
import { IDENTITY_VC_PRESENTED_METADATA_KEY } from './identity-vc/types.js';

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

interface TaskAuthorizationBinding {
  principalId?: string;
  actorId?: string;
  profileId?: string;
  authorizationKey?: string;
}

function authorizationBindingFromMetadata(
  metadata: Record<string, unknown> | undefined,
): TaskAuthorizationBinding {
  const stringValue = (key: string) => {
    const value = metadata?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    principalId: stringValue('_principalId'),
    actorId: stringValue('_actorId'),
    profileId: stringValue('_authorizationProfile'),
    authorizationKey: stringValue('_authorizationKey'),
  };
}

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

function extractAuthorizationField(
  task: Task,
  key: '_actorId' | '_authorizationProfile' | '_authorizationKey',
): string | undefined {
  for (const msg of task.history ?? []) {
    const value = (msg as MessageWithMetadata).metadata?.[key];
    if (typeof value === 'string') return value;
  }
  const statusValue = (task.status?.message as MessageWithMetadata | undefined)?.metadata?.[key];
  return typeof statusValue === 'string' ? statusValue : undefined;
}

function stripMessageMetadata(msg: Message): Message {
  const metadata = (msg as MessageWithMetadata).metadata ?? {};
  const {
    _bearerToken,
    _principalId,
    _actorId,
    _authorizationProfile,
    _authorizationKey,
    [IDENTITY_VC_PRESENTED_METADATA_KEY]: _presented,
    ...rest
  } = metadata;
  void _bearerToken;
  void _principalId;
  void _actorId;
  void _authorizationProfile;
  void _authorizationKey;
  void _presented;
  const clean = Object.keys(rest).length ? rest : undefined;
  if (clean) return { ...msg, metadata: clean };
  const { metadata: _meta, ...m } = msg as MessageWithMetadata;
  void _meta;
  return m as Message;
}

function stripTaskMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined;
  const {
    _bearerToken,
    _principalId,
    _actorId,
    _authorizationProfile,
    _authorizationKey,
    [IDENTITY_VC_PRESENTED_METADATA_KEY]: _presented,
    ...rest
  } = metadata;
  void _bearerToken;
  void _principalId;
  void _actorId;
  void _authorizationProfile;
  void _authorizationKey;
  void _presented;
  return Object.keys(rest).length > 0 ? rest : undefined;
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

export function stripSensitiveMetadata(
  task: Task,
  opts?: { preserveEnvelope?: boolean },
): Task {
  // `preserveEnvelope` keeps the request envelope on the persisted row (see
  // PostgresTaskStore's persistRequestEnvelope flag / issue #419); the
  // message-metadata scrub below (bearer token / principal) always runs
  // regardless — those must never be persisted.
  const base = opts?.preserveEnvelope ? task : stripPersistedEnvelope(task);
  const result = { ...base };
  result.metadata = stripTaskMetadata(result.metadata);
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

export interface PostgresTaskStoreOptions {
  // Retain the full inbound request envelope (`chat_completions_request`) on the
  // persisted task row instead of stripping it at write time (issue #419).
  //
  // Default (false) strips the envelope on every write — the post-#409 behavior
  // that keeps the table lean. The envelope is redundant by design (the gateway
  // re-sends the full conversation every turn) and, re-persisted per turn up to
  // MAX_CONTEXT_TASKS times per context, was the near-quadratic source of the
  // #408 disk-full incident, so stripping stays the safe default.
  //
  // Flipping it to true is an operational forensics switch: it makes every
  // persisted task a complete, replayable record of its input — needed when a
  // failure only surfaces at the very end (e.g. an error carried inside an
  // otherwise-"completed" terminal frame, which a task-state test would miss),
  // so we cannot reliably decide per-task at write time whether to keep it.
  // Ops turns it on for a debugging window and off again; it re-introduces the
  // #408 growth for as long as it is on, so it is NOT meant to be left on.
  // (Reads still strip on the hot replay path regardless — see loadByContextId.)
  persistRequestEnvelope?: boolean;

  // Restrict every task read and mutation to one owning A2A agent (issue #476).
  // Runtime request handlers must always set this; leaving it undefined is
  // reserved for maintenance jobs and low-level store tests that intentionally
  // operate across all agents.
  ownerAgent?: string;
}

// Parse the A2A_PERSIST_REQUEST_ENVELOPE env value into the store flag. Accepts
// the usual truthy spellings (case-insensitive); anything else — including
// unset, empty, "0", "false", "off", or garbage — is false, so the lean,
// disk-safe default (issue #419) holds unless it is explicitly turned on. Kept
// pure (no process.env read) so both the caller and its unit test drive it.
export function parsePersistRequestEnvelope(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw ?? '');
}

export class PostgresTaskStore implements ContextAwareTaskStore {
  private readonly persistRequestEnvelope: boolean;
  private readonly ownerAgent: string | undefined;

  constructor(
    private readonly sql: Sql,
    options?: PostgresTaskStoreOptions,
  ) {
    this.persistRequestEnvelope = options?.persistRequestEnvelope ?? false;
    this.ownerAgent = options?.ownerAgent;
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    const authorizationBinding = authorizationBindingFromMetadata(params.metadata);
    const task: Task = {
      id: randomUUID(),
      contextId: params.contextId ?? randomUUID(),
      status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
      metadata: stripTaskMetadata(params.metadata),
    };
    await this.writeTask(task, this.sql, authorizationBinding);
    // A freshly-created task is SUBMITTED, never terminal, so retention is a
    // no-op here — skip it entirely.
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = this.ownerAgent === undefined
      ? await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks WHERE task_id = ${taskId} LIMIT 1
        `
      : await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks
          WHERE task_id = ${taskId} AND owner_agent = ${this.ownerAgent}
          LIMIT 1
        `;
    // Returns the stored row verbatim — including the request envelope when
    // persistRequestEnvelope is on (issue #419); this is the forensic read path.
    // Unlike loadByContextId (hot per-turn replay), this is a single on-demand
    // fetch, so carrying the envelope here is not a bloat concern. The envelope
    // is never read back for request forwarding (the gateway re-sends it every
    // turn), so returning it here changes no execution behavior.
    return rows[0]?.task_json ?? null;
  }

  async listTasks(params: ListTasksParams): Promise<ListTasksResult> {
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
    const rawOffset = Number(params.pageToken ?? 0);
    const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const status = params.status === undefined
      ? null
      : String(params.status)
          .toLowerCase()
          .replace(/^task_state_/, '')
          .replaceAll('_', '-');
    const parsedAfter = params.statusTimestampAfter === undefined
      ? null
      : Date.parse(params.statusTimestampAfter);

    // Match InMemoryTaskStore's behavior for an invalid timestamp filter: it
    // selects no tasks rather than sending an invalid timestamptz to Postgres.
    if (parsedAfter !== null && !Number.isFinite(parsedAfter)) {
      return { tasks: [], nextPageToken: '', pageSize, totalSize: 0 };
    }

    const ownerAgent = this.ownerAgent ?? null;
    const contextId = params.contextId ?? null;
    const after = parsedAfter === null ? null : new Date(parsedAfter).toISOString();
    const countRows = await this.sql<{ total_size: string | number }[]>`
      SELECT count(*) AS total_size
      FROM infra.a2a_tasks
      WHERE (${ownerAgent}::text IS NULL OR owner_agent = ${ownerAgent})
        AND (${contextId}::text IS NULL OR context_id = ${contextId})
        AND (${status}::text IS NULL OR task_json->'status'->>'state' = ${status})
        AND (
          ${after}::timestamptz IS NULL
          OR (task_json->'status'->>'timestamp')::timestamptz >= ${after}::timestamptz
        )
    `;
    const totalSize = Number(countRows[0]?.total_size ?? 0);
    const rows = await this.sql<{ task_json: Task }[]>`
      SELECT task_json
      FROM infra.a2a_tasks
      WHERE (${ownerAgent}::text IS NULL OR owner_agent = ${ownerAgent})
        AND (${contextId}::text IS NULL OR context_id = ${contextId})
        AND (${status}::text IS NULL OR task_json->'status'->>'state' = ${status})
        AND (
          ${after}::timestamptz IS NULL
          OR (task_json->'status'->>'timestamp')::timestamptz >= ${after}::timestamptz
        )
      ORDER BY updated_at DESC, task_id DESC
      OFFSET ${offset}
      LIMIT ${pageSize}
    `;
    const tasks = rows.map(({ task_json }) => ({
      ...task_json,
      ...(params.historyLength !== undefined
        ? {
            history: params.historyLength === 0
              ? []
              : (task_json.history ?? []).slice(-params.historyLength),
          }
        : {}),
      ...(!params.includeArtifacts ? { artifacts: undefined } : {}),
    }));
    const nextOffset = offset + tasks.length;
    return {
      tasks,
      nextPageToken: nextOffset < totalSize ? String(nextOffset) : '',
      pageSize,
      totalSize,
    };
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
    let retentionStart = 0;
    let retentionMs = 0;
    try {
      const merged = await this.sql.begin(async (sql) => {
        const rows = this.ownerAgent === undefined
          ? await sql<{ task_json: Task }[]>`
              SELECT task_json FROM infra.a2a_tasks WHERE task_id = ${taskId} FOR UPDATE
            `
          : await sql<{ task_json: Task }[]>`
              SELECT task_json FROM infra.a2a_tasks
              WHERE task_id = ${taskId} AND owner_agent = ${this.ownerAgent}
              FOR UPDATE
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
      txnMs = Date.now() - startedAt;
      // Retention runs AFTER the transaction commits, on the pool connection —
      // deliberately NOT inside the FOR UPDATE transaction. Two same-context
      // tasks reaching a terminal state at once would otherwise each hold the
      // lock on their own row while the retention DELETE tries to remove the
      // OTHER's row, producing a lock-order cycle: Postgres aborts one and
      // rolls back its task-state write with it. Running retention post-commit
      // keeps the state write durable (it has already committed) and confines
      // the row lock to the single task being updated, so two updateTask calls
      // can never deadlock each other.
      retentionStart = Date.now();
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
      // ran or which phase it died in. Attribute the elapsed time to whichever
      // phase was in flight when it threw — a `begin()` throw (a wedged FOR
      // UPDATE / statement_timeout abort, the primary case this exists to
      // catch) would otherwise be misreported as `txnMs: 0`.
      if (txnMs === 0) txnMs = Date.now() - startedAt;
      else if (retentionMs === 0 && retentionStart !== 0) {
        retentionMs = Date.now() - retentionStart;
      }
      logEvent('task_store_update_error', {
        taskId,
        state: update.status?.state ?? null,
        totalMs: Date.now() - startedAt,
        txnMs,
        retentionMs,
        error: truncate(String(err), 500),
      });
      throw err;
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    if (this.ownerAgent === undefined) {
      await this.sql`DELETE FROM infra.a2a_tasks WHERE task_id = ${taskId}`;
      return;
    }
    await this.sql`
      DELETE FROM infra.a2a_tasks
      WHERE task_id = ${taskId} AND owner_agent = ${this.ownerAgent}
    `;
  }

  async loadByContextId(
    contextId: string,
    principalId: string,
    excludeTaskId?: string,
  ): Promise<Task[]> {
    const rows = this.ownerAgent === undefined
      ? excludeTaskId
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
          `
      : excludeTaskId
        ? await this.sql<{ task_json: Task }[]>`
            SELECT task_json FROM infra.a2a_tasks
            WHERE owner_agent = ${this.ownerAgent}
              AND context_id = ${contextId}
              AND owner_principal = ${principalId}
              AND task_id != ${excludeTaskId}
            ORDER BY created_at DESC, task_id DESC
            LIMIT ${MAX_CONTEXT_TASKS}
          `
        : await this.sql<{ task_json: Task }[]>`
            SELECT task_json FROM infra.a2a_tasks
            WHERE owner_agent = ${this.ownerAgent}
              AND context_id = ${contextId}
              AND owner_principal = ${principalId}
            ORDER BY created_at DESC, task_id DESC
            LIMIT ${MAX_CONTEXT_TASKS}
          `;
    // Strip the request envelope from replayed tasks unconditionally — even
    // when persistRequestEnvelope is on and the stored rows carry it (issue
    // #419). The per-turn context replay must stay lean: re-reading a large
    // cumulative envelope for up to MAX_CONTEXT_TASKS rows every turn is exactly
    // the read amplification #409 removed, and replay never needs it (the
    // gateway re-sends the envelope every turn). Forensic access to the retained
    // envelope is via getTask / SQL instead.
    return rows.map((r) => stripPersistedEnvelope(r.task_json)).reverse();
  }

  /**
   * Time-based retention. Deletes every task belonging to an agent/context
   * pair that has been idle (no task created or updated) for longer than
   * `retentionDays` AND has no in-flight (non-terminal) task.
   *
   * Pruning is agent/context-scoped rather than per-row on purpose: an
   * actively-used long-running context keeps ALL its turns for that agent (its
   * newest task's updated_at is recent, so the pair is spared), and only pairs
   * with no recent activity are reclaimed. This is the orthogonal axis to the
   * count-based cap in enforceRetention() (which bounds one agent/context pair
   * to MAX_CONTEXT_TASKS): the count cap stops one context from bloating, this
   * stops the table from growing monotonically with the number of stale
   * contexts over time (the root cause in #385). It also reclaims old terminal
   * contexts whose rows have no owner_principal, which the count-based path
   * skips.
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
      DELETE FROM infra.a2a_tasks AS task
      USING (
        SELECT owner_agent, context_id FROM infra.a2a_tasks
        GROUP BY owner_agent, context_id
        HAVING max(updated_at) < now() - ${retentionDays} * interval '1 day'
           AND count(*) FILTER (
                 WHERE state NOT IN ('completed', 'failed', 'canceled', 'rejected')
               ) = 0
      ) AS stale
      WHERE task.context_id = stale.context_id
        AND task.owner_agent IS NOT DISTINCT FROM stale.owner_agent
    `;
    return res.count;
  }

  // Write (insert-or-replace) the full task row. `sql` defaults to the pool
  // connection but updateTask passes its transaction-scoped connection so the
  // row write participates in the same FOR UPDATE transaction that read it.
  private async writeTask(
    task: Task,
    sql: SqlExecutor = this.sql,
    initialBinding?: TaskAuthorizationBinding,
  ): Promise<void> {
    const ownerPrincipal = initialBinding?.principalId ?? extractOwnerPrincipal(task);
    const ownerActor = initialBinding?.actorId ?? extractAuthorizationField(task, '_actorId');
    const authorizationProfile =
      initialBinding?.profileId ?? extractAuthorizationField(task, '_authorizationProfile');
    const authorizationKey =
      initialBinding?.authorizationKey ?? extractAuthorizationField(task, '_authorizationKey');
    const sanitized = stripSensitiveMetadata(task, {
      preserveEnvelope: this.persistRequestEnvelope,
    });
    const contextId = task.contextId ?? task.id;

    const persisted = sql.json(JSON.parse(JSON.stringify(sanitized)));
    if (this.ownerAgent === undefined) {
      await sql`
        INSERT INTO infra.a2a_tasks
          (task_id, context_id, state, task_json, owner_principal, owner_agent,
           owner_actor, authorization_profile, authorization_key)
        VALUES (
          ${task.id}, ${contextId}, ${task.status.state}, ${persisted},
          ${ownerPrincipal ?? null}, NULL, ${ownerActor ?? null},
          ${authorizationProfile ?? null}, ${authorizationKey ?? null}
        )
        ON CONFLICT (task_id) DO UPDATE SET
          context_id = EXCLUDED.context_id,
          state = EXCLUDED.state,
          task_json = EXCLUDED.task_json,
          owner_principal = COALESCE(infra.a2a_tasks.owner_principal, EXCLUDED.owner_principal),
          owner_actor = COALESCE(infra.a2a_tasks.owner_actor, EXCLUDED.owner_actor),
          authorization_profile = COALESCE(
            infra.a2a_tasks.authorization_profile,
            EXCLUDED.authorization_profile
          ),
          authorization_key = COALESCE(infra.a2a_tasks.authorization_key, EXCLUDED.authorization_key),
          updated_at = now()
      `;
      return;
    }
    await sql`
      INSERT INTO infra.a2a_tasks
        (task_id, context_id, state, task_json, owner_principal, owner_agent,
         owner_actor, authorization_profile, authorization_key)
      VALUES (
        ${task.id}, ${contextId}, ${task.status.state}, ${persisted},
        ${ownerPrincipal ?? null}, ${this.ownerAgent},
        ${ownerActor ?? null}, ${authorizationProfile ?? null}, ${authorizationKey ?? null}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state = EXCLUDED.state,
        task_json = EXCLUDED.task_json,
        owner_principal = COALESCE(infra.a2a_tasks.owner_principal, EXCLUDED.owner_principal),
        owner_actor = COALESCE(infra.a2a_tasks.owner_actor, EXCLUDED.owner_actor),
        authorization_profile = COALESCE(
          infra.a2a_tasks.authorization_profile,
          EXCLUDED.authorization_profile
        ),
        authorization_key = COALESCE(infra.a2a_tasks.authorization_key, EXCLUDED.authorization_key),
        updated_at = now()
      WHERE infra.a2a_tasks.owner_agent = EXCLUDED.owner_agent
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

    if (this.ownerAgent === undefined) {
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
      return;
    }
    await this.sql`
      DELETE FROM infra.a2a_tasks
      WHERE task_id IN (
        SELECT task_id FROM infra.a2a_tasks
        WHERE owner_agent = ${this.ownerAgent}
          AND context_id = ${contextId}
          AND owner_principal = ${ownerPrincipal}
          AND state IN ('completed', 'failed', 'canceled', 'rejected')
        ORDER BY created_at DESC, task_id DESC
        OFFSET ${MAX_CONTEXT_TASKS}
      )
    `;
  }
}
