// Full compiled CLI + real Docker + deterministic Claude/Codex fixtures. No provider calls.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
const exec = promisify(execFile);
const binary = process.env.VICOOP_CLIENT_BIN;
const image = process.env.VICOOP_SMOKE_IMAGE;
if (!binary || !image)
  throw new Error(
    'set VICOOP_CLIENT_BIN (absolute compiled CLI path), VICOOP_SMOKE_IMAGE (pinned fixture image)',
  );
const kind = process.env.VICOOP_SMOKE_KIND || 'claude';
assert.ok(['claude', 'codex'].includes(kind));
const directory = await mkdtemp(join(tmpdir(), 'vicoop-caller-client-'));
const clientHome = join(directory, 'client-home');
await mkdir(clientHome, { mode: 0o700 });
const clientEnv = {
  ...process.env,
  VICOOP_HOME: clientHome,
  ANTHROPIC_API_KEY: 'fixture-host-secret',
  OPENAI_API_KEY: 'fixture-host-secret',
};
for (const key of [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
])
  delete clientEnv[key];
const key = join(directory, 'key');
const configPath = join(directory, 'config.json');
await writeFile(key, 'fixture-no-api-call', { mode: 0o600 });
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => server.once('listening', r));
const config = {
  server_url: `ws://127.0.0.1:${server.address().port}`,
  server_token: 'fixture',
  agent_id: 'smoke',
  backend: kind,
  backends: {
    [kind]: {
      runtime: 'container',
      caller_runtime: {
        image,
        stateDirectory: join(directory, 'state'),
        maxScopes: 2,
        taskTimeoutMs: 120_000,
      },
    },
  },
};
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
let socket;
let hellos = 0;
let child;
let logs = '';
let exit;
const frames = [];
server.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'hello') {
      assert.ok(frame.protocolCapabilities.includes('caller-runtime-v1'));
      assert.equal(
        frame.agentCard?.capabilities?.extensions?.some((x) =>
          x.uri.includes('openai-compat'),
        ),
        false,
      );
      socket = ws;
      hellos++;
      ws.send(
        JSON.stringify({
          type: 'hello.ack',
          protocolCapabilities: [
            'task-replay-v1',
            'execution-scope-v1',
            'caller-runtime-v1',
          ],
          disconnectGraceMs: 30_000,
          maxFrameBytes: 1048576,
        }),
      );
    } else {
      frames.push(frame);
      if (frame.executionId && frame.seq)
        ws.send(
          JSON.stringify({
            type: 'task.ack',
            taskId: frame.taskId,
            executionId: frame.executionId,
            acceptedSeq: frame.seq,
          }),
        );
    }
  });
});
async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}\n${logs}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function start() {
  const previous = hellos;
  child = spawn(binary, ['start', '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: clientEnv,
  });
  child.stdout.on('data', (x) => {
    logs += x;
  });
  child.stderr.on('data', (x) => {
    logs += x;
  });
  exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await waitFor(() => hellos > previous, 'daemon hello');
}
function assign(
  principal,
  id,
  text = 'hello',
  contextId = 'identical-context',
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'vicoop-execution-scope',
        'direct-principal-v1',
        'smoke',
        principal,
      ]),
    )
    .digest('hex');
  socket.send(
    JSON.stringify({
      type: 'task.assign',
      taskId: id,
      executionId: `exec-${id}`,
      contextId,
      caller: { principal: { id: principal } },
      executionScope: {
        policy: 'direct-principal-v1',
        id: digest,
        agentId: 'smoke',
        principalId: principal,
      },
      message: {
        role: 'user',
        messageId: `m-${id}`,
        parts: [{ kind: 'text', text }],
      },
    }),
  );
}
async function completed(id) {
  await waitFor(
    () =>
      frames.some(
        (x) =>
          x.taskId === id && ['task.complete', 'task.fail'].includes(x.type),
      ),
    id,
  );
  const terminal = frames.find(
    (x) => x.taskId === id && ['task.complete', 'task.fail'].includes(x.type),
  );
  assert.equal(terminal.type, 'task.complete', JSON.stringify(terminal));
  const output = frames
    .filter((x) => x.taskId === id && x.type === 'task.artifact')
    .flatMap((x) => x.artifact.parts)
    .filter((x) => x.kind === 'text')
    .map((x) => x.text)
    .join('');
  return JSON.parse(output);
}
async function stop(signal = 'SIGTERM') {
  if (!child) return;
  child.kill(signal);
  const result = await Promise.race([
    exit,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('daemon shutdown timed out')),
        20_000,
      ).unref(),
    ),
  ]);
  child = undefined;
  if (signal === 'SIGTERM') assert.equal(result.code, 0, logs);
}
let namespace;
async function container(principal) {
  const { stdout } = await exec('docker', [
    'ps',
    '-a',
    '--format',
    '{{.Names}}',
    '--filter',
    `label=vicoop.caller-namespace=${namespace}`,
    '--filter',
    `label=vicoop.scope=${createHash('sha256')
      .update(
        JSON.stringify([
          'vicoop-execution-scope',
          'direct-principal-v1',
          'smoke',
          principal,
        ]),
      )
      .digest('hex')}`,
  ]);
  return stdout.trim();
}
async function inspect(name, format) {
  return (
    await exec('docker', ['inspect', '--format', format, name])
  ).stdout.trim();
}
try {
  await exec(binary, ['container', 'init', kind, '--config', configPath, '--image', image], {
    env: clientEnv, cwd: directory, timeout: 120000,
  });
  const initialized = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(initialized.server_token, config.server_token);
  assert.equal(initialized.backends[kind].runtime, 'container');
  assert.match(initialized.backends[kind].caller_runtime.image, /^sha256:[a-f0-9]{64}$/);
  await start();
  namespace = createHash('sha256')
    .update(
      JSON.stringify([
        hostname(),
        await realpath(config.backends[kind].caller_runtime.stateDirectory),
        'smoke',
      ]),
    )
    .digest('hex');
  assign('apikey:a', 'a1');
  const a1 = await completed('a1');
  const a = await container('apikey:a'),
    aid = await inspect(a, '{{.Id}}');
  assign('apikey:b', 'b1');
  const b1 = await completed('b1');
  const b = await container('apikey:b');
  for (const principal of ['apikey:a', 'apikey:b']) {
    const id = createHash('sha256').update(JSON.stringify([
      'vicoop-execution-scope', 'direct-principal-v1', 'smoke', principal,
    ])).digest('hex');
    const db = new Database(join(directory, 'state', 'state.sqlite'), { readonly: true });
    try {
      const record = db.prepare('SELECT * FROM scopes WHERE id = ?').get(id);
      assert.deepEqual(record, { id, kind, namespace, agentId: 'smoke', principalId: principal });
    } finally { db.close(); }
  }
  assign('apikey:a', 'a2');
  const a2 = await completed('a2');
  assert.equal(a1.turn, 1);
  assert.equal(b1.turn, 1);
  assert.equal(a2.turn, 2);
  assert.equal(a1.session, a2.session);
  assert.notEqual(a1.session, b1.session);
  assert.equal(a2.resumed, true);
  assert.equal(a2.cwd, '/workspace');
  assert.equal(await inspect(a, '{{.Id}}'), aid);
  assign('apikey:a', 'a-new', 'hello', 'new-context');
  const anew = await completed('a-new');
  assert.notEqual(anew.session, a1.session);
  assert.equal(await inspect(a, '{{.Id}}'), aid);
  const before = hellos;
  socket.terminate();
  await waitFor(() => hellos > before, 'reconnect');
  assign('apikey:b', 'b2');
  assert.equal((await completed('b2')).session, b1.session);
  assign('apikey:a', 'cancel', 'hold-task');
  let pid = '';
  for (let i = 0; i < 100 && !pid; i++) {
    try {
      pid = (
        await exec('docker', ['exec', a, 'cat', '/workspace/hold.pid'])
      ).stdout.trim();
    } catch {}
    if (!pid) await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(pid, /^\d+$/);
  socket.send(
    JSON.stringify({
      type: 'task.cancel',
      taskId: 'cancel',
    }),
  );
  await waitFor(
    () =>
      frames.some(
        (f) =>
          f.taskId === 'cancel' &&
          ['task.complete', 'task.fail'].includes(f.type),
      ),
    'cancel terminal',
  );
  assert.equal(await inspect(a, '{{.State.Running}}'), 'false');
  assert.equal(await inspect(b, '{{.State.Running}}'), 'true');
  assign('apikey:b', 'b3');
  assert.equal((await completed('b3')).session, b1.session);
  assign('apikey:a', 'after-cancel');
  await completed('after-cancel');
  assert.ok(
    frames.some(
      (f) =>
        f.taskId === 'after-cancel' &&
        f.metadata?.['vicoop.runtime']?.conversationReset,
    ),
  );
  assign('apikey:a', 'crash', 'hold-task');
  await new Promise((r) => setTimeout(r, 500));
  await stop('SIGKILL');
  await start();
  assign('apikey:a', 'after-crash');
  const restored = await completed('after-crash');
  assert.ok(restored.turn >= 5);
  assert.equal(restored.resumed, false);
  assert.ok(
    frames.some(
      (f) =>
        f.taskId === 'after-crash' &&
        f.metadata?.['vicoop.runtime']?.conversationReset,
    ),
  );
  await stop();
  await exec(binary, ['caller-state', '--config', configPath], {
    env: clientEnv,
  });
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        'vicoop-execution-scope',
        'direct-principal-v1',
        'smoke',
        'apikey:a',
      ]),
    )
    .digest('hex');
  await exec(
    binary,
    ['caller-state', '--config', configPath, '--recreate-scope', scope],
    { env: clientEnv },
  );
  await start();
  assign('apikey:a', 'after-recreate');
  assert.equal((await completed('after-recreate')).turn, restored.turn + 1);
  assert.notEqual(await inspect(a, '{{.Id}}'), aid);
  await stop();
  const detachedHello = hellos;
  await exec(binary, ['start', '--detach', '--config', configPath], {
    env: clientEnv,
  });
  await waitFor(() => hellos > detachedHello, 'detached hello');
  assign('apikey:b', 'detached');
  await completed('detached');
  const stopped = await exec(binary, ['stop'], {
    env: clientEnv,
    timeout: 130000,
  });
  assert.ok(!/SIGKILL|force.kill/i.test(stopped.stdout + stopped.stderr));
  assert.equal(await inspect(b, '{{.State.Running}}'), 'false');
  console.log(
    `PASS ${kind}: compiled CLI init, SQLite mappings, A/B/A conversations, new-context container reuse, reconnect, isolated cancellation, forced restart, offline administration, recreate persistence and detached stop`,
  );
} finally {
  await stop();
  try {
    await exec(binary, ['stop'], { env: clientEnv, timeout: 130000 });
  } catch {}
  for (const ws of server.clients) ws.terminate();
  await new Promise((r) => server.close(r));
  if (namespace) {
    for (const [resource, list] of [
      ['container', ['ps', '-aq']],
      ['network', ['network', 'ls', '-q']],
      ['volume', ['volume', 'ls', '-q']],
    ]) {
      const { stdout } = await exec('docker', [
        ...list,
        '--filter',
        `label=vicoop.caller-namespace=${namespace}`,
      ]);
      for (const id of stdout.trim().split(/\s+/).filter(Boolean))
        await exec('docker', [
          resource,
          'rm',
          ...(resource === 'container' ? ['-f'] : []),
          id,
        ]);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
