// E2E for the stateful-context delta path (issue #410) on the claude backend.
//
// Proves that server-reconstructed `task.contextHistory` (the prior turns of a
// contextId, shipped on the `task.assign` frame in delta mode) actually reaches
// the model — i.e. the connector-side `mergeChatHistory` +
// `chatHistoryFromA2AMessages` fold runs end-to-end against the real `claude`
// CLI.
//
// Design — an A/B against an UNGUESSABLE secret. The envelope
// (`chat_completions_request.messages`) carries ONLY the new turn (exactly what
// the router forwards in delta mode); the secret lives ONLY in `contextHistory`.
//   - Arm WITH contextHistory  → the model MUST answer with the secret.
//   - Arm WITHOUT contextHistory → the model CANNOT know the secret.
// If WITH reveals the secret and WITHOUT does not, `contextHistory` is provably
// the channel that delivered the prior conversation.
//
// Prereqs:
//   - `claude` on PATH and authenticated
//   - dist built: `pnpm --filter @vicoop-bridge/client build`

import { createClaudeBackend } from '../dist/backends/claude.js';

const URI = 'https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1';

// Unguessable so a correct answer can only come from contextHistory, never a
// lucky prior. Kept stable across the two arms of a single run.
const SECRET = `zephyr-quokka-${Math.floor(Math.random() * 1e6)}`;
const NEW_TURN = 'What is the secret codeword I gave you earlier? Reply with ONLY the codeword, nothing else.';

// The prior conversation the server would have reconstructed from
// loadByContextId and shipped as A2A messages on `task.contextHistory`.
const contextHistory = [
  {
    role: 'user',
    messageId: 'h-1',
    parts: [{ kind: 'text', text: `Remember this: the secret codeword is "${SECRET}". Keep it for later.` }],
  },
  {
    role: 'agent',
    messageId: 'h-2',
    parts: [{ kind: 'text', text: 'Got it — I will remember the secret codeword.' }],
  },
];

function makeTask(withContext) {
  const t0 = Date.now();
  return {
    type: 'task.assign',
    taskId: `e2e-delta-${withContext ? 'with' : 'without'}-${t0}`,
    contextId: `e2e-delta-ctx-${t0}`,
    message: {
      role: 'user',
      messageId: `m-${t0}`,
      parts: [{ kind: 'text', text: NEW_TURN }],
      // Delta envelope: only the NEW turn is present here. In classic
      // full-replay mode this would carry the whole conversation; in delta
      // mode the prior turns live in contextHistory instead.
      metadata: {
        [URI]: {
          delta: true,
          chat_completions_request: {
            messages: [{ role: 'user', content: NEW_TURN }],
          },
        },
      },
    },
    ...(withContext ? { contextHistory } : {}),
  };
}

async function runArm(withContext) {
  const backend = createClaudeBackend({ extraArgs: ['--max-turns', '1'] });
  const task = makeTask(withContext);
  const frames = [];
  await backend.handle(task, (f) => frames.push(f), new AbortController().signal);

  const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');
  const text = frames
    .filter((f) => f.type === 'task.artifact')
    .flatMap((a) => a.artifact.parts.filter((p) => p.kind === 'text').map((p) => p.text))
    .join('')
    .trim();
  return { terminal, text };
}

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[e2e] FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`[e2e] PASS: ${msg}`);
  }
};

console.log(`[e2e] secret codeword (in contextHistory only): ${SECRET}`);
console.log(`[e2e] new turn (in envelope only): ${NEW_TURN}\n`);

console.log('[e2e] --- Arm A: WITH contextHistory ---');
const withArm = await runArm(true);
console.log(`[e2e] terminal=${withArm.terminal?.type} answer="${withArm.text}"\n`);

console.log('[e2e] --- Arm B: WITHOUT contextHistory (control) ---');
const withoutArm = await runArm(false);
console.log(`[e2e] terminal=${withoutArm.terminal?.type} answer="${withoutArm.text}"\n`);

const secretIn = (s) => s.toLowerCase().includes(SECRET.toLowerCase());

assert(withArm.terminal?.type === 'task.complete', 'Arm A completed');
assert(withoutArm.terminal?.type === 'task.complete', 'Arm B completed');
assert(secretIn(withArm.text), 'Arm A (WITH contextHistory) reveals the secret — prior context reached the model');
assert(!secretIn(withoutArm.text), 'Arm B (WITHOUT contextHistory) does NOT reveal the secret — control holds');

console.log(`\n[e2e] ${failed ? 'RESULT: FAIL' : 'RESULT: PASS — #410 delta contextHistory verified end-to-end'}`);
process.exit(failed ? 1 : 0);
