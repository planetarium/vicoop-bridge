// Paid Foundry caller-container acceptance. Host credentials never enter Docker.
// Same provider environment as docs/claude-foundry.md; requires pinned VICOOP_SMOKE_IMAGE.
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { createClaudeCredentialReader } from '../src/claude-auth-broker.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCallerRuntime } from '../src/caller-runtime.js';
import {
  DockerCallerRuntimePool,
  type CallerKind,
} from '../src/caller-runtime-docker.js';
import { CallerRuntimeConfig } from '../src/caller-runtime-config.js';
import { scopeDigest } from '../src/caller-runtime-store.js';
import { runDockerCommand } from '../src/docker-command.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';
const kind: CallerKind = 'claude';
assert.equal(process.env.CLAUDE_CODE_USE_FOUNDRY, '1', 'Explicit Foundry configuration required');
const selected = await createClaudeCredentialReader()();
const diagnostics: string[] = [];
const savedConsole = {log:console.log,warn:console.warn,error:console.error,info:console.info};
for (const name of ['log','warn','error','info'] as const) console[name] = (...args: unknown[]) => { diagnostics.push(format(...args)); };
let report: string | undefined;
const image = process.env.VICOOP_SMOKE_IMAGE;
assert.ok(image);
const directory = await mkdtemp(
  join(tmpdir(), `vicoop-caller-provider-${kind}-`),
);
const agent = `provider-smoke-${randomUUID()}`;
const config = CallerRuntimeConfig.parse({
  image,
  stateDirectory: directory,
  taskTimeoutMs: 120000,
});
const model =
  process.env.VICOOP_SMOKE_MODEL ??
  (kind === 'claude' ? 'claude-haiku-4-5' : 'gpt-5.5');
