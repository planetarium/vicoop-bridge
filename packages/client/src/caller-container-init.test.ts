import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  runCallerContainerInit,
  type CallerContainerInitOptions,
} from './caller-container-init.js';
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
  const dockerRun: AsyncDockerRun = async (args) => {
    calls.push([...args]);
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
      for (const [name, content] of Object.entries(CALLER_IMAGE_FILES))
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
  assert.ok(f.calls.at(-1)?.includes('-v'));
  assert.equal(check.includes('--env'), false);
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.equal(f.calls.at(-1)?.[0], 'rm');
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
