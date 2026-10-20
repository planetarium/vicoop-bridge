import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import postgres from 'postgres';
import { ensureSchema } from './db.js';

test('ensureSchema serializes concurrent connections and releases its locks', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000,
}, async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const options = {
    max: 1,
    connection: { statement_timeout: 15_000 },
    onnotice: () => {},
  };
  const observer = postgres(databaseUrl, options);
  const workers = Array.from({ length: 6 }, () => postgres(databaseUrl, options));
  let runs: Promise<PromiseSettledResult<void>[]> | undefined;
  let locked = false;
  try {
    await ensureSchema(observer);
    const pids = await Promise.all(workers.map(async (sql) => {
      const [row] = await sql`SELECT pg_backend_pid() AS pid`;
      return row.pid as number;
    }));

    // Hold the same lock from a separate session so every worker must queue
    // before any schema DDL can run. This catches removal of the lock without
    // relying on a catalog race happening by chance.
    await observer`SELECT pg_advisory_lock(hashtext('vicoop-bridge:ensureSchema'))`;
    locked = true;
    let completed = 0;
    runs = Promise.allSettled(workers.map(async (sql) => {
      try {
        await ensureSchema(sql);
      } finally {
        completed++;
      }
    }));

    const deadline = Date.now() + 5_000;
    while (true) {
      const [row] = await observer`
        SELECT count(DISTINCT pid)::int AS count FROM pg_locks
        WHERE pid IN ${observer(pids)} AND locktype = 'advisory' AND NOT granted
      `;
      assert.equal(completed, 0, 'schema calls must wait until the lock is released');
      if (row.count === workers.length) break;
      assert.ok(Date.now() < deadline, `only ${row.count}/${workers.length} schema calls queued`);
      await delay(20);
    }

    await observer`SELECT pg_advisory_unlock(hashtext('vicoop-bridge:ensureSchema'))`;
    locked = false;
    const results = await runs;
    assert.deepEqual(results, workers.map(() => ({ status: 'fulfilled', value: undefined })));

    // Check while the sessions are still open: closing them would hide a
    // regression from transaction-scoped to session-scoped advisory locks.
    const locks = await observer`
      SELECT pid FROM pg_locks WHERE pid IN ${observer(pids)} AND locktype = 'advisory'
    `;
    assert.equal(locks.length, 0, 'completed schema calls must not retain advisory locks');
  } finally {
    try {
      if (locked) {
        await observer`SELECT pg_advisory_unlock(hashtext('vicoop-bridge:ensureSchema'))`;
      }
      await runs;
    } finally {
      await Promise.all([...workers, observer].map((sql) => sql.end({ timeout: 1 })));
    }
  }
});
