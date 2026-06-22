import { randomUUID } from 'node:crypto';
import type {
  Task,
  Message,
  CreateTaskParams,
  TaskUpdate,
  TaskStore,
} from '@a2x/sdk';
import { TaskState, TERMINAL_STATES } from '@a2x/sdk';
import type { Sql } from './db.js';

const MAX_CONTEXT_TASKS = 10;

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

function stripSensitiveMetadata(task: Task): Task {
  const result = { ...task };
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
    await this.upsert(task);
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = await this.sql<{ task_json: Task }[]>`
      SELECT task_json FROM infra.a2a_tasks WHERE task_id = ${taskId} LIMIT 1
    `;
    return rows[0]?.task_json ?? null;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    const existing = await this.getTask(taskId);
    if (!existing) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const merged: Task = { ...existing };
    if (update.status !== undefined) merged.status = update.status;
    if (update.artifacts !== undefined) merged.artifacts = update.artifacts;
    if (update.history !== undefined) merged.history = update.history;
    if (update.metadata !== undefined) merged.metadata = update.metadata;
    await this.upsert(merged);
    return merged;
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
   * been idle (no task created or updated) for longer than `retentionDays`.
   *
   * Pruning is context-scoped rather than per-row on purpose: an actively-used
   * long-running context keeps ALL its turns (its newest task's updated_at is
   * recent, so the whole context is spared), and only contexts with no recent
   * activity are reclaimed. This is the orthogonal axis to the count-based cap
   * in upsert() (which bounds a single context to MAX_CONTEXT_TASKS): the count
   * cap stops one context from bloating, this stops the table from growing
   * monotonically with the number of stale contexts over time (the root cause
   * in #385). It also reclaims stuck non-terminal tasks and orphaned rows with
   * no owner_principal that the count-based path never touches.
   *
   * Purely timestamp-driven (no dependence on task_json contents). Returns the
   * number of rows deleted.
   */
  async pruneStaleContexts(retentionDays: number): Promise<number> {
    const res = await this.sql`
      DELETE FROM infra.a2a_tasks
      WHERE context_id IN (
        SELECT context_id FROM infra.a2a_tasks
        GROUP BY context_id
        HAVING max(updated_at) < now() - ${retentionDays} * interval '1 day'
      )
    `;
    return res.count;
  }

  private async upsert(task: Task): Promise<void> {
    const ownerPrincipal = extractOwnerPrincipal(task);
    const sanitized = stripSensitiveMetadata(task);
    const contextId = task.contextId ?? task.id;

    await this.sql`
      INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_principal)
      VALUES (
        ${task.id},
        ${contextId},
        ${task.status.state},
        ${this.sql.json(JSON.parse(JSON.stringify(sanitized)))},
        ${ownerPrincipal ?? null}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state = EXCLUDED.state,
        task_json = EXCLUDED.task_json,
        owner_principal = COALESCE(infra.a2a_tasks.owner_principal, EXCLUDED.owner_principal),
        updated_at = now()
    `;

    // Enforce retention only when this task reaches a terminal state
    const isTerminal = TERMINAL_STATES.has(task.status.state);
    if (ownerPrincipal && isTerminal) {
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
}
