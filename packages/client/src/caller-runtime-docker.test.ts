import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCallerRuntimePool, CALLER_TMPFS, CallerStorageLimitError } from './caller-runtime-docker.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';
import type { AsyncDockerRun } from './docker-command.js';

test('offline recovery accepts changed limits but rejects running or unowned resources', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'caller-offline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: directory, memoryMiB: 1024, cpus: 0.5, pids: 128, maxScopes: 1 });
  const store = new CallerRuntimeStore(directory, 'agent');
  await store.lock();
  const id = scopeDigest('agent', 'alice');
  await store.reserve(id, 'claude', 'alice');
  await store.reserve(scopeDigest('agent', 'bob'), 'claude', 'bob');
  await store.unlock();
  const name = `vb-caller-${store.namespace.slice(0, 16)}-${id}`;
  const labels = { 'vicoop.component': 'caller-runtime', 'vicoop.caller-namespace': store.namespace, 'vicoop.scope': id, 'vicoop.kind': 'claude' };
  const info = {
    Id: 'caller-container-id',
    NetworkSettings: { Networks: { [`${name}-net`]: { NetworkID: 'caller-network-id' } } },
    Image: options.image, State: { Running: false },
    Config: { Labels: labels, User: '1000:1000', Entrypoint: ['/usr/bin/tini'], Cmd: ['--', '/bin/sleep', 'infinity'], Env: ['CLAUDE_CONFIG_DIR=/data/sessions/claude/config'] },
    HostConfig: { Tmpfs: { ...CALLER_TMPFS }, ReadonlyRootfs: true, NetworkMode: `${name}-net`, RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges'], CapAdd: ['NET_ADMIN'], Memory: 512 * 1048576, MemorySwap: 512 * 1048576, PidsLimit: 256, NanoCpus: 1e9 },
    Mounts: [{ Type: 'volume', Destination: '/workspace', Name: `${name}-workspace`, RW: true }, { Type: 'volume', Destination: '/data/sessions/claude', Name: `${name}-sessions`, RW: true }],
  };
  const network = { Id: 'caller-network-id', Name: `${name}-net`, Driver: 'bridge', Scope: 'local', Labels: labels, Containers: {} as Record<string, { Name: string }>, Options: {} as Record<string, string> };
  const calls: string[][] = [];
  let removed = false;
  const run: AsyncDockerRun = async (args) => {
    calls.push([...args]);
    let value: unknown;
    if (args[0] === 'image') value = [{ Config: {} }];
    else if (args[0] === 'ps') return { exitCode: 0, stdout: removed ? '' : name, stderr: '' };
    else if (args[0] === 'container') {
      if (args[2] !== name || removed) return { exitCode: 1, stdout: '', stderr: 'No such container' };
      value = [info];
    } else if (args[0] === 'rm') removed = true;
    else if (args[0] === 'network' && args[1] === 'inspect') value = [network];
    else if (args[0] !== 'network' || args[1] !== 'rm') throw Error(`Unexpected Docker command ${args[0]}`);
    return { exitCode: 0, stdout: JSON.stringify(value) ?? '', stderr: '' };
  };
  const pool = () => new DockerCallerRuntimePool('claude', options, 'agent', run);
  await assert.rejects(pool().initialize(), /exceed maxScopes/);
  const strict = new DockerCallerRuntimePool('claude', { ...options, maxScopes: 2 }, 'agent', run);
  await assert.rejects(strict.initialize(), /boundary mismatch/);
  await assert.rejects(strict.initialize(false, true), /boundary mismatch/);
  info.State.Running = true;
  await assert.rejects(pool().initialize(false), /stop the daemon/);
  info.State.Running = false;
  info.Config.Labels['vicoop.scope'] = 'wrong';
  await assert.rejects(pool().initialize(false), /boundary mismatch/);
  info.Config.Labels['vicoop.scope'] = id;
  info.Mounts[0].Name = 'unowned-volume';
  await assert.rejects(pool().initialize(false), /boundary mismatch/);
  info.Mounts[0].Name = `${name}-workspace`;
  (info.NetworkSettings.Networks as any).foreign = { NetworkID: 'foreign' };
  await assert.rejects(pool().initialize(false), /boundary mismatch/);
  delete (info.NetworkSettings.Networks as any).foreign;
  info.NetworkSettings.Networks[`${name}-net`].NetworkID = 'wrong-network-id';
  await assert.rejects(pool().initialize(false), /network.*boundary mismatch/);
  info.NetworkSettings.Networks[`${name}-net`].NetworkID = network.Id;
  network.Containers.foreign = { Name: 'another-caller' };
  await assert.rejects(pool().initialize(false), /network.*boundary mismatch/);
  delete network.Containers.foreign;
  network.Labels = { ...labels, 'vicoop.scope': 'foreign' };
  await assert.rejects(pool().initialize(false), /network.*boundary mismatch/);
  network.Labels = labels;
  network.Driver = 'macvlan';
  await assert.rejects(pool().initialize(false), /network.*boundary mismatch/);
  network.Driver = 'bridge';
  network.Options['com.docker.network.bridge.name'] = 'foreign-bridge';
  await assert.rejects(pool().initialize(false), /network.*boundary mismatch/);
  delete network.Options['com.docker.network.bridge.name'];
  for (const tmp of ['rw,nosuid,nodev', CALLER_TMPFS['/tmp'].replace('nosuid,', ''), CALLER_TMPFS['/tmp'].replace('67108864', '134217728')]) {
    info.HostConfig.Tmpfs['/tmp'] = tmp;
    await assert.rejects(pool().initialize(false), /boundary mismatch/);
  }
  info.HostConfig.Tmpfs['/tmp'] = CALLER_TMPFS['/tmp'];
  const admin = pool();
  await admin.initialize(false);
  await assert.rejects(admin.acquire(id), /offline administration/);
  await admin.remove(id, false);
  assert.deepEqual(await admin.store.scopes(), [id, scopeDigest('agent', 'bob')].sort());
  await admin.close();
  assert.ok(calls.some((args) => args[0] === 'rm' && args[1] === name));
  assert.ok(!calls.some((args) => ['start', 'stop', 'exec'].includes(args[0])));
});

