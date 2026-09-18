import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCallerRuntimePool, CALLER_TMPFS, CallerOrphanedResourcesError, CallerStorageMissingError, CallerStorageLimitError } from './caller-runtime-docker.js';
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
    HostConfig: { PublishAllPorts: false, Tmpfs: { ...CALLER_TMPFS }, ReadonlyRootfs: true, NetworkMode: `${name}-net`, RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges'], CapAdd: ['NET_ADMIN'], Memory: 512 * 1048576, MemorySwap: 512 * 1048576, PidsLimit: 256, NanoCpus: 1e9 },
    Mounts: [{ Type: 'volume', Destination: '/workspace', Name: `${name}-workspace`, RW: true }, { Type: 'volume', Destination: '/data/sessions/claude', Name: `${name}-sessions`, RW: true }],
  };
  const network = { Id: 'caller-network-id', Name: `${name}-net`, Driver: 'bridge', Scope: 'local', Labels: labels, Containers: {} as Record<string, { Name: string }>, Options: {} as Record<string, string> };
  const calls: string[][] = [];
  let removed = false, networkMissing = false, badSessionVolume = false;
  const run: AsyncDockerRun = async (args) => {
    calls.push([...args]);
    let value: unknown;
    if (args[0] === 'image') value = [{ Config: {} }];
    else if (args[0] === 'ps') return { exitCode: 0, stdout: removed ? '' : name, stderr: '' };
    else if (args[0] === 'container') {
      if (args[2] !== name || removed) return { exitCode: 1, stdout: '', stderr: 'No such container' };
      value = [info];
    } else if (args[0] === 'volume' && args[1] === 'inspect') value = [{ Driver: 'local', Options: {}, Labels: { ...labels, 'vicoop.scope': badSessionVolume && args[2].endsWith('-sessions') ? 'foreign' : args[2].includes(id) ? id : scopeDigest('agent', 'bob') } }];
    else if (args[0] === 'rm') removed = true;
    else if (args[0] === 'network' && args[1] === 'inspect') {
      if (networkMissing) return { exitCode: 1, stdout: '', stderr: 'No such network' };
      value = [network];
    }
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
  info.HostConfig.PublishAllPorts = true;
  await assert.rejects(pool().initialize(false), /boundary mismatch/);
  info.HostConfig.PublishAllPorts = false;
  info.Config.Labels['vicoop.scope'] = 'wrong';
  await assert.rejects(pool().initialize(false), /boundary mismatch/);
  info.Config.Labels['vicoop.scope'] = id;
  info.Mounts[0].Name = 'unowned-volume';
  await assert.rejects(pool().initialize(false), /boundary mismatch/);
  info.Mounts[0].Name = `${name}-workspace`;
  const boundary = () => new DockerCallerRuntimePool('claude', { ...options, maxScopes: 2, memoryMiB: 512, cpus: 1, pids: 256 }, 'agent', run);
  (info.NetworkSettings.Networks as any).foreign = { NetworkID: 'foreign' };
  await assert.rejects(boundary().initialize(false, true), /boundary mismatch/);
  delete (info.NetworkSettings.Networks as any).foreign;
  info.NetworkSettings.Networks[`${name}-net`].NetworkID = 'wrong-network-id';
  await assert.rejects(boundary().initialize(false, true), /network.*boundary mismatch/);
  info.NetworkSettings.Networks[`${name}-net`].NetworkID = network.Id;
  network.Containers.foreign = { Name: 'another-caller' };
  await assert.rejects(boundary().initialize(false, true), /network.*boundary mismatch/);
  delete network.Containers.foreign;
  network.Labels = { ...labels, 'vicoop.scope': 'foreign' };
  await assert.rejects(boundary().initialize(false, true), /network.*boundary mismatch/);
  network.Labels = labels;
  network.Driver = 'macvlan';
  await assert.rejects(boundary().initialize(false, true), /network.*boundary mismatch/);
  network.Driver = 'bridge';
  network.Options['com.docker.network.bridge.name'] = 'foreign-bridge';
  await assert.rejects(boundary().initialize(false, true), /network.*boundary mismatch/);
  delete network.Options['com.docker.network.bridge.name'];
  for (const tmp of ['rw,nosuid,nodev', CALLER_TMPFS['/tmp'].replace('nosuid,', ''), CALLER_TMPFS['/tmp'].replace('67108864', '134217728')]) {
    info.HostConfig.Tmpfs['/tmp'] = tmp;
    await assert.rejects(pool().initialize(false), /boundary mismatch/);
  }
  info.HostConfig.Tmpfs['/tmp'] = CALLER_TMPFS['/tmp'];
  networkMissing = true;
  const missing = pool();
  await missing.initialize(false);
  (info.NetworkSettings.Networks as any).foreign = { NetworkID: 'foreign' };
  await assert.rejects(missing.remove(id, false), /network membership boundary mismatch/);
  assert.equal(removed, false);
  delete (info.NetworkSettings.Networks as any).foreign;
  await missing.remove(id, false);
  assert.equal(removed, true);
  await missing.close();
  // A separate retained fixture with network drift remains safely removable.
  removed = false;
  networkMissing = false;
  network.Driver = 'macvlan';
  network.Options['com.docker.network.bridge.name'] = 'drifted';
  info.HostConfig.NetworkMode = 'foreign-network';
  const admin = pool();
  await admin.initialize(false);
  await assert.rejects(admin.acquire(id), /offline administration/);
  network.Containers.foreign = { Name: 'another-caller' };
  await assert.rejects(admin.remove(id, false), /network.*boundary mismatch/);
  assert.equal(removed, false, 'foreign network endpoints must not dismantle the container');
  assert.ok(!calls.some(args => args[0] === 'network' && args[1] === 'rm'));
  delete network.Containers.foreign;
  network.Labels = { ...labels, 'vicoop.scope': 'foreign' };
  await assert.rejects(admin.remove(id, false), /network.*boundary mismatch/);
  assert.equal(removed, false);
  network.Labels = labels;
  badSessionVolume = true;
  const before = calls.length;
  for (const deleteData of [false, true]) await assert.rejects(admin.remove(id, deleteData), /volume ownership/);
  assert.equal(removed, false);
  assert.ok(!calls.slice(before).some(args => args.includes('rm')));
  badSessionVolume = false;
  network.Containers[info.Id] = { Name: name }; // A stopped container's own endpoint is legitimate.
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


test('retained scopes never recreate missing workspace or session volumes after restart', async (t) => {
  for (const missing of ['workspace', 'sessions']) {
    const directory = await mkdtemp(join(tmpdir(), 'caller-volume-loss-'));
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
      if (args[0] === 'image') return { exitCode: 0, stdout: JSON.stringify([{ Config: {} }]), stderr: '' };
      if (args[0] === 'ps') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'container') return { exitCode: 1, stdout: '', stderr: 'No such container' };
      assert.equal(args[0], 'volume');
      assert.equal(args[1], 'inspect');
      if (args[2].endsWith(`-${missing}`)) return { exitCode: 1, stdout: '', stderr: 'No such volume' };
      return { exitCode: 0, stdout: JSON.stringify([{ Driver: 'local', Options: {}, Labels: {
        'vicoop.component': 'caller-runtime', 'vicoop.caller-namespace': store.namespace,
        'vicoop.scope': id, 'vicoop.kind': 'claude',
      } }]), stderr: '' };
    };
    const validator = new DockerCallerRuntimePool('claude', options, 'agent', run);
    await assert.rejects(validator.initialize(false, true), CallerStorageMissingError);
    // Listing/removal and daemon startup remain possible for unaffected callers.
    await validator.initialize(false);
    await validator.close();
    const pool = new DockerCallerRuntimePool('claude', options, 'agent', run);
    await pool.initialize();
    try {
      await assert.rejects(pool.acquire(id, undefined, 'alice'), CallerStorageMissingError);
      assert.deepEqual(await pool.store.scopes(), [id]);
      assert.ok(!calls.some(args => args.includes('create')));
    } finally { await pool.close(); }
  }
});

