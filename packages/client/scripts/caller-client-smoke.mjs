// Full CLI + real Docker + deterministic Claude stream fixture. No paid model.
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
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
const directory = await mkdtemp(join(tmpdir(), 'vicoop-caller-client-'));
const key = join(directory, 'key');
const configPath = join(directory, 'config.json');
await writeFile(key, 'fixture-no-api-call', { mode: 0o600 });
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => server.once('listening', r));
const config = {
  server_url: `ws://127.0.0.1:${server.address().port}`,
  server_token: 'fixture',
  agent_id: 'smoke',
  backend: 'claude',
  backends: { claude: { runtime: 'caller-container' } },
  caller_runtime: {
    image,
    credentialFile: key,
    stateDirectory: join(directory, 'state'),
    workspaceMiB: 16,
    maxScopes: 2,
    taskTimeoutMs: 120_000,
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
function assign(principal, id, text = 'hello') {
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
      contextId: 'identical-context',
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
try {
  await start();
  assign('apikey:a', 'a1');
  const a1 = await completed('a1');
  assign('apikey:b', 'b1');
  const b1 = await completed('b1');
  assign('apikey:a', 'a2');
  const a2 = await completed('a2');
  assert.equal(a1.turn, 1);
  assert.equal(b1.turn, 1);
  assert.equal(a2.turn, 2);
  assert.equal(a1.session, a2.session);
  assert.notEqual(a1.session, b1.session);
  assert.equal(a2.resumed, true);
  assert.equal(a2.cwd, '/state/workspace');
  assert.equal(a2.promptStaged, true);
  const before = hellos;
  assign('apikey:b', 'replay', 'delay-task');
  await waitFor(
    () => frames.some((x) => x.taskId === 'replay'),
    'replay task started',
  );
  socket.terminate();
  await waitFor(() => hellos > before, 'reconnect hello');
  assert.equal((await completed('replay')).turn, 2);
  assign('apikey:a', 'crash', 'hold-task');
  // Prove the killed generation wrote uncommitted state before forcing exit.
  const namespace = createHash('sha256')
    .update(
      JSON.stringify([
        hostname(),
        await realpath(config.caller_runtime.stateDirectory),
        'smoke',
      ]),
    )
    .digest('hex');
  let observedWrite = false;
  for (let attempt = 0; attempt < 50 && !observedWrite; attempt++) {
    const { stdout } = await exec('docker', [
      'ps',
      '--format',
      '{{.Names}}',
      '--filter',
      `label=vicoop.caller-namespace=${namespace}`,
    ]);
    for (const name of stdout.trim().split(/\s+/).filter(Boolean)) {
      try {
        const result = await exec('docker', [
          'exec',
          '--user',
          '1000:1000',
          name,
          'cat',
          '/state/workspace/counter',
        ]);
        if (result.stdout.trim() === '3') observedWrite = true;
      } catch {
        /* Allocation may still be staging state. */
      }
    }
    if (!observedWrite) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    observedWrite,
    'crashed task must actually mutate its uncommitted workspace',
  );
  await stop('SIGKILL');
  await start();
  assign('apikey:a', 'restored');
  const restored = await completed('restored');
  assert.equal(restored.turn, 3);
  assert.equal(restored.resumed, false);
  assert.notEqual(restored.session, a1.session);
  assert.ok(
    frames.some(
      (x) =>
        x.taskId === 'restored' &&
        x.metadata?.['vicoop.runtime']?.conversationReset,
    ),
  );
  await stop();
  console.log(
    'compiled caller client smoke passed: Claude argv/prompt staging, A/B/A sessions+files, disconnect/replay, forced restart+reset, orderly shutdown',
  );
} finally {
  await stop();
  for (const ws of server.clients) ws.terminate();
  await new Promise((r) => server.close(r));
  // Reconcile any remaining generation after test failure before deleting state.
  const { DockerCallerRuntimePool } = await import(
    '../dist/caller-runtime-docker.js'
  );
  const pool = new DockerCallerRuntimePool({
    ...config.caller_runtime,
    agentId: 'smoke',
  });
  await pool.initialize();
  await pool.close();
  await rm(directory, { recursive: true });
}
