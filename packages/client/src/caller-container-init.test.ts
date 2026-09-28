import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  runCallerContainerInit,
  type CallerContainerInitOptions,
} from './caller-container-init.js';
import { STORAGE_IMAGE_FILES } from './caller-storage-assets.js';
import { CallerStorage } from './caller-storage.js';
import { CALLER_IMAGE_FILES } from './caller-image-assets.js';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';
import { openCallerDatabase } from './caller-runtime-sqlite.js';
import type { AsyncDockerRun } from './docker-command.js';
import { createLogger } from './logger.js';

const image = `sha256:${'a'.repeat(64)}`;
const success = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'caller-init-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const original = {
    agent_id: 'agent/../id',
    server_token: 'keep-token',
    server_url: 'https://bridge.test',
    operator_field: { keep: true },
    backends: {
      claude: { model: 'keep-model', cwd: '/legacy', runtime_name: 'old' },
      codex: { model: 'other-model' },
    },
  };
  await writeFile(path, JSON.stringify(original));
  const calls: string[][] = [];
  let auth = 0;
  const volumes = new Map<string, unknown>();
  const helpers = new Map<string, any>();
  let helperSequence = 0;
  const dockerRun: AsyncDockerRun = async (args) => {
    calls.push([...args]);
    if (args[0] === 'volume') {
      const name = args.at(-1)!;
      if (args[1] === 'create') {
        const labels: Record<string, string> = {};
        args.forEach((arg, i) => { if (arg === '--label') { const [k,v] = args[i+1].split('='); labels[k] = v; } });
        if (!volumes.has(name)) volumes.set(name, { Name: name, Driver: 'local', Options: {}, Labels: labels });
        return success(name);
      }
      return volumes.has(name) ? success(JSON.stringify([volumes.get(name)])) : { exitCode: 1, stdout: '', stderr: 'No such volume' };
    }
    if (args[0] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((arg, i) => { if (arg === '--label') { const [k,v] = args[i+1].split('='); labels[k] = v; } });
      const helperId = (++helperSequence).toString(16).padStart(64, 'c');
      const helper = { Id: helperId, Name: '/' + args[args.indexOf('--name')+1], Config: { Image: image, Labels: labels } };
      helpers.set(helperId, helper);
      return success(helperId);
    }
    if (args[0] === 'start') return success();
    if (args[0] === 'container') {
      const helper = [...helpers.values()].find(h => h.Id === args[2] || h.Name === '/' + args[2]);
      return helper ? success(JSON.stringify([helper])) : { exitCode: 1, stdout: '', stderr: 'No such container' };
    }
    if (args[0] === 'rm' && helpers.has(args[2])) { helpers.delete(args[2]); return success(); }
    if (args[0] === 'version') return success('1.45 1.45');
    if (args[0] === 'info') return success('linux\n');
    if (args[0] === 'ps') return success();
    if (args[0] === 'image')
      return success(
        JSON.stringify([
          { Id: image, Config: { Env: ['PATH=/usr/bin'], Volumes: null } },
        ]),
      );
    if (args[0] === 'build') {
      const context = args.at(-1)!;
      for (const [name, content] of Object.entries(args.includes(join(context, 'Dockerfile')) ? CALLER_IMAGE_FILES : STORAGE_IMAGE_FILES))
        assert.equal(await readFile(join(context, name), 'utf8'), content);
      await writeFile(args[args.indexOf('--iidfile') + 1], image);
      return success();
    }
    if (args[0] === 'run')
      return success(
        args.at(-1)!.includes('claude --version')
          ? '2.1.267 (Claude Code)'
          : 'codex-cli 0.153.4',
      );
    if (args[0] === 'rm' || args[0] === 'pull') return success();
    throw new Error(`unexpected command ${args}`);
  };
  const options: CallerContainerInitOptions = {
    kind: 'claude',
    configPath: path,
    dockerRun,
    validateCredentials: async () => {
      auth++;
    },
    logger: createLogger('silent'),
  };
  return {
    dir,
    path,
    original,
    options,
    calls,
    dockerRun,
    auth: () => auth,
    read: async () => JSON.parse(await readFile(path, 'utf8')),
  };
}

