import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';

test('state ownership protects live owners and agent identity across unlock/restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caller-store-'));
  const first = new CallerRuntimeStore(directory, 'agent');
  const second = new CallerRuntimeStore(directory, 'agent');
  try {
    await first.lock();
    await assert.rejects(second.lock(), /live owner/);
    assert.throws(() => first.path('../victim'), /invalid/);
    await first.unlock();
    await assert.rejects(
      new CallerRuntimeStore(directory, 'other').lock(),
      /manifest/,
    );
    await second.lock();
    await second.unlock();
  } finally {
    await first.unlock();
    await second.unlock();
    await rm(directory, { recursive: true });
  }
});

test('stale ownership recovery discards pending snapshot but retains committed data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caller-store-'));
  const store = new CallerRuntimeStore(directory, 'agent');
  const id = scopeDigest('agent', 'apikey:a');
  try {
    await store.lock();
    await store.unlock();
    await writeFile(
      join(directory, 'owner.json'),
      JSON.stringify({
        pid: 2147483647,
        host: hostname(),
        agentId: 'agent',
        token: 'dead',
      }),
    );
    await writeFile(store.path(id), 'committed');
    await writeFile(store.path(id, true), 'partial');
    await store.lock();
    assert.equal(await readFile(store.path(id), 'utf8'), 'committed');
    await assert.rejects(readFile(store.path(id, true)), { code: 'ENOENT' });
    assert.deepEqual(await store.scopes(), [id]);
  } finally {
    await store.unlock();
    await rm(directory, { recursive: true });
  }
});

test('state directories with public permissions fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'caller-store-'));
  try {
    await chmod(directory, 0o755);
    await assert.rejects(
      new CallerRuntimeStore(directory, 'a').lock(),
      /private/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
