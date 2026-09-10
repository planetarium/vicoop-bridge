// Opt-in, real Docker. No model API call. Also compile this with Bun.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DockerCallerRuntimePool,
  type CallerTaskRuntime,
} from '../src/caller-runtime-docker.js';
import { scopeDigest } from '../src/caller-runtime-store.js';
import { runDockerCommand } from '../src/docker-command.js';

const image = process.env.VICOOP_SMOKE_IMAGE;
if (!image)
  throw new Error(
    'set VICOOP_SMOKE_IMAGE to a local pinned image with sh, sleep, mkdir and UID 1000 support',
  );
const directory = await mkdtemp(join(tmpdir(), 'vicoop-caller-smoke-'));
const key = join(directory, 'key');
await writeFile(key, 'smoke-key-never-used', { mode: 0o600 });
const options = {
  image,
  credentialFile: key,
  stateDirectory: join(directory, 'state'),
  agentId: 'smoke',
  workspaceMiB: 8,
  maxScopes: 2,
};
let pool = new DockerCallerRuntimePool(options);
async function shell(
  runtime: CallerTaskRuntime,
  code: string,
  env?: Record<string, string>,
) {
  const child = runtime.spawn('sh', ['-c', code], {
    cwd: '/state/workspace',
    env,
  });
  let output = '';
  let error = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    error += chunk;
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('close', resolve);
    child.on('error', reject);
  });
  child.stdin!.end();
  assert.equal(await exit, 0, error);
  return output;
}
const a = scopeDigest('smoke', 'apikey:a');
const b = scopeDigest('smoke', 'apikey:b');
try {
  assert.deepEqual(await pool.initialize(), []);
  await assert.rejects(
    new DockerCallerRuntimePool(options).initialize(),
    /live owner/,
  );
  let runtime = await pool.start(a, new AbortController().signal);
  assert.equal(
    await shell(
      runtime,
      'printf A > value; printf session > "$CLAUDE_CONFIG_DIR/session"; printf "%s|%s" "$PWD" "$CHECK"',
      { CHECK: 'literal $value; spaces' },
    ),
    '/state/workspace|literal $value; spaces',
  );
  await shell(runtime, 'sleep 90 >/tmp/background.out 2>&1 &');
  await runtime.finish(true);
  runtime = await pool.start(b, new AbortController().signal);
  assert.equal(
    await shell(
      runtime,
      'test ! -e value; test ! -e "$CLAUDE_CONFIG_DIR/session"; printf B > value; cat value',
    ),
    'B',
  );
  await runtime.finish(true);
  runtime = await pool.start(a, new AbortController().signal);
  assert.equal(
    await shell(runtime, 'cat value; cat "$CLAUDE_CONFIG_DIR/session"'),
    'Asession',
  );
  await shell(runtime, 'printf discarded > value');
  await runtime.finish(false);
  await pool.close();
  pool = new DockerCallerRuntimePool(options);
  assert.deepEqual((await pool.initialize()).sort(), [a, b].sort());
  runtime = await pool.start(a, new AbortController().signal);
  assert.equal(await shell(runtime, 'cat value'), 'A');
  // The tmpfs size is enforced even when rootfs writes are unavailable.
  assert.equal(
    await shell(
      runtime,
      'if dd if=/dev/zero of=large bs=1M count=16 2>/dev/null; then exit 1; fi; test ! -w /usr; printf bounded',
    ),
    'bounded',
  );
  await runtime.finish(false);
  const controller = new AbortController();
  runtime = await pool.start(a, controller.signal);
  const child = runtime.spawn('sh', ['-c', 'sleep 90'], {
    cwd: '/state/workspace',
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('close', () => resolve());
    child.on('error', reject);
  });
  child.stdin!.end();
  controller.abort();
  await exited;
  await runtime.finish(false);
  const left = await pool.start(a, new AbortController().signal);
  const right = await pool.start(b, new AbortController().signal);
  const listener = right.spawn(
    'node',
    [
      '-e',
      "require('node:net').createServer().listen(43210,'0.0.0.0',()=>console.log('ready'))",
    ],
    { cwd: '/state/workspace' },
  );
  const ready = new Promise<void>((resolve, reject) => {
    listener.stdout!.once('data', () => resolve());
    listener.on('error', reject);
  });
  const listenerClosed = new Promise<void>((resolve) => {
    listener.on('close', () => resolve());
  });
  listener.stdin!.end();
  await ready;
  const names = await runDockerCommand([
    'ps',
    '--format',
    '{{.Names}}',
    '--filter',
    `label=vicoop.caller-namespace=${pool.store.namespace}`,
    '--filter',
    `label=vicoop.scope=${b}`,
  ]);
  assert.equal(names.exitCode, 0);
  const address = await runDockerCommand([
    'inspect',
    names.stdout.trim(),
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
  ]);
  assert.equal(address.exitCode, 0);
  assert.match(address.stdout.trim(), /^[0-9.]+$/);
  assert.equal(
    await shell(
      left,
      `node -e 'const s=require("node:net").connect(43210,process.env.PEER);const t=setTimeout(()=>{s.destroy();console.log("isolated")},500);s.on("connect",()=>process.exit(1));s.on("error",()=>{clearTimeout(t);console.log("isolated")})'`,
      { PEER: address.stdout.trim() },
    ),
    'isolated\n',
  );
  await left.finish(false);
  await right.finish(false);
  await listenerClosed;
  await pool.close();
  const remaining = await runDockerCommand([
    'ps',
    '-aq',
    '--filter',
    `label=vicoop.caller-namespace=${pool.store.namespace}`,
  ]);
  assert.equal(remaining.exitCode, 0);
  assert.equal(remaining.stdout.trim(), '');
  assert.ok((await readFile(pool.store.path(a))).length > 0);
  console.log(
    'caller runtime Docker smoke passed: A/B/A, state restore, rollback, bounded storage, network separation, cancel, cleanup',
  );
} finally {
  // Do not hide cleanup failures or delete evidence when Docker cleanup fails.
  await pool.close();
  await rm(directory, { recursive: true });
}
