import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupDirectory, SETUP_SCRIPT, setupCallerEnvironment } from './caller-environment-setup.js';
import { runBoundedCommand } from './docker-command.js';
import type { DockerCallerRuntimePool } from './caller-runtime-docker.js';

test('copies private executable files, refuses collisions, explicit replacement preserves unrelated files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'caller-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), dest = join(root, 'dest');
  await mkdir(source); await mkdir(dest); await mkdir(join(source, 'tools'));
  await writeFile(join(source, 'tools', 'deploy'), 'secret', { mode: 0o755 });
  const entries = await readSetupDirectory(source);
  const apply = (replace = false) => runBoundedCommand(process.execPath, ['-e', SETUP_SCRIPT, dest], { input: Buffer.from(JSON.stringify({ entries, replace })) });
  assert.equal((await apply()).exitCode, 0);
  assert.equal((await stat(join(dest, 'tools', 'deploy'))).mode & 0o777, 0o700);
  await writeFile(join(dest, 'keep'), 'user data');
  assert.notEqual((await apply()).exitCode, 0);
  assert.equal((await apply(true)).exitCode, 0);
  assert.equal(await readFile(join(dest, 'keep'), 'utf8'), 'user data');
  await rm(join(dest, 'tools'), { recursive: true });
  await symlink(source, join(dest, 'tools'));
  const refused = await apply(true);
  assert.notEqual(refused.exitCode, 0);
  assert.ok(!refused.stderr.includes('secret'));
  await symlink(join(source, 'tools'), join(source, 'link'));
  await assert.rejects(readSetupDirectory(source), /symlinks/);
});

test('pending and failed setup gate persist; retry only publishes ready after confirmed stop', async t => {
  const source = await mkdtemp(join(tmpdir(), 'caller-setup-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, 'token'), 'SECRET');
  let state: { version: string; ready: boolean } | undefined;
  const events: string[] = [];
  const pool = {
    prepare: async () => ({ id: 'scope', name: 'container' }),
    store: {
      preparation: async () => state,
      setPreparation: async (_id: string, version: string, ready: boolean) => { events.push(ready ? 'ready' : 'pending'); state = { version, ready }; },
    },
    checkStorage: async () => { events.push('check'); },
    stop: async () => { events.push('stop'); },
  } as unknown as DockerCallerRuntimePool;
  await setupCallerEnvironment(pool, { principalId: 'alice', version: 'v1', pending: true });
  assert.deepEqual(state, { version: 'v1', ready: false });
  await assert.rejects(setupCallerEnvironment(pool, { principalId: 'alice', version: 'v1', from: source }, async () => { throw new Error('SECRET'); }), e => e instanceof Error && !e.message.includes('SECRET'));
  assert.equal(state?.ready, false);
  await setupCallerEnvironment(pool, { principalId: 'alice', version: 'v1', from: source, replace: true }, async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  assert.deepEqual(events.slice(-3), ['check', 'stop', 'ready']);
  const unchanged = await setupCallerEnvironment(pool, { principalId: 'alice', version: 'v1', from: source }, () => { throw new Error('must not run twice'); });
  assert.equal(unchanged.unchanged, true);
});
