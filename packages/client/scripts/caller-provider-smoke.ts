// Real-provider acceptance. Uses existing host credentials without printing them.
import assert from 'node:assert/strict';
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
const kind = process.env.VICOOP_SMOKE_KIND as CallerKind;
assert.ok(['claude', 'codex'].includes(kind));
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
  const r = await runDockerCommand(args);
  assert.equal(r.exitCode, 0, r.stderr);
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
  if (process.env.VICOOP_SMOKE_DEBUG) console.log(messageText(frames));
  const last = frames.at(-1);
  if (signal.aborted) {
    assert.equal(last?.type, 'task.fail');
    return frames;
  }
  if (last?.type === 'task.fail') throw new Error(JSON.stringify(last.error));
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
  );
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
  await admin.initialize(false);
  await admin.remove(ids[0], false);
  await admin.close();
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
  console.log(
    `PASS ${kind}: real ${model} inference, A/B/A live conversation, new context reuses container, workspace isolation, observed-tool cancellation, restart/recreate persistence and explicit conversation reset`,
  );
} finally {
  await backend?.close();
  const cleanup = new DockerCallerRuntimePool(kind, config, agent);
  await cleanup.initialize(false);
  for (const id of await cleanup.store.scopes()) await cleanup.remove(id, true);
  await cleanup.close();
  await rm(directory, { recursive: true, force: true });
}
