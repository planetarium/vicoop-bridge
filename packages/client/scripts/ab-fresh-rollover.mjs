// Fresh-data rollover test: unique nonce per run so the prefix is never
// pre-warmed by a prior run. turnN and turnN+1 share the SAME first-N entries
// (byte-identical), turnN+1 appends `step` new entries (a rollover).
//
// If the frozen history block can be incrementally READ on growth, turnN+1's
// non_cached (~creation) ≈ the appended delta. If the monolithic frozen block
// must be re-created on growth, non_cached ≈ the whole frozen prefix.
import { createClaudeBackend } from '../dist/backends/claude.js';

const URI = 'https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1';
// Unique per process run -> guarantees fresh bytes (no pre-warm from prior runs).
const NONCE = process.env.NONCE ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const FILLER = 'y'.repeat(760);

// Deterministic given NONCE+i, so turnN's entry i == turnN+1's entry i (byte-identical prefix).
function history(n) {
  const h = [];
  for (let i = 0; i < n; i++) {
    h.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `[${NONCE}] turn ${i} ${FILLER}` });
  }
  return h;
}

const TOOLS = [
  { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } } },
];

function task(n, label) {
  const messages = [...history(n), { role: 'user', content: 'Reply with exactly: ok' }];
  const t0 = `${Date.now()}-${label}`;
  return {
    type: 'task.assign',
    taskId: `fr-${t0}`,
    contextId: `fr-ctx-${t0}`,
    message: {
      role: 'user',
      messageId: `m-${t0}`,
      parts: [{ kind: 'text', text: 'Reply with exactly: ok' }],
      metadata: { [URI]: { chat_completions_request: { messages, tools: TOOLS } } },
    },
  };
}

const backend = createClaudeBackend({ extraArgs: ['--max-turns', '1'] });

async function run(n, label) {
  const frames = [];
  await backend.handle(task(n, label), (f) => frames.push(f), new AbortController().signal);
  const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');
  if (terminal?.type === 'task.fail') return { label, err: `${terminal.error.code}: ${terminal.error.message}`.slice(0, 120) };
  let usage = null;
  for (const f of frames) {
    const meta = f?.status?.message?.metadata?.[URI];
    const u = meta?.chat_completion?.usage ?? meta?.usage;
    if (u) usage = u;
  }
  if (!usage) return { label, err: 'no usage in frames' };
  const pt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return { label, entries: n, prompt_tokens: pt, cache_read: cached, non_cached: pt - cached };
}

const N0 = Number(process.env.N0 ?? 48); // turnN entry count
const N1 = Number(process.env.N1 ?? 58); // turnN+1 entry count (rollover; shares first N0)
console.log(`[fresh] NONCE=${NONCE} N0=${N0} N1=${N1}`);
const turnN = await run(N0, 'turnN');
console.log('  turnN   :', JSON.stringify(turnN));
// Sequential await: the cache entry is readable only after the first response
// begins, so turnN must complete before turnN+1 is sent.
const turnN1 = await run(N1, 'turnN1');
console.log(`  turnN+1 :`, JSON.stringify(turnN1), ` <- rollover (shares first ${N0} entries)`);
if (turnN1.non_cached != null && turnN.non_cached != null) {
  console.log(`[fresh] turnN cold creation=${turnN.non_cached}; ROLLOVER non-cached(~creation)=${turnN1.non_cached}, cache_read=${turnN1.cache_read}`);
  console.log(`[fresh] If incremental: rollover non_cached should be ~one rollover step of entries, NOT ~the whole frozen prefix.`);
}
