import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'caller-identity-')));
  const store = new CallerRuntimeStore(directory, 'agent');
  t.after(async () => {
    await store.unlock();
    await rm(directory, { recursive: true, force: true });
  });
  const id = scopeDigest('agent', 'alice');
  const path = join(directory, `${id}.json`);
  return {
    directory,
    store,
    id,
    path,
    read: async () => JSON.parse(await readFile(path, 'utf8')),
  };
}

test('verified identity persists privately across restart and identity-free reconciliation', async (t) => {
  const f = await fixture(t);
  await f.store.lock();
  await f.store.reserve(f.id, 'claude', 'alice');
  assert.deepEqual(await f.read(), {
    version: 3,
    id: f.id,
    kind: 'claude',
    namespace: f.store.namespace,
    agentId: 'agent',
    principalId: 'alice',
  });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await f.store.unlock();
  await f.store.lock();
  await f.store.reserve(f.id, 'claude');
  assert.equal((await f.read()).principalId, 'alice');
  await assert.rejects(
    f.store.reserve(f.id, 'claude', 'bob'),
    /identity mismatch/,
  );
  await assert.rejects(
    f.store.reserve(f.id, 'codex', 'alice'),
    /identity mismatch/,
  );
  assert.equal((await f.read()).principalId, 'alice');
});

test('legacy manifest and hash-only records migrate without guessing identity', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, 'manifest.json'),
    JSON.stringify({ version: 2, agentId: 'agent', host: hostname() }),
  );
  // Property order is not part of the disk schema.
  await writeFile(
    f.path,
    JSON.stringify({ namespace: f.store.namespace, kind: 'codex', id: f.id }),
  );
  await f.store.lock();
  assert.equal(
    JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8'))
      .version,
    3,
  );
  await f.store.reserve(f.id, 'codex');
  assert.equal((await f.read()).principalId, null);
  await f.store.unlock();
  await f.store.lock();
  await f.store.reserve(f.id, 'codex', 'alice');
  assert.equal((await f.read()).principalId, 'alice');
});

test('invalid identity is rejected before a record is created', async (t) => {
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
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await f.store.unlock();
  await assert.rejects(
    f.store.reserve(f.id, 'claude', 'alice'),
    /exclusive ownership/,
  );
});

test('corrupt, mismatched or unsupported records are never overwritten', async (t) => {
  const f = await fixture(t);
  await f.store.lock();
  await f.store.reserve(f.id, 'claude', 'alice');
  const original = await f.read();
  for (const changes of [
    { version: 4 },
    { agentId: 'other' },
    { principalId: 'bob' },
    { namespace: 'other' },
    { id: scopeDigest('agent', 'bob') },
    { token: 'unexpected' },
  ]) {
    const content = JSON.stringify({ ...original, ...changes });
    await writeFile(f.path, content);
    await assert.rejects(f.store.reserve(f.id, 'claude', 'alice'));
    assert.equal(await readFile(f.path, 'utf8'), content);
  }
});

test('unknown manifest versions fail closed', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, 'manifest.json'),
    JSON.stringify({ version: 4, agentId: 'agent', host: hostname() }),
  );
  await assert.rejects(f.store.lock(), /incompatible/);
});