test('offline data deletion works without the image while validation reports the missing image', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'caller-missing-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: directory });
  const store = new CallerRuntimeStore(directory, 'agent');
  const id = scopeDigest('agent', 'alice');
  await store.lock();
  await store.reserve(id, 'claude', 'alice');
  await store.unlock();
  const calls: string[][] = [];
  const run: AsyncDockerRun = async (args) => {
    calls.push([...args]);
    if (args[0] === 'ps') return { exitCode: 0, stdout: '', stderr: '' };
    const kind = args[0];
    assert.ok(['image', 'container', 'volume', 'network'].includes(kind));
    return { exitCode: 1, stdout: '', stderr: `No such ${kind}` };
  };
  const admin = new DockerCallerRuntimePool('claude', options, 'agent', run);
  assert.deepEqual(await admin.initialize(false), [id]);
  await admin.remove(id, true);
  assert.deepEqual(await admin.store.scopes(), []);
  await admin.close();
  assert.ok(!calls.some((args) => args[0] === 'image'));
  const validator = new DockerCallerRuntimePool('claude', options, 'agent', run);
  await assert.rejects(validator.initialize(false, true), /image is missing.*container init/);
  const daemon = new DockerCallerRuntimePool('claude', options, 'agent', run);
  await assert.rejects(daemon.initialize(), /image is missing.*container init/);
});


test('storage quota, malformed usage and Docker failures have distinct errors', async () => {
  const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/fixture', storageMiB: 64 });
  for (const [stdout, exitCode, expected] of [
    ['65537 /workspace\n0 /data/sessions/claude', 0, 'limit'],
    ['invalid', 0, 'usage'],
    ['', 1, 'Docker'],
  ] as const) {
    const pool = new DockerCallerRuntimePool('claude', options, 'agent', async () => ({ stdout, stderr: 'failure', exitCode }));
    await assert.rejects(pool.checkStorage('a'.repeat(64)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof CallerStorageLimitError, expected === 'limit');
      assert.match(error.message, new RegExp(expected));
      return true;
    });
  }
});