test('allocation forwards cancellation to inspections and mutations, then stops issuing commands', async (t) => {
  for (const phase of ['container', 'volume', 'network', 'create']) {
    const directory = await mkdtemp(join(tmpdir(), 'caller-abort-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: directory });
    const controller = new AbortController();
    let allocating = false, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const calls: string[][] = [];
    const pool = new DockerCallerRuntimePool('claude', config, 'agent', async (args, opts) => {
      calls.push([...args]);
      if (allocating) {
        assert.equal(opts?.signal, controller.signal);
        if (args[0] === phase) {
          reached();
          await new Promise<void>((_resolve, reject) => opts.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }
      }
      if (args[0] === 'image') return { exitCode: 0, stdout: JSON.stringify([{ Config: {} }]), stderr: '' };
      if (args[1] === 'inspect') return { exitCode: 1, stdout: '', stderr: `No such ${args[0]}` };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await pool.initialize();
    allocating = true;
    const acquisition = pool.acquire(scopeDigest('agent', 'alice'), controller.signal, 'alice');
    const rejected = assert.rejects(acquisition, /aborted/);
    await started;
    const before = calls.length;
    controller.abort();
    await rejected;
    assert.equal(calls.length, before);
    allocating = false; // Cleanup must use an independent, uncanceled operation.
    await pool.close();
  }
});


test('input staging forwards binary stdin and cancellation to Docker', async () => {
  const controller = new AbortController();
  const id = 'a'.repeat(64), path = '/tmp/vicoop-input-abcd/image-1.png';
  const data = Buffer.from('image');
  const config = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/fixture' });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pool = new DockerCallerRuntimePool('codex', config, 'agent', async (args, opts) => {
    assert.equal(opts?.signal, controller.signal);
    assert.equal(args.at(-1), path);
    assert.equal(opts.input, data);
    ready();
    await new Promise<void>((_resolve, reject) => opts.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    throw new Error('unreachable');
  });
  const writing = pool.inputWrite(id, path, data, controller.signal);
  const rejected = assert.rejects(writing, /aborted/);
  await started;
  controller.abort();
  await rejected;
});


test('fresh scopes reject orphan resources without mutations or restart adoption', async (t) => {
  for (const orphan of ['container', 'workspace', 'sessions', 'network']) {
    const directory = await mkdtemp(join(tmpdir(), 'caller-orphan-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: directory });
    const id = scopeDigest('agent', 'alice');
    const namespace = new CallerRuntimeStore(await realpath(directory), 'agent').namespace;
    const name = `vb-caller-${namespace.slice(0, 16)}-${id}`;
    const labels = { 'vicoop.component': 'caller-runtime', 'vicoop.caller-namespace': namespace, 'vicoop.scope': id, 'vicoop.kind': 'claude' };
    const calls: string[][] = [];
    const run: AsyncDockerRun = async (args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { exitCode: 0, stdout: JSON.stringify([{ Config: {} }]), stderr: '' };
      if (args[0] === 'ps') return { exitCode: 0, stdout: '', stderr: '' };
      assert.equal(args[1], 'inspect', 'orphan detection must not mutate Docker');
      let resource;
      if (args[0] === 'container' && orphan === 'container') resource = {};
      if (args[0] === 'volume' && args[2].endsWith(`-${orphan}`)) resource = { Driver: 'local', Labels: labels };
      if (args[0] === 'network' && orphan === 'network') resource = { Name: `${name}-net`, Id: 'network', Driver: 'bridge', Scope: 'local', Labels: labels };
      return resource ? { exitCode: 0, stdout: JSON.stringify([resource]), stderr: '' } : { exitCode: 1, stdout: '', stderr: `No such ${args[0]}` };
    };
    for (let restart = 0; restart < 2; restart++) {
      const pool = new DockerCallerRuntimePool('claude', options, 'agent', run);
      await pool.initialize();
      let reserved = false;
      await assert.rejects(pool.acquire(id, undefined, 'alice', () => { reserved = true; }), CallerOrphanedResourcesError);
      assert.equal(reserved, false);
      assert.deepEqual(await pool.store.scopes(), []);
      await pool.close();
    }
    assert.ok(!calls.some(args => ['create', 'start', 'stop', 'rm', 'exec'].some(command => args.includes(command))));
  }
});
