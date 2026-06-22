// Integration test for PostgresTaskStore.updateTask concurrency (issue #366).
// Runs against a real Postgres (gated on DATABASE_URL, like the other DB
// integration tests) because the bug is a lost update across the read→write
// await boundary — it cannot be reproduced without a real transaction/row
// lock. Skipped when no DATABASE_URL is configured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { TaskState } from '@a2x/sdk';
import type { Message } from '@a2x/sdk';
import { PostgresTaskStore } from './postgres-task-store.js';
import { ensureSchema } from './db.js';

const hasDb = !!process.env.DATABASE_URL;

function msg(id: string, text: string): Message {
  return { messageId: id, role: 'agent', parts: [{ kind: 'text', text }] } as unknown as Message;
}

test(
  'updateTask: concurrent updates touching different fields do not lose either write (issue #366)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // Repeat to give an unserialized read-modify-write ample chance to
      // interleave and clobber. With the FOR UPDATE row lock both writes
      // always survive, so this is deterministic under the fix.
      for (let i = 0; i < 25; i++) {
        const created = await store.createTask({});
        const taskId = created.id;

        // Mirror the real conflict: executeStream's terminal save writes
        // history (+status), message/cancel's save writes only status.
        // Here we split them so each call sets a field the other leaves
        // untouched — a lost update would drop one of them.
        const history = [msg(`h-${i}`, 'streamed message')];
        const canceledStatus = {
          state: TaskState.CANCELED,
          timestamp: new Date().toISOString(),
        };

        await Promise.all([
          store.updateTask(taskId, { history }),
          store.updateTask(taskId, { status: canceledStatus }),
        ]);

        const final = await store.getTask(taskId);
        assert.ok(final, `task ${taskId} must exist after concurrent updates`);
        // history written by call A must survive call B's status-only write
        assert.equal(
          final.history?.length,
          1,
          `iteration ${i}: history was lost (overwritten by the status-only update)`,
        );
        assert.equal(final.history?.[0]?.messageId, `h-${i}`);
        // status written by call B must survive call A's history-only write
        assert.equal(
          final.status.state,
          TaskState.CANCELED,
          `iteration ${i}: status was lost (overwritten by the history-only update)`,
        );

        await store.deleteTask(taskId);
      }
    } finally {
      await sql.end();
    }
  },
);
