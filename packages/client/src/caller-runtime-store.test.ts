import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  stat,
  rm,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';
import { openCallerDatabase } from './caller-runtime-sqlite.js';

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'caller-identity-')),
  );
  const store = new CallerRuntimeStore(directory, 'agent');
  t.after(async () => {
    await store.unlock();
    await rm(directory, { recursive: true, force: true });
  });
  const id = scopeDigest('agent', 'alice');
  const path = join(directory, 'state.sqlite');
  const jsonPath = join(directory, `${id}.json`);
  const manifestPath = join(directory, 'manifest.json');
  const record = {
    id,
    kind: 'claude',
    namespace: store.namespace,
    agentId: 'agent',
    principalId: 'alice',
  };
  return {
    directory,
    store,
    id,
    path,
    jsonPath,
    manifestPath,
    record,
    async sql(sql: string, ...args: (string | number | null)[]) {
      const db = await openCallerDatabase(path);
      try {
        return db.prepare(sql).all(...args);
      } finally {
        db.close();
      }
    },
    async execute(sql: string, ...args: (string | number | null)[]) {
      const db = await openCallerDatabase(path);
      try {
        db.prepare(sql).run(...args);
      } finally {
        db.close();
      }
    },
    async read() {
      const db = await openCallerDatabase(path);
      try {
        return db.prepare('SELECT * FROM scopes WHERE id = ?').get(id);
      } finally {
        db.close();
      }
    },
    async legacy(version = 3) {
      await writeFile(
        manifestPath,
        JSON.stringify({ version, agentId: 'agent', host: hostname() }),
      );
      const { id, kind, namespace } = record;
      await writeFile(
        jsonPath,
        JSON.stringify(
          version === 2 ? { id, kind, namespace } : { version: 3, ...record },
        ),
      );
    },
  };
}

test('SQLite identity persists privately across restart and identity-free reconciliation', async (t) => {
  const f = await fixture(t);
  await f.store.lock();
  assert.equal(await f.store.reserve(f.id, 'claude', 'alice'), true);
  assert.deepEqual(await f.read(), f.record);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal(
    (await readFile(f.path)).subarray(0, 16).toString(),
    'SQLite format 3\0',
  );
  assert.deepEqual(await f.sql('PRAGMA user_version'), [{ user_version: 4 }]);
  await assert.rejects(readFile(f.jsonPath), { code: 'ENOENT' });
  await f.store.unlock();
  await f.store.lock();
  assert.equal(await f.store.reserve(f.id, 'claude'), false);
  assert.deepEqual(await f.read(), f.record);
  await assert.rejects(
    f.store.reserve(f.id, 'claude', 'bob'),
    /identity mismatch/,
  );
  await assert.rejects(
    f.store.reserve(f.id, 'codex', 'alice'),
    /identity mismatch/,
  );
  assert.deepEqual(await f.read(), f.record);
});

test('legacy hash-only records migrate without guessing identity, then accept a validated mapping', async (t) => {
  const f = await fixture(t);
  await f.legacy(2);
  await f.store.lock();
  assert.deepEqual(await f.read(), { ...f.record, principalId: null });
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).version, 4);
  await f.store.reserve(f.id, 'claude');
  await f.store.unlock();
  await f.store.lock();
  await f.store.reserve(f.id, 'claude', 'alice');
  assert.deepEqual(await f.read(), f.record);
});

test('v3 JSON identities and mixed legacy records migrate together', async (t) => {
  const f = await fixture(t);
  await f.legacy();
  const bob = scopeDigest('agent', 'bob');
  await writeFile(
    join(f.directory, `${bob}.json`),
    JSON.stringify({ id: bob, kind: 'claude', namespace: f.store.namespace }),
  );
  await f.store.lock();
  assert.deepEqual(await f.read(), f.record);
  assert.deepEqual(await f.store.scopes(), [f.id, bob].sort());
  assert.deepEqual(
    await f.sql('SELECT principalId FROM scopes WHERE id = ?', bob),
    [{ principalId: null }],
  );
});

test('invalid identity is rejected before insertion and writes require exclusive ownership', async (t) => {
  const f = await fixture(t);
  await f.store.lock();
  await assert.rejects(
    f.store.reserve(f.id, 'claude', 'bob'),
    /identity mismatch/,
  );
  await assert.rejects(
    f.store.reserve(f.id, 'claude', ''),
    /identity mismatch/,
  );
  assert.equal((await f.read()) ?? null, null);
  await f.store.unlock();
  await assert.rejects(
    f.store.reserve(f.id, 'claude', 'alice'),
    /exclusive ownership/,
  );
  await assert.rejects(f.store.forget(f.id), /exclusive ownership/);
});

