import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PostgresTaskStore } from './postgres-task-store.js';

// pruneStaleContexts is timestamp-only, but exercising it meaningfully needs a
// real table (controlled created_at/updated_at), so these are DB-gated.
const hasDb = !!process.env.DATABASE_URL;

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

test(
  'pruneStaleContexts reclaims idle contexts but spares active ones (incl. their old turns)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
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
