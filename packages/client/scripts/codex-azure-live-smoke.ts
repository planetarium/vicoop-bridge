// Paid real-provider acceptance, using only host-held Azure credentials.
// VICOOP_SMOKE_IMAGE must contain Codex >=0.153.4 and Node. Provider setup is
// identical to docs/codex-auth-broker.md. Creates only disposable caller state.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createCallerRuntime } from '../src/caller-runtime.js';
import { DockerCallerRuntimePool } from '../src/caller-runtime-docker.js';
import { CallerRuntimeConfig } from '../src/caller-runtime-config.js';
import { scopeDigest } from '../src/caller-runtime-store.js';
import { runDockerCommand } from '../src/docker-command.js';
import { createCodexCredentialReader } from '../src/codex-auth-broker.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

assert.ok(process.env.VICOOP_CODEX_AZURE_ENDPOINT, 'Explicit Azure provider required');
const selected = await createCodexCredentialReader()();
const image = process.env.VICOOP_SMOKE_IMAGE;
assert.ok(image, 'Set VICOOP_SMOKE_IMAGE to a pinned Codex caller image');
const directory = await mkdtemp(join(tmpdir(), 'codex-azure-live-'));
const agentId = 'azure-live-' + randomUUID();
const config = CallerRuntimeConfig.parse({ image, stateDirectory: directory,
  taskTimeoutMs: 180000,
  fileDelivery: { allowedRoots: ['/workspace/output'], maxBytes: 1024, maxTotalBytes: 2048, maxFiles: 2 } });
const args = { kind: 'codex' as const, agentId, config,
  codex: { approvalDecision: 'accept' as const } };