test('invalid JSON aborts the entire import and preserves sources for retry', async (t) => {
  const f = await fixture(t);
  await f.legacy();
  const bob = scopeDigest('agent', 'bob');
  const badPath = join(f.directory, `${bob}.json`);
  await writeFile(
    badPath,
    JSON.stringify({ version: 3, ...f.record, id: bob }),
  );
  const original = await readFile(f.jsonPath, 'utf8');
  await assert.rejects(f.store.lock(), /identity mismatch/);
  assert.deepEqual(await f.sql('PRAGMA user_version'), [{ user_version: 0 }]);
  assert.deepEqual(
    await f.sql("SELECT name FROM sqlite_master WHERE type = 'table'"),
    [],
  );
  assert.equal(await readFile(f.jsonPath, 'utf8'), original);
  await rm(badPath);
  await f.store.lock();
  assert.deepEqual(await f.read(), f.record);
});

test('corrupt, mismatched or unsupported JSON records are not imported', async (t) => {
  for (const changes of [
    { version: 4 },
    { agentId: 'other' },
    { principalId: 'bob' },
    { namespace: 'other' },
    { id: scopeDigest('agent', 'bob') },
    { token: 'unexpected' },
  ]) {
    const f = await fixture(t);
    await f.legacy();
    const content = JSON.stringify({ version: 3, ...f.record, ...changes });
    await writeFile(f.jsonPath, content);
    await assert.rejects(f.store.lock());
    assert.equal(await readFile(f.jsonPath, 'utf8'), content);
  }
});

test('interruption before database creation resumes JSON migration', async (t) => {
  const f = await fixture(t);
  await f.legacy();
  await writeFile(
    f.manifestPath,
    JSON.stringify({
      version: 4,
      agentId: 'agent',
      host: hostname(),
      migration: 'json',
    }),
  );
  await f.store.lock();
  assert.deepEqual(await f.read(), f.record);
});

test('interruption after commit never reimports stale JSON or resurrects deleted scopes', async (t) => {
  const f = await fixture(t);
  await f.legacy();
  await f.store.lock();
  await f.store.forget(f.id);
  await assert.rejects(readFile(f.jsonPath), { code: 'ENOENT' });
  // Simulate a backup left behind by interruption after the SQL delete.
  await writeFile(f.jsonPath, JSON.stringify({ version: 3, ...f.record }));
  await f.store.unlock();
  await writeFile(
    f.manifestPath,
    JSON.stringify({
      version: 4,
      agentId: 'agent',
      host: hostname(),
      migration: 'json',
    }),
  );
  await f.store.lock();
  assert.deepEqual(await f.store.scopes(), []);
  await f.store.unlock();
  await f.store.lock();
  assert.deepEqual(await f.store.scopes(), []);
});

test('missing committed database is not silently recreated from stale JSON', async (t) => {
  const f = await fixture(t);
  await f.legacy();
  await f.store.lock();
  await f.store.unlock();
  await rm(f.path);
  await assert.rejects(f.store.lock(), /incomplete/);
});

test('unsupported manifest and database versions fail closed', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.manifestPath,
    JSON.stringify({ version: 5, agentId: 'agent', host: hostname() }),
  );
  await assert.rejects(f.store.lock(), /incompatible/);
  await rm(f.manifestPath);
  await f.store.lock();
  await f.store.unlock();
  await f.execute('PRAGMA user_version = 5');
  await assert.rejects(f.store.lock(), /incompatible/);
});

test('database identity tampering is rejected on restart and reserve', async (t) => {
  const f = await fixture(t);
  await f.store.lock();
  await f.store.reserve(f.id, 'claude', 'alice');
  await f.execute('UPDATE scopes SET principalId = ?', 'bob');
  await assert.rejects(
    f.store.reserve(f.id, 'claude', 'alice'),
    /identity mismatch/,
  );
  await f.store.unlock();
  await assert.rejects(f.store.lock(), /identity mismatch/);
});

test('ownership conflict cannot close or modify the active store', async (t) => {
  const f = await fixture(t);
  await f.store.lock();
  await assert.rejects(f.store.lock(), /live owner/);
  const other = new CallerRuntimeStore(f.directory, 'agent');
  await assert.rejects(other.lock(), /live owner/);
  await f.store.reserve(f.id, 'claude', 'alice');
  assert.deepEqual(await f.read(), f.record);
});