test('standalone init builds embedded recipe, validates and preserves registration/unrelated settings', async (t) => {
  const f = await fixture(t);
  assert.equal(await runCallerContainerInit(f.options), 0);
  const config = await f.read();
  assert.equal(config.server_token, f.original.server_token);
  assert.equal(config.server_url, f.original.server_url);
  assert.deepEqual(config.operator_field, f.original.operator_field);
  assert.deepEqual(config.backends.codex, f.original.backends.codex);
  assert.equal(config.backend, 'claude');
  assert.equal(config.backends.claude.model, 'keep-model');
  assert.equal(config.backends.claude.cwd, undefined);
  assert.equal(config.backends.claude.runtime_name, undefined);
  assert.equal(config.backends.claude.runtime, 'container');
  const runtime = config.backends.claude.caller_runtime;
  assert.equal(runtime.image, image);
  assert.equal(
    runtime.stateDirectory.startsWith(join(f.dir, 'caller-state') + '/'),
    true,
  );
  assert.equal((await stat(runtime.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const db = await openCallerDatabase(
    join(runtime.stateDirectory, 'state.sqlite'),
  );
  try {
    assert.deepEqual(db.prepare('SELECT * FROM scopes').all(), []);
  } finally {
    db.close();
  }
  assert.equal(f.auth(), 1);
  const check = f.calls.find((args) => args[0] === 'run')!;
  assert.equal(check.filter((arg) => arg === '--mount').length, 2);
  assert.ok(check.includes('type=volume,target=/workspace'));
  assert.ok(check.includes('type=volume,target=/data/sessions/claude'));
  assert.match(check.at(-1)!, /mktemp -d/);
  assert.ok(f.calls.some(args => args[0] === 'rm' && args.includes('-v')));
  assert.equal(check.includes('--env'), false);
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.ok(runtime.fixedImageStorage);
  assert.equal(runtime.fixedImageStorage.capacityMiB, 8192);
  assert.equal(runtime.fixedImageStorage.reserveMiB, 1024);
  assert.equal(runtime.fixedImageStorage.reservationBoundary, 'docker-filesystem');
  await assert.rejects(
    stat(dirname(f.calls.find((args) => args[0] === 'build')![2])),
    { code: 'ENOENT' },
  );
});

test('reinitialization preserves paths/limits, reuses image and supports the other backend', async (t) => {
  const f = await fixture(t);
  await runCallerContainerInit({
    ...f.options,
    image: 'local:tag',
    stateDirectory: join(f.dir, 'private'),
  });
  const config = await f.read();
  config.backends.claude.caller_runtime.maxScopes = 3;
  await writeFile(f.path, JSON.stringify(config));
  f.calls.length = 0;
  await runCallerContainerInit(f.options);
  assert.equal(
    f.calls.some((args) => args[0] === 'build'),
    false,
  );
  assert.equal((await f.read()).backends.claude.caller_runtime.maxScopes, 3);
  const existing = (await f.read()).backends.claude;
  await runCallerContainerInit({ ...f.options, kind: 'codex', image });
  assert.deepEqual((await f.read()).backends.claude, existing);
  assert.notEqual(
    (await f.read()).backends.codex.caller_runtime.stateDirectory,
    existing.caller_runtime.stateDirectory,
  );
});

test('missing images are pulled then pinned, without forwarding credentials', async (t) => {
  const f = await fixture(t);
  let inspected = false;
  await runCallerContainerInit({
    ...f.options,
    image: 'registry.example/caller:tag',
    dockerRun: async (args, opts) => {
      if (args[0] === 'image' && !inspected) {
        inspected = true;
        return { exitCode: 1, stdout: '', stderr: 'No such image' };
      }
      return f.dockerRun(args, opts);
    },
  });
  assert.ok(f.calls.some((args) => args[0] === 'pull'));
  assert.equal((await f.read()).backends.claude.caller_runtime.image, image);
});

test('credential failure preserves config and performs no Docker operations', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runCallerContainerInit({
      ...f.options,
      validateCredentials: async () => {
        throw new Error('login required');
      },
    }),
    /login required/,
  );
  assert.deepEqual(await f.read(), f.original);
  assert.deepEqual(f.calls, []);
});

test('failed image checks preserve config and remove the probe container', async (t) => {
  for (const output of ['codex-cli 0.100.0', 'not a version']) {
    const f = await fixture(t);
    await assert.rejects(
      runCallerContainerInit({
        ...f.options,
        kind: 'codex',
        image,
        dockerRun: async (args, opts) =>
          args[0] === 'run' ? success(output) : f.dockerRun(args, opts),
      }),
      /unsupported/,
    );
    assert.deepEqual(await f.read(), f.original);
    assert.equal(f.calls.at(-1)?.[0], 'rm');
  }
});

test('images with provider environment or anonymous volumes are rejected before execution', async (t) => {
  for (const Config of [
    { Env: ['ANTHROPIC_API_KEY=secret'] },
    { Volumes: { '/data': {} } },
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      runCallerContainerInit({
        ...f.options,
        image,
        dockerRun: async (args, opts) =>
          args[0] === 'image'
            ? success(JSON.stringify([{ Id: image, Config }]))
            : f.dockerRun(args, opts),
      }),
      /must not declare/,
    );
    assert.deepEqual(await f.read(), f.original);
    assert.equal(
      f.calls.some((args) => args[0] === 'run'),
      false,
    );
  }
});

test('intervening config edits are preserved after a long build', async (t) => {
  const f = await fixture(t);
  const changed = { ...f.original, operator_field: { keep: false } };
  await assert.rejects(
    runCallerContainerInit({
      ...f.options,
      dockerRun: async (args, opts) => {
        if (args[0] === 'build')
          await writeFile(f.path, JSON.stringify(changed));
        return f.dockerRun(args, opts);
      },
    }),
    /config changed/,
  );
  assert.deepEqual(await f.read(), changed);
});

test('live owner and state-directory changes are refused without losing mappings', async (t) => {
  const f = await fixture(t);
  await runCallerContainerInit({ ...f.options, image });
  const runtime = (await f.read()).backends.claude.caller_runtime;
  const store = new CallerRuntimeStore(
    runtime.stateDirectory,
    f.original.agent_id,
  );
  await store.lock();
  try {
    await store.reserve(
      scopeDigest(f.original.agent_id, 'alice'),
      'claude',
      'alice',
    );
    await assert.rejects(runCallerContainerInit(f.options), /live owner/);
    await assert.rejects(
      runCallerContainerInit({
        ...f.options,
        stateDirectory: join(f.dir, 'other'),
      }),
      /preserves/,
    );
    assert.equal((await store.scopes()).length, 1);
  } finally {
    await store.unlock();
  }
});

test('image rebuild failure cleans context and keeps config unchanged', async (t) => {
  const f = await fixture(t);
  let context = '';
  await assert.rejects(
    runCallerContainerInit({
      ...f.options,
      dockerRun: async (args, opts) => {
        if (args[0] === 'build') {
          context = args.at(-1)!;
          return { exitCode: 1, stdout: '', stderr: 'build failed' };
        }
        return f.dockerRun(args, opts);
      },
    }),
    /build failed/,
  );
  await assert.rejects(stat(context), { code: 'ENOENT' });
  assert.deepEqual(await f.read(), f.original);
});

test('embedded build assets match the reviewed Dockerfile and installer', async () => {
  const root = resolve(import.meta.dirname, '../../..');
  assert.equal(
    CALLER_IMAGE_FILES.Dockerfile,
    await readFile(
      join(root, 'packages/client/docker/caller-runtime/Dockerfile'),
      'utf8',
    ),
  );
  assert.equal(
    CALLER_IMAGE_FILES['container/backends/claude.sh'],
    await readFile(join(root, 'container/backends/claude.sh'), 'utf8'),
  );
});

test('running caller containers block offline initialization even after an owner crash', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runCallerContainerInit({
      ...f.options,
      image,
      dockerRun: async (args, opts) =>
        args[0] === 'ps'
          ? success('running-container')
          : f.dockerRun(args, opts),
    }),
    /stop managed/,
  );
  assert.deepEqual(await f.read(), f.original);
  assert.equal(
    f.calls.some((args) => args[0] === 'run'),
    false,
  );
});

