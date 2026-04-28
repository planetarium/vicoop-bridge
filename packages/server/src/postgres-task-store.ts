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

function extractOwnerWallet(task: Task): string | undefined {
  for (const msg of task.history ?? []) {
    const wallet = (msg as MessageWithMetadata).metadata?._walletAddress;
    if (typeof wallet === 'string') return wallet.toLowerCase();
  }
  const statusWallet = (task.status?.message as MessageWithMetadata | undefined)?.metadata
    ?._walletAddress;
  if (typeof statusWallet === 'string') return statusWallet.toLowerCase();
  return undefined;
}

function stripMessageMetadata(msg: Message): Message {
  const { _bearerToken, _walletAddress, ...rest } =
    (msg as MessageWithMetadata).metadata ?? {};
  void _bearerToken;
  void _walletAddress;
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
  loadByContextId(contextId: string, walletAddress: string, excludeTaskId?: string): Promise<Task[]>;
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
    walletAddress: string,
    excludeTaskId?: string,
  ): Promise<Task[]> {
    const rows = excludeTaskId
      ? await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks
          WHERE context_id = ${contextId}
            AND owner_wallet = ${walletAddress.toLowerCase()}
            AND task_id != ${excludeTaskId}
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${MAX_CONTEXT_TASKS}
        `
      : await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM infra.a2a_tasks
          WHERE context_id = ${contextId}
            AND owner_wallet = ${walletAddress.toLowerCase()}
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${MAX_CONTEXT_TASKS}
        `;
    return rows.map((r) => r.task_json).reverse();
  }

  private async upsert(task: Task): Promise<void> {
    const ownerWallet = extractOwnerWallet(task);
    const sanitized = stripSensitiveMetadata(task);
    const contextId = task.contextId ?? task.id;

    await this.sql`
      INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_wallet)
      VALUES (
        ${task.id},
        ${contextId},
        ${task.status.state},
        ${this.sql.json(JSON.parse(JSON.stringify(sanitized)))},
        ${ownerWallet ?? null}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state = EXCLUDED.state,
        task_json = EXCLUDED.task_json,
        owner_wallet = COALESCE(infra.a2a_tasks.owner_wallet, EXCLUDED.owner_wallet),
        updated_at = now()
    `;

    // Enforce retention only when this task reaches a terminal state
    const isTerminal = TERMINAL_STATES.has(task.status.state);
    if (ownerWallet && isTerminal) {
      await this.sql`
        DELETE FROM infra.a2a_tasks
        WHERE task_id IN (
          SELECT task_id FROM infra.a2a_tasks
          WHERE context_id = ${contextId}
            AND owner_wallet = ${ownerWallet}
            AND state IN ('completed', 'failed', 'canceled', 'rejected')
          ORDER BY created_at DESC, task_id DESC
          OFFSET ${MAX_CONTEXT_TASKS}
        )
      `;
    }
  }
}
