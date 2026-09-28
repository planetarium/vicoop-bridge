// Also compiled in CI: proves the standalone binary includes usable SQLite.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CallerRuntimeStore,
  scopeDigest,
} from '../src/caller-runtime-store.js';
import { openCallerDatabase } from '../src/caller-runtime-sqlite.js';

const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'caller-store-smoke-')),
);
const store = new CallerRuntimeStore(directory, 'smoke');
const id = scopeDigest('smoke', 'alice');
try {
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ version: 2, agentId: 'smoke', host: hostname() }),
  );
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({ id, kind: 'claude', namespace: store.namespace }),
  );
  await store.lock();
  await store.reserve(id, 'claude', 'alice');
  await store.unlock();
  await store.lock();
  assert.deepEqual(await store.scopes(), [id]);
  const db = await openCallerDatabase(join(directory, 'state.sqlite'));
  try {
    assert.deepEqual(
      db
        .prepare('SELECT agentId, principalId FROM scopes WHERE id = ?')
        .get(id),
      { agentId: 'smoke', principalId: 'alice' },
    );
  } finally {
    db.close();
  }
  await store.forget(id);
  await store.unlock();
  await store.lock();
  assert.deepEqual(await store.scopes(), []);
  console.log('SQLite migration, persistence and deletion smoke passed');
} finally {
  await store.unlock();
  await rm(directory, { recursive: true, force: true });
}