test('retained containers prevent changing their image, but recreated scopes keep their mapping', async (t) => {
  const f = await fixture(t);
  await runCallerContainerInit({ ...f.options, image });
  const before = await f.read();
  const state = before.backends.claude.caller_runtime.stateDirectory;
  const store = new CallerRuntimeStore(state, f.original.agent_id);
  const id = scopeDigest(f.original.agent_id, 'alice');
  await store.lock();
  await store.reserve(id, 'claude', 'alice');
  await new CallerStorage(before.backends.claude.caller_runtime, store, f.dockerRun).reserve(id);
  await store.unlock();
  const nextImage = `sha256:${'b'.repeat(64)}`;
  let retained = true;
  const dockerRun: AsyncDockerRun = async (args, opts) => {
    if (args[0] === 'ps' && args[1] === '-aq')
      return success(retained ? 'stopped-container' : '');
    if (args[0] === 'image' && args[2] === nextImage)
      return success(JSON.stringify([{ Id: nextImage, Config: {} }]));
    return f.dockerRun(args, opts);
  };
  await assert.rejects(
    runCallerContainerInit({ ...f.options, image: nextImage, dockerRun }),
    /container recreate/,
  );
  assert.deepEqual(await f.read(), before);
  retained = false;
  await runCallerContainerInit({ ...f.options, image: nextImage, dockerRun });
  assert.equal(
    (await f.read()).backends.claude.caller_runtime.image,
    nextImage,
  );
  await store.lock();
  try {
    assert.deepEqual(await store.scopes(), [id]);
  } finally {
    await store.unlock();
  }
});

