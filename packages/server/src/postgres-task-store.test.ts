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

// A terminal status carrying the principal in message metadata, which is how
// owner_principal is derived (extractOwnerPrincipal reads status.message
// .metadata._principalId). Needed for the retention path, which only fires
// for owned terminal tasks.
function ownedTerminalStatus(principalId: string, id: string) {
  return {
    state: TaskState.COMPLETED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: id,
      role: 'agent',
      parts: [{ kind: 'text', text: 'done' }],
      metadata: { _principalId: principalId },
    },
  } as unknown as Parameters<PostgresTaskStore['updateTask']>[1]['status'];
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

test(
  'updateTask: retention still trims a context to MAX_CONTEXT_TASKS terminal tasks after moving it post-commit',
  { skip: !hasDb },
  async () => {
    // Guards the refactor that pulled the retention DELETE out of the FOR
    // UPDATE transaction: terminal-task GC must still cap a context at 10.
    const sql = postgres(process.env.DATABASE_URL!);
    const principalId = `eth:0xretention-${Date.now()}`;
    const contextId = `ctx-retention-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // 15 owned tasks in one context, each driven to a terminal state.
      const ids: string[] = [];
      for (let i = 0; i < 15; i++) {
        const created = await store.createTask({ contextId });
        ids.push(created.id);
        await store.updateTask(created.id, { status: ownedTerminalStatus(principalId, `m-${i}`) });
      }

      const remaining = await store.loadByContextId(contextId, principalId);
      assert.equal(remaining.length, 10, 'context must be trimmed to MAX_CONTEXT_TASKS (10)');
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

test(
  'updateTask: concurrent terminal updates in the same context do not deadlock and both persist (issue #366 retention)',
  { skip: !hasDb },
  async () => {
    // With retention inside the FOR UPDATE transaction, two same-context
    // tasks going terminal at once could lock each other's rows (one holds
    // its own row, the other's retention DELETE wants it) → deadlock, and the
    // aborted txn loses its state write. Post-commit retention confines the
    // lock to the single updated row, so this must always succeed.
    const sql = postgres(process.env.DATABASE_URL!);
    const principalId = `eth:0xdeadlock-${Date.now()}`;
    const contextId = `ctx-deadlock-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // Seed >MAX_CONTEXT_TASKS terminal tasks so the retention DELETE fires.
      for (let i = 0; i < 11; i++) {
        const seed = await store.createTask({ contextId });
        await store.updateTask(seed.id, { status: ownedTerminalStatus(principalId, `seed-${i}`) });
      }

      // Two fresh tasks in the same context, terminalized concurrently.
      const a = await store.createTask({ contextId });
      const b = await store.createTask({ contextId });
      for (let round = 0; round < 20; round++) {
        const results = await Promise.allSettled([
          store.updateTask(a.id, { status: ownedTerminalStatus(principalId, `a-${round}`) }),
          store.updateTask(b.id, { status: ownedTerminalStatus(principalId, `b-${round}`) }),
        ]);
        for (const r of results) {
          assert.equal(r.status, 'fulfilled', `round ${round}: updateTask must not throw/deadlock`);
        }
      }
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);