let backend: Awaited<ReturnType<typeof createCallerRuntime>> | undefined;
const fixture = Buffer.from([0, 255, 128, 65, 90, 85, 82, 69, 10]);
const sha256 = createHash('sha256').update(fixture).digest('hex');
const aliceScope = scopeDigest(agentId, 'alice');
const bobScope = scopeDigest(agentId, 'bob');
const contextId = randomUUID();
let report: object | undefined;
async function docker(argv: string[]) {
  const result = await runDockerCommand(argv, { maxOutputBytes: 16 * 1024 * 1024 });
  assert.equal(result.exitCode, 0, `Docker ${argv[0]} failed (output withheld)`);
  assert.ok(!result.stdout.includes(selected.secret), 'provider credential leaked from workload');
  return result.stdout.trim();
}
function text(frames: UpFrame[]) {
  return frames.filter(f => f.type === 'task.artifact').flatMap(f => f.artifact.parts)
    .filter(p => p.kind === 'text').map(p => p.text).join('');
}
async function run(principal: string, prompt: string, context = contextId,
  signal = AbortSignal.timeout(180000), expectedCancellation = false) {
  const task: TaskAssignFrame = { type: 'task.assign', taskId: randomUUID(), contextId: context,
    executionId: randomUUID(), executionScope: { policy: 'direct-principal-v1', agentId,
      principalId: principal, id: scopeDigest(agentId, principal) },
    caller: { version: 2, principal: { id: principal }, attestations: [] },
    message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: prompt }] } };
  const frames: UpFrame[] = [];
  await backend!.handle(task, f => { frames.push(f); }, signal);
  assert.ok(!JSON.stringify(frames).includes(selected.secret), 'provider credential leaked into A2A frames');
  const terminal = frames.at(-1);
  if (expectedCancellation) {
    assert.ok(signal.aborted, 'expected cancellation was not requested');
    assert.equal(terminal?.type, 'task.fail', 'cancellation must be terminal');
  } else {
    assert.equal(terminal?.type, 'task.complete', 'task failed (provider diagnostics withheld)');
    if (terminal.type === 'task.complete') assert.equal(terminal.status.state, 'completed');
  }
  console.log(JSON.stringify({ step: 'task', principal, terminal: terminal?.type,
    files: frames.filter(f => f.type === 'task.artifact').flatMap(f => f.artifact.parts).filter(p => p.kind === 'file').length }));
  return frames;
}
function verifyFile(frames: UpFrame[]) {
  const parts = frames.filter(f => f.type === 'task.artifact').flatMap(f => f.artifact.parts).filter(p => p.kind === 'file');
  assert.equal(parts.length, 1, 'model must invoke native send_file exactly once');
  assert.equal(parts[0].file.name, 'fixture.bin');
  const received = Buffer.from(parts[0].file.bytes!, 'base64');
  assert.deepEqual(received, fixture, 'consumer attachment bytes mismatch');
  assert.equal(createHash('sha256').update(received).digest('hex'), sha256);
}
try {
  backend = await createCallerRuntime(args);
  const first = await run('alice', 'Remember ORCHID as this conversation secret word. In the disposable workspace, create /workspace/output/fixture.bin with exact bytes hex 00ff80415a5552450a using a shell tool. Find the native send_file tool using tool search, then call send_file with path /workspace/output/fixture.bin exactly once to attach the actual binary. Do not just print a path or base64. Finally reply ORCHID.');
  verifyFile(first);
  const alice = backend.pool.name(aliceScope), bob = backend.pool.name(bobScope);
  const version = await docker(['exec', alice, 'codex', '--version']);
  const resumed = await run('alice', 'First recall the secret word from the previous turn without reading files. Then rediscover the native send_file tool for this execution and send /workspace/output/fixture.bin exactly once again. Reply with the secret word.');
  assert.match(text(resumed), /ORCHID/); verifyFile(resumed);
  const parallelTask = (principal: string) => run(principal,
    `Use a shell tool to execute exactly: echo $$ > /workspace/parallel.pid; sleep 30; echo ${principal.toUpperCase()}_PARALLEL. Then reply with that marker.`, randomUUID());
  const concurrent = Promise.all([parallelTask('alice'), parallelTask('bob')]);
  void concurrent.catch(() => {});
  let overlap = false;
  const overlapDeadline = Date.now() + 90000;
  while (Date.now() < overlapDeadline && !overlap) {
    const observed = await Promise.all([alice,bob].map(container => runDockerCommand([
      'exec',container,'node','-e',`const fs=require('fs');try{const p=fs.readFileSync('/workspace/parallel.pid','utf8').trim();const children=fs.readFileSync('/proc/'+p+'/task/'+p+'/children','utf8').trim().split(/\\s+/);process.exit(children.some(c=>fs.readFileSync('/proc/'+c+'/cmdline','utf8').includes('sleep'))?0:1);}catch{process.exit(1);}`])));
    overlap = observed.every(result => result.exitCode === 0);
    if (!overlap) await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Inspect only disposable workload files/environment. The secret is never
  // passed as an argument, a mount, or an environment value to the container.
  async function inspectCredentialIsolation() {
  const snapshot = await docker(['exec', alice, 'node', '-e', `
    const fs=require('fs');const values=[JSON.stringify(process.env)];
    for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p))continue;
      try{values.push(fs.readFileSync('/proc/'+p+'/environ','utf8'));}catch{}}
    function walk(p){for(const n of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+n.name;
      if(n.isDirectory())walk(f);else if(n.isFile()&&/\\.(json|jsonl|toml|log)$/.test(f)&&fs.statSync(f).size<4000000)values.push(fs.readFileSync(f,'utf8'));}}
    walk('/data/sessions/codex');console.log(JSON.stringify(values));`]);
  assert.ok(!snapshot.includes(selected.secret));
  }
  assert.ok(overlap, 'independent caller shell processes never overlapped');
  await inspectCredentialIsolation();
  const replies = await concurrent;
  await inspectCredentialIsolation();
  assert.ok(overlap, 'independent caller shell processes never overlapped');
  assert.match(text(replies[0]), /ALICE_PARALLEL/);
  assert.match(text(replies[1]), /BOB_PARALLEL/);
  await docker(['exec', bob, 'test', '!', '-e', '/workspace/output/fixture.bin']);
  const controller = new AbortController();
  const cancellation = run('alice', 'Execute exactly this shell command and wait until it finishes: echo $$ > /workspace/cancel.pid; exec sleep 90', randomUUID(), controller.signal, true);
  void cancellation.catch(() => {});
  let pid = '';
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !pid) {
      const r = await runDockerCommand(['exec', alice, 'cat', '/workspace/cancel.pid']);
      if (r.exitCode === 0) pid = r.stdout.trim();
      if (!pid) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.match(pid, /^\d+$/, 'cancellation probe never reached a running shell');
    const command = await docker(['exec', alice, 'cat', `/proc/${pid}/cmdline`]);
    const processArgs = command.split('\0');
    assert.equal(processArgs[0].split('/').at(-1), 'sleep', 'cancellation must interrupt the observed live sleep process');
    assert.equal(processArgs[1], '90');
  } finally { controller.abort(); await cancellation; }
  assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', alice]), 'false', 'canceled caller container remains running');
  assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', bob]), 'true', 'unrelated caller was canceled');
  await backend.close(); backend = undefined;
  backend = await createCallerRuntime(args);
  const afterRestart = await run('alice', 'The runtime restarted. Rediscover native send_file and send the preserved /workspace/output/fixture.bin exactly once. Reply DONE.');
  assert.match(JSON.stringify(afterRestart), /conversationReset/, 'recovery must explicitly report the existing conversation reset');
  verifyFile(afterRestart);
  report = { result: 'PASS', version, provider: 'azure-openai', sha256,
    inference: true, resume: true, workspaceAfterRuntimeRestart: true, explicitConversationResetAfterRestart: true,
    nativeSendFileActualBytes: true, concurrentCallers: true, callerIsolation: true,
    observedToolCancellation: true, stoppedCanceledContainer: true, credentialIsolation: true,
    transport: 'caller runtime TaskAssign/UpFrame; HTTP gateway not exercised' };
} finally {
  try { await backend?.close(); }
  finally {
    const cleanup = new DockerCallerRuntimePool('codex', config, agentId);
    try {
      await cleanup.initialize(false);
      const results = await Promise.allSettled((await cleanup.store.scopes()).map(id => cleanup.remove(id, true)));
      const failed = results.filter(result => result.status === 'rejected');
      assert.equal(failed.length, 0, 'disposable caller cleanup failed');
    } catch (error) {
      console.error('Caller cleanup failed; retained recovery state at ' + directory);
      throw error;
    } finally {
      await cleanup.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(report));
