import type { Task, Message } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
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
  const clean = Object.keys(rest).length ? rest : undefined;
  if (clean) return { ...msg, metadata: clean } as Message;
  const { metadata: _, ...m } = msg as MessageWithMetadata;
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

  async save(task: Task): Promise<void> {
    const ownerWallet = extractOwnerWallet(task);
    const sanitized = stripSensitiveMetadata(task);

    await this.sql`
      INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_wallet)
      VALUES (
        ${task.id},
        ${task.contextId},
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
    const isTerminal = ['completed', 'failed', 'canceled'].includes(task.status.state);
    if (ownerWallet && isTerminal) {
      await this.sql`
        DELETE FROM infra.a2a_tasks
        WHERE task_id IN (
          SELECT task_id FROM infra.a2a_tasks
          WHERE context_id = ${task.contextId}
            AND owner_wallet = ${ownerWallet}
            AND state IN ('completed', 'failed', 'canceled')
          ORDER BY created_at DESC, task_id DESC
          OFFSET ${MAX_CONTEXT_TASKS}
        )
      `;
    }
  }

  async load(taskId: string): Promise<Task | undefined> {
    const rows = await this.sql<{ task_json: Task }[]>`
      SELECT task_json FROM infra.a2a_tasks WHERE task_id = ${taskId} LIMIT 1
    `;
    return rows[0]?.task_json;
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
}