test('invalid or missing registration cannot overwrite config or trigger Docker', async (t) => {
  const f = await fixture(t);
  for (const content of ['{broken', '{}']) {
    await writeFile(f.path, content);
    await assert.rejects(runCallerContainerInit(f.options));
    assert.equal(await readFile(f.path, 'utf8'), content);
    assert.deepEqual(f.calls, []);
  }
  await rm(f.path);
  await assert.rejects(
    runCallerContainerInit(f.options),
    /register an agent first/,
  );
});

test('unwritable image storage fails initialization without saving config and removes probe volumes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(runCallerContainerInit({
    ...f.options, image,
    dockerRun: async (args, opts) => args[0] === 'run'
      ? { exitCode: 1, stdout: '', stderr: 'caller image must provide writable /workspace for UID 1000' }
      : f.dockerRun(args, opts),
  }), /writable \/workspace/);
  assert.deepEqual(await f.read(), f.original);
  assert.deepEqual(f.calls.at(-1)?.slice(0, 3), ['rm', '-f', '-v']);
});


test('relative and empty state paths fail before authentication or Docker, including retained paths', async (t) => {
  for (const value of ['', './state', '../state', '~/state']) {
    for (const retained of [false, true]) {
      const f = await fixture(t);
      const original = retained ? { ...f.original, backends: { claude: { caller_runtime: { image, stateDirectory: value } } } } : f.original;
      await writeFile(f.path, JSON.stringify(original));
      await assert.rejects(runCallerContainerInit({ ...f.options,
        stateDirectory: retained ? join(f.dir, 'absolute') : value,
      }), /absolute path/);
      assert.deepEqual(await f.read(), original);
      assert.equal(f.auth(), 0);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('explicit empty or malformed image references cannot fall back to building', async (t) => {
  for (const image of ['', ' ', '-bad', 'bad image']) {
    const f = await fixture(t);
    await assert.rejects(runCallerContainerInit({ ...f.options, image }), /invalid image/);
    assert.deepEqual(await f.read(), f.original);
    assert.equal(f.auth(), 0);
    assert.deepEqual(f.calls, []);
  }
});

test('unsafe operator Claude settings fail init before authentication or Docker', async (t) => {
  const f = await fixture(t);
  const original = { ...f.original, backends: { claude: { settings: { env: { FOO_SECRET: 'OPERATOR_SECRET' } } } } };
  await writeFile(f.path, JSON.stringify(original));
  await assert.rejects(runCallerContainerInit(f.options), error => error instanceof Error && /settings/.test(error.message) && !error.message.includes('OPERATOR_SECRET'));
  assert.deepEqual(await f.read(), original);
  assert.equal(f.auth(), 0);
  assert.deepEqual(f.calls, []);
});

for (const alias of [false, true]) {
  test(`init rejects another backend's state directory before side effects (symlink=${alias})`, async (t) => {
    const f = await fixture(t);
    const aliasPath = `${f.dir}-alias`;
    if (alias) {
      await symlink(f.dir, aliasPath);
      t.after(() => rm(aliasPath, { force: true }));
    }
    const config = await f.read();
    config.backends.codex.caller_runtime = { stateDirectory: join(f.dir, 'missing', 'state') };
    await writeFile(f.path, JSON.stringify(config));
    await assert.rejects(runCallerContainerInit({ ...f.options,
      stateDirectory: join(alias ? aliasPath : f.dir, 'missing', 'state'),
    }), /each backend requires a distinct/);
    assert.equal(f.auth(), 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.read(), config);
  });
}

for (const value of ['relative/state', '', 42, null, undefined]) {
  test(`init rejects invalid sibling state path ${JSON.stringify(value)} before side effects`, async (t) => {
    const f = await fixture(t);
    const config = await f.read();
    config.backends.codex.caller_runtime = { image, stateDirectory: value };
    await writeFile(f.path, JSON.stringify(config));
    const before = await readFile(f.path, 'utf8');
    await assert.rejects(runCallerContainerInit(f.options), /codex caller_runtime.stateDirectory must be an absolute path/);
    assert.equal(f.auth(), 0);
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(f.path, 'utf8'), before);
  });
}

test('embedded helper is the reviewed source, including SQLite and Docker build inputs', async () => {
  for (const [name, content] of Object.entries(STORAGE_IMAGE_FILES))
    assert.equal(content, await readFile(new URL(`../../../${name}`, import.meta.url), 'utf8'));
});

test('shared pool inherits the winning policy; explicit conflicts and foreign volumes fail without saving', async t => {
  const f = await fixture(t);
  await runCallerContainerInit({ ...f.options, storageMiB: 128, storageCapacityMiB: 2048, storageReserveMiB: 64 });
  const first = await f.read();
  await runCallerContainerInit({ ...f.options, kind: 'codex', image });
  assert.deepEqual((await f.read()).backends.codex.caller_runtime.fixedImageStorage,
    first.backends.claude.caller_runtime.fixedImageStorage);
  const before = await f.read();
  await assert.rejects(runCallerContainerInit({ ...f.options, storageCapacityMiB: 1024 }), /immutable/);
  await assert.rejects(runCallerContainerInit({ ...f.options, storagePool: 'different' }), /cannot be changed/);
  await assert.rejects(runCallerContainerInit({ ...f.options, dockerRun: async (args, opts) => {
    if (args[0] === 'volume' && args[1] === 'inspect') return success(JSON.stringify([
      { Name: args[2], Driver: 'local', Labels: {}, Options: {} },
    ]));
    return f.dockerRun(args, opts);
  } }), /ownership/);
  assert.deepEqual(await f.read(), before);
  assert.equal(f.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
});

test('probe failure preserves configuration, cleans its image, and can be retried', async t => {
  const f = await fixture(t);
  let fail = true;
  const dockerRun: AsyncDockerRun = async (args, opts) => {
    if (fail && args[0] === 'start') { fail = false; return { exitCode: 1, stdout: '', stderr: 'pool free-space reserve would be exhausted' }; }
    return f.dockerRun(args, opts);
  };
  await assert.rejects(runCallerContainerInit({ ...f.options, dockerRun }), /free-space reserve.*Prior config is unchanged/s);
  assert.deepEqual(await f.read(), f.original);
  assert.ok(f.calls.some(args => args[0] === 'create' && args.includes('delete')));
  await runCallerContainerInit({ ...f.options, dockerRun });
  assert.ok((await f.read()).backends.claude.caller_runtime.fixedImageStorage);
});

test('unconfirmed helper cleanup remains journaled and rerun reconciles before provisioning', async t => {
  const f = await fixture(t);
  const stateDirectory = join(f.dir, 'private');
  let fail = true;
  const dockerRun: AsyncDockerRun = async (args, opts) => {
    if (fail && args[0] === 'rm' && /^[a-f0-9]{64}$/.test(args[2]))
      return { exitCode: 1, stdout: '', stderr: 'Docker unavailable' };
    return f.dockerRun(args, opts);
  };
  await assert.rejects(runCallerContainerInit({ ...f.options, stateDirectory, dockerRun }), /termination unconfirmed.*Recovery state/s);
  assert.deepEqual(await f.read(), f.original);
  const probe = new CallerRuntimeStore(join(stateDirectory, 'storage-init'), f.original.agent_id);
  await probe.lock();
  const [id] = await probe.scopes();
  assert.ok(await probe.storageHelper(id));
  assert.ok(await probe.fixedStorage(id));
  await probe.unlock();
  fail = false;
  await runCallerContainerInit({ ...f.options, stateDirectory, dockerRun });
  await probe.lock();
  assert.deepEqual(await probe.scopes(), []);
  await probe.unlock();
});

test('unpublished ordinary-volume scopes and resized fixed scopes are never adopted', async t => {
  const f = await fixture(t);
  await runCallerContainerInit(f.options);
  const before = await f.read();
  const runtime = before.backends.claude.caller_runtime;
  const store = new CallerRuntimeStore(runtime.stateDirectory, f.original.agent_id);
  const id = scopeDigest(f.original.agent_id, 'alice');
  await store.lock();
  await store.reserve(id, 'claude', 'alice');
  await store.unlock();
  await assert.rejects(runCallerContainerInit(f.options), /legacy or incomplete/);
  await store.lock();
  await new CallerStorage(runtime, store, f.dockerRun).reserve(id);
  const identity = await store.fixedStorage(id);
  await store.unlock();
  await assert.rejects(runCallerContainerInit({ ...f.options, storageMiB: 2048 }), /configuration changed/);
  assert.deepEqual(await f.read(), before);
  await store.lock();
  assert.equal(await store.fixedStorage(id), identity);
  await store.unlock();
});

for (const api of ['1.44 1.45', '1.45 1.44', 'unknown']) {
  test(`unsupported Docker API ${api} fails before builds or pool creation`, async t => {
    const f = await fixture(t);
    await assert.rejects(runCallerContainerInit({ ...f.options, dockerRun: async (args, opts) =>
      args[0] === 'version' ? success(api) : f.dockerRun(args, opts) }), /API 1.45/);
    assert.deepEqual(await f.read(), f.original);
    assert.equal(f.calls.some(args => ['build', 'volume', 'create'].includes(args[0])), false);
  });
}

test('aborted helper start cleans the disposable image without saving config', async t => {
  const f = await fixture(t);
  let aborted = false;
  await assert.rejects(runCallerContainerInit({ ...f.options, dockerRun: async (args, opts) => {
    if (args[0] === 'start' && !aborted) { aborted = true; throw new Error('command aborted'); }
    return f.dockerRun(args, opts);
  } }), /command aborted/);
  assert.deepEqual(await f.read(), f.original);
  assert.ok(f.calls.some(args => args[0] === 'create' && args.includes('delete')));
});

test('concurrent agents on one daemon inherit one policy without deleting the shared pool', async t => {
  const a = await fixture(t), b = await fixture(t);
  // Both use one Docker fixture while keeping separate private config/state.
  await Promise.all([
    runCallerContainerInit({ ...a.options, storageCapacityMiB: 4096, storageReserveMiB: 64 }),
    runCallerContainerInit({ ...b.options, kind: 'codex', storageCapacityMiB: 4096, storageReserveMiB: 64, dockerRun: a.dockerRun }),
  ]);
  const first = (await a.read()).backends.claude.caller_runtime.fixedImageStorage;
  const second = (await b.read()).backends.codex.caller_runtime.fixedImageStorage;
  assert.deepEqual(first, second);
  assert.equal(first.capacityMiB, 4096);
  assert.equal(first.reserveMiB, 64);
  assert.equal(a.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
});