const args = {
  kind,
  agentId: agent,
  config,
  claude: { model, settings: { sandbox: { failIfUnavailable: false } } },
  codex: {
    appServerArgs: ['app-server', '-c', `model=${JSON.stringify(model)}`],
    readCodexConfigToml: async () => `model=${JSON.stringify(model)}`,
    approvalDecision: 'accept' as const,
  },
};
let backend: Awaited<ReturnType<typeof createCallerRuntime>> | undefined;
const ids = ['alice', 'bob'].map((p) => scopeDigest(agent, p));
async function docker(args: string[]) {
  const r = await runDockerCommand(args, {maxOutputBytes:16*1024*1024});
  assert.ok(!(r.stdout+r.stderr).includes(selected.secret), 'host key leaked through Docker diagnostics');
  assert.equal(r.exitCode, 0, 'Docker command failed (diagnostics withheld)');
  return r.stdout.trim();
}
function messageText(frames: UpFrame[]): string {
  return frames
    .filter(
      (f) =>
        f.type === 'task.artifact' && f.artifact.name?.endsWith('-message'),
    )
    .flatMap((f) => (f.type === 'task.artifact' ? f.artifact.parts : []))
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('');
}
async function run(
  principal: string,
  text: string,
  contextId = 'shared',
  signal = AbortSignal.timeout(120000),
  expectedCancellation = false,
) {
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: randomUUID(),
    contextId,
    executionId: randomUUID(),
    executionScope: {
      policy: 'direct-principal-v1',
      agentId: agent,
      principalId: principal,
      id: scopeDigest(agent, principal),
    },
    caller: { version: 2, principal: { id: principal }, attestations: [] },
    message: {
      role: 'user',
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
    },
  } as TaskAssignFrame;
  const frames: UpFrame[] = [];
  await backend!.handle(task, (f) => frames.push(f), signal);
  assert.ok(!JSON.stringify(frames).includes(selected.secret), 'host key leaked into A2A artifacts/status');
  const last = frames.at(-1);
  if (expectedCancellation) {
    assert.ok(signal.aborted, 'expected cancellation was not requested');
    assert.equal(last?.type, 'task.fail');
    return frames;
  }
  if (last?.type === 'task.fail') throw new Error('Foundry caller task failed (diagnostics withheld)');
  assert.equal(last?.type, 'task.complete');
  assert.equal((last as any).status.state, 'completed');
  return frames;
}
try {
  backend = await createCallerRuntime(args);
  await run(
    'alice',
    'We are running a filesystem persistence integration test in this disposable workspace. Please create /workspace/owner.txt with the exact contents ALICE using a shell or Write tool, then read it back to verify. The test label for this conversation is ORCHID. Confirm when the file has actually been written.',
  );
  const a = backend.pool.name(ids[0]),
    b = backend.pool.name(ids[1]);
  const firstId = await docker(['inspect', '--format', '{{.Id}}', a]);
  await run(
    'bob',
    'We are running an isolation integration test in this disposable workspace. Verify /workspace/owner.txt does not exist, then create it with the exact contents BOB using a shell or Write tool and read it back. The test label for this conversation is TULIP. Confirm the result.',
  );
  const resumed = await run(
    'alice',
    'What was the test label for this conversation? Reply with that label.',
  );
  assert.ok(!JSON.stringify(resumed).includes('conversationReset'), 'ordinary resume unexpectedly reset the conversation');
  assert.match(messageText(resumed), /ORCHID/);
  await run(
    'alice',
    'Read /workspace/owner.txt and reply only its contents.',
    'new-conversation',
  );
  assert.equal(await docker(['inspect', '--format', '{{.Id}}', a]), firstId);
  assert.equal(
    await docker(['exec', a, 'cat', '/workspace/owner.txt']),
    'ALICE',
  );
  assert.equal(await docker(['exec', b, 'cat', '/workspace/owner.txt']), 'BOB');
  const cancel = new AbortController();
  const cancellation = run(
    'alice',
    'For an integration test of process cancellation, execute this shell command and wait for it: echo $$ > /workspace/cancel.pid; exec sleep 60',
    'cancel-test',
    cancel.signal,
    true,
  );
  void cancellation.catch(() => {});
  // Observe the running tool before canceling; a timer alone would not prove
  // that a workload had reached execution.
  let pid = '';
  try {
    for (let attempt = 0; attempt < 300 && !pid; attempt++) {
      const read = await runDockerCommand([
        'exec',
        a,
        'cat',
        '/workspace/cancel.pid',
      ]);
      if (read.exitCode === 0) pid = read.stdout.trim();
      if (!pid) await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(pid, /^\d+$/, 'model did not start the cancellation probe');
    const command = await docker(['exec',a,'cat',`/proc/${pid}/cmdline`]);
    assert.equal(command.split('\0')[0].split('/').at(-1),'sleep');
    assert.equal(command.split('\0')[1],'60');
    const snapshot = await docker(['exec',a,'node','-e',String.raw`
      const fs=require('fs');const values=[JSON.stringify(process.env)];
      for(const p of fs.readdirSync('/proc')){if(!/^\d+$/.test(p))continue;
        try{values.push(fs.readFileSync('/proc/'+p+'/environ','utf8'));}catch{}}
      function walk(p){for(const n of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+n.name;
        if(n.isDirectory())walk(f);else if(n.isFile()&&/\.(json|jsonl|toml|log)$/.test(f)&&fs.statSync(f).size<4000000)values.push(fs.readFileSync(f,'utf8'));}}
      walk('/data/sessions/claude');console.log(JSON.stringify(values));`]);
    assert.ok(!snapshot.includes(selected.secret),'host key leaked into active workload environment/session files');
    const inspect = await docker(['inspect',a]);
    assert.ok(!inspect.includes(selected.secret),'host key leaked into container configuration/mounts');
  } finally {
    cancel.abort();
    await cancellation;
  }
  assert.equal(
    await docker(['inspect', '--format', '{{.State.Running}}', a]),
    'false',
  );
  assert.equal(
    await docker(['inspect', '--format', '{{.State.Running}}', b]),
    'true',
  );
  await backend.close();
  backend = undefined;
  const admin = new DockerCallerRuntimePool(kind, config, agent);
  try {
    await admin.initialize(false);
    await admin.remove(ids[0], false);
  } finally { await admin.close(); }
  backend = await createCallerRuntime(args);
  const restored = await run(
    'alice',
    'Read /workspace/owner.txt and reply only its contents.',
  );
  assert.match(JSON.stringify(restored), /conversationReset/);
  assert.equal(
    await docker(['exec', a, 'cat', '/workspace/owner.txt']),
    'ALICE',
  );
  report = `PASS Foundry: Claude ${model}, real caller inference, A/B/A conversation resume, caller workspace isolation, observed-tool cancellation, restart/recreate workspace persistence, explicit conversation reset, host key absent from A2A frames/logs/container configuration/active workload environment/session text`;
} finally {
  try {
    try { await backend?.close(); }
    finally {
      const cleanup = new DockerCallerRuntimePool(kind, config, agent);
      try {
        await cleanup.initialize(false);
        const outcomes = await Promise.allSettled((await cleanup.store.scopes()).map(id => cleanup.remove(id,true)));
        assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'), 'Caller cleanup failed; recovery state retained at '+directory);
      } finally { await cleanup.close(); }
      await rm(directory,{recursive:true,force:true});
    }
    assert.ok(!diagnostics.join('\n').includes(selected.secret),'host key leaked into captured runtime logs');
  } finally { Object.assign(console,savedConsole); }
}
console.log(report);
