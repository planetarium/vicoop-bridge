import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallerStorage, CallerStorageHelperUnconfirmedError } from './caller-storage.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';
import type { AsyncDockerRun } from './docker-command.js';

const image = `sha256:${'a'.repeat(64)}`;
test('fixed storage retains identity, rejects legacy adoption and changes, terminates aborted helpers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fixed-storage-'));
  const store = new CallerRuntimeStore(directory, 'agent');
  await store.lock();
  t.after(async () => { await store.unlock(); await rm(directory, { recursive: true, force: true }); });
  const id = scopeDigest('agent', 'alice');
  await store.reserve(id, 'claude', 'alice');
  const options = CallerRuntimeConfig.parse({ image, stateDirectory: directory, storageMiB: 64,
    fixedImageStorage: { image, poolVolume: 'pool', capacityMiB: 128, reserveMiB: 64, reservationBoundary: 'docker-filesystem' } });
  const calls: string[][] = [];
  let aborted = false, failRemoval = false;
  let helperInfo: any;
  const containerId = 'b'.repeat(64);
  const run: AsyncDockerRun = async args => {
    calls.push([...args]);
    if (args[0] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((arg, i) => { if (arg === '--label') { const [key, value] = args[i + 1].split('='); labels[key] = value; } });
      helperInfo = { Id: containerId, Name: '/' + args[args.indexOf('--name') + 1], Config: { Image: image, Labels: labels } };
      return { exitCode: 0, stdout: containerId, stderr: '' };
    }
    if (args[0] === 'start' && aborted) throw new Error('aborted');
    if (args[0] === 'container') return helperInfo
      ? { exitCode: 0, stdout: JSON.stringify([helperInfo]), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'No such container' };
    if (args[0] === 'rm') {
      if (failRemoval) return { exitCode: 1, stdout: '', stderr: 'Docker unavailable' };
      assert.equal(args[2], containerId);
      helperInfo = undefined;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const storage = new CallerStorage(options, store, run);
  await assert.rejects(storage.record(id), /legacy or incomplete/);
  await storage.reserve(id);
  const record = await storage.record(id);
  assert.equal(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')).version, 5);
  await assert.rejects(new CallerStorage({ ...options, storageMiB: 128 }, store, run).record(id), /configuration changed/);
  await assert.rejects(new CallerStorage({ ...options, fixedImageStorage: { ...options.fixedImageStorage!, poolVolume: 'other' } }, store, run).record(id), /configuration changed/);
  await store.unlock(); await store.lock();
  assert.deepEqual(await storage.record(id), record);
  await storage.manage('attach', id);
  const helper = calls.find(c => c[0] === 'create')!;
  assert(helper.includes('--privileged'));
  assert(helper.includes('type=bind,src=/dev,dst=/dev'));
  assert(!helper.some(c => c.includes('docker.sock')));
  assert(helper.includes(record.uuid));
  aborted = true;
  await assert.rejects(storage.manage('attach', id), /aborted/);
  assert.deepEqual(calls.at(-1), ['container', 'inspect', containerId]);
  assert.equal(await store.storageHelper(id), undefined);
  failRemoval = true;
  await assert.rejects(storage.manage('attach', id), CallerStorageHelperUnconfirmedError);
  const pending = await store.storageHelper(id);
  assert(pending);
  await assert.rejects(store.forget(id), /termination must be confirmed/);
  await store.unlock(); await store.lock();
  assert.equal(await store.storageHelper(id), pending);
  const restarted = new CallerStorage(options, store, run);
  await assert.rejects(restarted.manage('attach', id), CallerStorageHelperUnconfirmedError);
  helperInfo.Config.Labels['vicoop.scope'] = 'wrong';
  failRemoval = false;
  await assert.rejects(restarted.reconcile(id), CallerStorageHelperUnconfirmedError);
  assert.equal(await store.storageHelper(id), pending);
  helperInfo.Config.Labels['vicoop.scope'] = id;
  await restarted.reconcile(id);
  assert.equal(await store.storageHelper(id), undefined);
  await store.forget(id);
  assert.equal(await store.fixedStorage(id), undefined);
});

test('fixed storage requires an explicit reservation boundary and pinned helper', () => {
  assert.equal(CallerRuntimeConfig.safeParse({ image, stateDirectory: '/private/state', fixedImageStorage: {
    image: 'mutable:latest', poolVolume: 'pool', capacityMiB: 128, reserveMiB: 64,
  } }).success, false);
});
