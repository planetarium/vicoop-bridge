import type { Task } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { Sql } from './db.js';

const MAX_CONTEXT_TASKS = 10;

export class PostgresTaskStore implements TaskStore {
  constructor(private readonly sql: Sql) {}

  async save(task: Task): Promise<void> {
    await this.sql`
      INSERT INTO a2a_tasks (task_id, context_id, state, task_json)
      VALUES (${task.id}, ${task.contextId}, ${task.status.state}, ${this.sql.json(task as never)})
      ON CONFLICT (task_id) DO UPDATE SET
        context_id = EXCLUDED.context_id,
        state = EXCLUDED.state,
        task_json = EXCLUDED.task_json,
        updated_at = now()
    `;
  }

  async load(taskId: string): Promise<Task | undefined> {
    const rows = await this.sql<{ task_json: Task }[]>`
      SELECT task_json FROM a2a_tasks WHERE task_id = ${taskId} LIMIT 1
    `;
    return rows[0]?.task_json;
  }

  async loadByContextId(contextId: string, excludeTaskId?: string): Promise<Task[]> {
    const rows = excludeTaskId
      ? await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM a2a_tasks
          WHERE context_id = ${contextId} AND task_id != ${excludeTaskId}
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${MAX_CONTEXT_TASKS}
        `
      : await this.sql<{ task_json: Task }[]>`
          SELECT task_json FROM a2a_tasks
          WHERE context_id = ${contextId}
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${MAX_CONTEXT_TASKS}
        `;
    return rows.map((r) => r.task_json).reverse();
  }
}
