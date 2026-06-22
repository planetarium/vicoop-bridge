// Integration tests for PostgresTaskStore against a real Postgres, gated on
// DATABASE_URL (like the other DB integration tests in this package):
//   - updateTask concurrency / lost-update serialization (issue #366)
//   - pruneStaleContexts time-based retention (issue #385)
// Both need a real table (transactions / row locks / controlled timestamps),
// so they cannot be exercised without a database and are skipped otherwise.

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
// .metadata._principalId). Needed for the count-based retention path, which
// only fires for owned terminal tasks.
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

// Insert a row straight into infra.a2a_tasks aged by `age` (a Postgres interval
// literal like '40 days'), so we can simulate stale contexts without waiting.
async function seed(
  sql: postgres.Sql,
  row: { taskId: string; contextId: string; state: string; age: string },
): Promise<void> {
  await sql`
    INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_principal, created_at, updated_at)
    VALUES (
      ${row.taskId}, ${row.contextId}, ${row.state},
      ${sql.json({ id: row.taskId, contextId: row.contextId })},
      ${'eth:0xtest'},
      now() - ${row.age}::interval, now() - ${row.age}::interval
    )
  `;
}

// ── updateTask concurrency (issue #366) ─────────────────────────────────────

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
      // always survive, so this is deterministic under the fix. Detecting the
      // *bug* is probabilistic — it relies on the two Promise.all calls
      // actually interleaving on the connection pool; on a degenerate
      // single-connection setup that serialized them it could false-pass. In
      // practice (and as verified by running this against the pre-fix code,
      // which failed on iteration 1) the pool interleaves reliably.
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
    // Guards the refactor that pulled the count-based retention DELETE out of
    // the FOR UPDATE transaction: terminal-task GC must still cap a context at 10.
    const sql = postgres(process.env.DATABASE_URL!);
    const principalId = `eth:0xretention-${Date.now()}`;
    const contextId = `ctx-retention-${Date.now()}`;
    try {
      await ensureSchema(sql);
      const store = new PostgresTaskStore(sql);

      // 15 owned tasks in one context, each driven to a terminal state.
      for (let i = 0; i < 15; i++) {
        const created = await store.createTask({ contextId });
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

      // Seed MAX_CONTEXT_TASKS terminal tasks so the context already sits at
      // the retention cap before each round.
      for (let i = 0; i < 10; i++) {
        const seedTask = await store.createTask({ contextId });
        await store.updateTask(seedTask.id, { status: ownedTerminalStatus(principalId, `seed-${i}`) });
      }

      // Each round introduces TWO fresh tasks and terminalizes them
      // concurrently. With the context already at the cap, both rounds'
      // retention DELETEs fire every time (the two new terminal rows push the
      // count over MAX_CONTEXT_TASKS) — so the lock window that the in-txn
      // version deadlocked on is exercised on every round, not just the first.
      for (let round = 0; round < 20; round++) {
        const a = await store.createTask({ contextId });
        const b = await store.createTask({ contextId });
        const results = await Promise.allSettled([
          store.updateTask(a.id, { status: ownedTerminalStatus(principalId, `a-${round}`) }),
          store.updateTask(b.id, { status: ownedTerminalStatus(principalId, `b-${round}`) }),
        ]);
        for (const r of results) {
          assert.equal(
            r.status,
            'fulfilled',
            `round ${round}: updateTask must not throw/deadlock — ${
              r.status === 'rejected' ? String(r.reason) : ''
            }`,
          );
        }
      }
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE context_id = ${contextId}`;
      await sql.end();
    }
  },
);

// ── pruneStaleContexts time-based retention (issue #385) ────────────────────

test(
  'pruneStaleContexts reclaims idle contexts but spares active ones (incl. their old turns)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    await ensureSchema(sql);
    const store = new PostgresTaskStore(sql);
    const tag = `prune-${Date.now()}`;

    try {
      // Context A: fully idle (single old terminal task) -> should be deleted.
      await seed(sql, { taskId: `${tag}-a1`, contextId: `${tag}-ctxA`, state: 'completed', age: '40 days' });

      // Context B: active — one OLD turn + one RECENT turn. The whole context
      // (including the old turn) must survive because it's still in use.
      await seed(sql, { taskId: `${tag}-b1`, contextId: `${tag}-ctxB`, state: 'completed', age: '40 days' });
      await seed(sql, { taskId: `${tag}-b2`, contextId: `${tag}-ctxB`, state: 'completed', age: '1 hour' });

      const deleted = await store.pruneStaleContexts(30);
      assert.equal(deleted, 1, 'exactly the one idle context A row is deleted');

      const surviving = await sql<{ task_id: string }[]>`
        SELECT task_id FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'} ORDER BY task_id
      `;
      assert.deepEqual(
        surviving.map((r) => r.task_id),
        [`${tag}-b1`, `${tag}-b2`],
        'idle context A gone; active context B fully retained (old turn included)',
      );
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'}`;
      await sql.end();
    }
  },
);

test(
  'pruneStaleContexts spares an idle context that still holds an in-flight task',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    await ensureSchema(sql);
    const store = new PostgresTaskStore(sql);
    const tag = `prune-inflight-${Date.now()}`;
    try {
      // Old, but non-terminal (working): a legitimately long-running task whose
      // updated_at is frozen at creation. Must NOT be reaped out from under the
      // live executor even though the context looks idle by timestamp.
      await seed(sql, { taskId: `${tag}-1`, contextId: `${tag}-ctx`, state: 'working', age: '40 days' });
      const deleted = await store.pruneStaleContexts(30);
      assert.equal(deleted, 0, 'context with an in-flight task is spared');
      const after = await sql<{ c: number }[]>`
        SELECT count(*)::int c FROM infra.a2a_tasks WHERE task_id = ${tag + '-1'}
      `;
      assert.equal(after[0]!.c, 1);
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'}`;
      await sql.end();
    }
  },
);

test(
  'pruneStaleContexts leaves a fresh context untouched',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    await ensureSchema(sql);
    const store = new PostgresTaskStore(sql);
    const tag = `prune-fresh-${Date.now()}`;
    try {
      await seed(sql, { taskId: `${tag}-1`, contextId: `${tag}-ctx`, state: 'completed', age: '0 seconds' });
      await store.pruneStaleContexts(30);
      const after = await sql<{ c: number }[]>`
        SELECT count(*)::int c FROM infra.a2a_tasks WHERE task_id = ${tag + '-1'}
      `;
      assert.equal(after[0]!.c, 1, 'fresh context survives');
    } finally {
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id LIKE ${tag + '-%'}`;
      await sql.end();
    }
  },
);
