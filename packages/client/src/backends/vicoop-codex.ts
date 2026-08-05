import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  type BridgeUsage,
  type Part,
  type UsageAccount,
  type UsageWindow,
} from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { normalizeTaskFailError } from '../failure-code.js';
import { HEARTBEAT_INTERVAL_MS, startLivenessHeartbeat } from './heartbeat.js';
import { createLogger, type Logger } from '../logger.js';
import { createTimingRecorder } from './timing.js';
import {
  clampPercent,
  deriveSeverity,
  epochSecondsToIso,
} from './usage-normalize.js';
import {
  chatHistoryFromMessages,
  collectSystemFromMessages,
  dumpOpenAICompatTaskWire,
  parseOpenAICompatEnvelope,
  type OpenAICompatHistoryEntry,
  type OpenAICompatMessageContent,
  type OpenAICompatRequestEnvelope,
} from './openai-compat.js';
import {
  buildOpenAICompatResponseMetadata,
  toProtocolTaskUsage,
  buildOpenAICompatUsage,
  type OpenAICompatUsage,
} from './openai-compat-usage.js';

// vicoop-codex serve reports rolling windows by their length in seconds; map the
// standard ones to canonical ids (unknown lengths keep a positional fallback).
const CODEX_WINDOW_META: Record<string, { id: string; label: string }> = {
  '18000': { id: 'session_5h', label: '5-hour session' },
  '604800': { id: 'weekly', label: 'Weekly (all models)' },
};

function codexWindow(
  raw: unknown,
  fallbackId: string,
  fallbackLabel: string,
  nowMs: number,
): UsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as {
    used_percent?: unknown;
    remaining_percent?: unknown;
    limit_window_seconds?: unknown;
    reset_after_seconds?: unknown;
    reset_at?: unknown;
  };
  const usedPercent = clampPercent(
    typeof w.used_percent === 'number'
      ? w.used_percent
      : typeof w.remaining_percent === 'number'
        ? 100 - w.remaining_percent
        : 0,
  );
  const meta =
    typeof w.limit_window_seconds === 'number'
      ? CODEX_WINDOW_META[String(w.limit_window_seconds)]
      : undefined;
  const resetsAt =
    typeof w.reset_at === 'number'
      ? epochSecondsToIso(w.reset_at)
      : typeof w.reset_after_seconds === 'number'
        ? epochSecondsToIso(Math.floor(nowMs / 1000) + w.reset_after_seconds)
        : null;
  return {
    id: meta?.id ?? fallbackId,
    label: meta?.label ?? fallbackLabel,
    usedPercent,
    resetsAt,
    severity: deriveSeverity(usedPercent),
  };
}

// Normalise vicoop-codex serve's GET /usage `{ accounts: [...] }` payload into
// the canonical BridgeUsage shape (see @vicoop-bridge/protocol). Exported for
// unit tests.
export function normalizeCodexServeUsage(
  raw: unknown,
  fetchedAt: string,
  nowMs: number,
): BridgeUsage {
  const accountsRaw = (raw as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accountsRaw)) {
    return {
      backend: 'vicoop-codex',
      source: 'serve',
      fetchedAt,
      accounts: [],
      note: 'unexpected serve /usage shape (no accounts array)',
      raw,
    };
  }
  const accounts: UsageAccount[] = accountsRaw.map((a) => {
    const acct = (a ?? {}) as {
      key?: unknown;
      email?: unknown;
      plan_type?: unknown;
      error?: unknown;
      primary?: unknown;
      secondary?: unknown;
    };
    const windows: UsageWindow[] = [];
    const primary = codexWindow(acct.primary, 'primary', 'Primary window', nowMs);
    if (primary) windows.push(primary);
    const secondary = codexWindow(acct.secondary, 'secondary', 'Secondary window', nowMs);
    if (secondary) windows.push(secondary);
    return {
      id: typeof acct.key === 'string' ? acct.key : 'unknown',
      ...(typeof acct.email === 'string' ? { label: acct.email } : {}),
      ...(typeof acct.plan_type === 'string' ? { plan: acct.plan_type } : {}),
      windows,
      ...(typeof acct.error === 'string' ? { note: acct.error } : {}),
    };
  });
  return { backend: 'vicoop-codex', source: 'serve', fetchedAt, accounts, raw };
}

// Slim subset of ChildProcess the backend actually uses. Tests inject a
// fake that satisfies this without wiring up a real OS process.
export interface VicoopCodexChildHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface VicoopCodexSpawnOptions {
  cwd?: string;
}

export type VicoopCodexSpawnFn = (
  command: string,
  args: readonly string[],
  options: VicoopCodexSpawnOptions,
) => VicoopCodexChildHandle;

// Minimal subset of `fetch`'s Response the backend consumes from
// `vicoop-codex serve`'s streaming `POST /v1/chat/completions`. Production
// wraps the global `fetch` (see `defaultFetch`); tests inject a fake that
// satisfies this without an HTTP round-trip.
export interface VicoopCodexStreamResponse {
  readonly ok: boolean;
  readonly status: number;
  // Full body as text — read only on the non-2xx error path for diagnostics.
  text(): Promise<string>;
  // Decoded UTF-8 chunks of the SSE body, in arrival order. Chunk boundaries
  // are arbitrary (not aligned to SSE events); the parser reassembles lines.
  chunks(): AsyncIterable<string>;
}

export type VicoopCodexFetchFn = (
  url: string,
  init: { body: string; signal: AbortSignal },
) => Promise<VicoopCodexStreamResponse>;

export interface VicoopCodexBackendOptions {
  // Mostly test seams — the production CLI calls `createVicoopCodexBackend()`
  // with just the operator-facing knobs below (`reasoning`,
  // `openaiCompatTrace`). Defaults below cover the production path; tests
  // inject `spawn` / `logger` / `fetch` / timing overrides.
  command?: string;
  cwd?: string;
  extraArgs?: readonly string[];
  spawn?: VicoopCodexSpawnFn;
  stderrCaptureBytes?: number;
  // Test seam for the streaming HTTP call to `vicoop-codex serve`'s
  // `/v1/chat/completions`. Production defaults to the global `fetch`; tests
  // inject a fake that returns a scripted SSE body without a real socket.
  fetch?: VicoopCodexFetchFn;
  // Max time `ensureServe` waits for the spawned `vicoop-codex serve` to
  // print its `listening` line before giving up. Default 10s.
  serveStartupTimeoutMs?: number;
  // Max time the startup probe (`vicoop-codex models --json` via
  // `resolveCapabilities`) waits for the model list before giving up.
  // Setting to 0 disables the probe entirely — the agent card carries no
  // declared models and `envelope.model` validation is skipped. Default
  // 10s mirrors claude's probeTimeoutMs.
  probeTimeoutMs?: number;
  logger?: Logger;
  // Test seam for the per-task timing recorder's clock. Production uses
  // `Date.now`; tests inject a deterministic counter to assert the emitted
  // `[client] timing …` milestones.
  now?: () => number;
  // Idle-silence liveness heartbeat — same semantics as `codex` / `claude`.
  // While a task is in-flight and no other frame has gone out for
  // `heartbeatMs`, emit a tagged `working` `task.status` so the gateway /
  // router sees bytes on the wire and re-arms its stall watchdog. This is the
  // exact backend from the production false-failover incident
  // (planetarium/a2x-internal-router#95), so it MUST heartbeat. Defaults to the
  // shared `HEARTBEAT_INTERVAL_MS` (10s); `0` disables it (used by tests that
  // don't drive the timer). `setIntervalFn` / `clearIntervalFn` are test seams.
  heartbeatMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  // When true, dump A2A `parts` shape + metadata keys + raw
  // `chat_history` to stderr on every task. Operator diagnostic exposed
  // via `--openai-compat-trace`. Leave off in production.
  openaiCompatTrace?: boolean;
  // Forward vicoop-codex's reasoning summary as a live `reasoning` channel: an
  // additive `openai-compat/v1` wire marker (a reasoning-channel artifact with
  // `metadata[ext-uri] = { channel: 'reasoning' }`) that the oai2a2a codec maps
  // to `delta.reasoning_content` so the a2x-internal-router stops
  // false-failing-over long silent reasoning turns
  // (planetarium/a2x-internal-router#95, vicoop-bridge#375).
  //
  // ON by default; set `false` (CLI `--no-vicoop-codex-reasoning` / config
  // `backends['vicoop-codex'].reasoning: false`) to disable. Disable when the
  // deployed oai2a2a codec predates 0.6.0 — an old codec doesn't understand the
  // `reasoning` channel marker and would fold the reasoning artifact into the
  // answer (the #95 rollout-order hazard).
  //
  // Unlike claude there is NO thinking-enablement injection here: `vicoop-codex
  // serve` emits `delta.reasoning_content` on the wire serve-side (via
  // `summary:"auto"`, already shipped), so this is purely forwarding + the flag.
  reasoning?: boolean;
}

// `vicoop-codex call` body shape — only the fields this backend actually
// emits. The openai-compat A2A extension envelope (oai2a2a#80) carries a
// full OpenAI Chat Completions request body; the bridge forwards `model`
// (so the gateway-resolved model id reaches the CLI rather than the CLI's
// own DEFAULT_MODEL), the assembled `messages[]` (envelope's system +
// prior turns + the trailing user content flattened from A2A parts),
// `tools`, and `tool_choice`. Everything else (reasoning_effort,
// parallel_tool_calls, the Group B / Group C parameters from the call
// command's input doc) is intentionally not on this shape because no
// input surface we currently read carries them. The binary applies its
// own defaults.
export interface VicoopCodexCallBody {
  model?: string;
  messages: ChatCompletionMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  // Cache-routing key forwarded verbatim to `vicoop-codex serve`, which
  // passes it upstream as the Responses API `prompt_cache_key`
  // (vicoop-codex-cli#12). It pins the same conversation's successive turns
  // to one ChatGPT-codex-backend cache shard so the prompt cache actually
  // hits across turns instead of scattering — without it a genuine
  // multi-turn A2A conversation records `cached_tokens: 0` on every
  // follow-up turn (#11).
  prompt_cache_key?: string;
}

export interface ChatCompletionMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  // OpenAI permits string or content-parts. We emit a string for system /
  // developer / user / tool messages and `null` for assistant tool-call-only
  // messages, mirroring the doc's worked examples.
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

// OpenAI Chat Completions response shape. The backend no longer parses this
// off `vicoop-codex call` stdout — it synthesises one (`synthesizeStreamedResponse`)
// from the `chat.completion.chunk` SSE deltas streamed by `vicoop-codex serve`
// so the existing envelope builders below can be reused unchanged. All fields
// optional / nullable so a future schema bump degrades rather than crashes.
export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
}

function serializeDataPart(data: Record<string, unknown>): string {
  let body: string;
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    return '';
  }
  return `<context kind="application/json">\n${body}\n</context>`;
}

// Extract the user turn from A2A `Message.parts`. The vicoop-codex `call`
// command's `messages[].content` is string-or-multimodal-parts, but the
// binary only consumes text parts (image / audio are dropped per the doc's
// "Known limitations" section); we therefore flatten everything to a single
// string here. DataParts are folded in as `<context>`-tagged JSON so the
// model sees them as auxiliary structured input — same convention the
// codex / claude backends already use.
//
// Returns null when the message carries no text and no data, signalling the
// caller to fail the task with `empty_prompt` rather than send an empty
// user message upstream (which the binary would reject as
// `'messages' is required and must be a non-empty array`).
export function flattenA2AUserContent(parts: readonly Part[]): string | null {
  const sections: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      if (p.text) sections.push(p.text);
      continue;
    }
    if (p.kind === 'data') {
      const serialized = serializeDataPart(p.data);
      if (serialized) sections.push(serialized);
      continue;
    }
    // FilePart: deliberately dropped. The doc states images/audio are not
    // forwarded; surfacing a partial picture would be worse than a clear
    // "this backend is text-only" contract on the artifact side. Operators
    // that need vision/audio should use the `codex` or `claude` backends.
  }
  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

// Render `chat_history` entries as OpenAI Chat Completions messages
// one-for-one — this backend speaks Chat Completions natively, so the
// mapping is the identity:
//   - role:"user"                       → user message (content string)
//   - role:"assistant" (plain text)     → assistant message with the text content
//   - role:"assistant" (text + tool_calls) → assistant message with BOTH the text
//                                            content AND the tool_calls array
//                                            (OpenAI Chat Completions allows the
//                                            hybrid shape)
//   - role:"assistant" (no text + tool_calls) → assistant message with
//                                                content:null + tool_calls
//   - role:"tool"                        → tool message with tool_call_id +
//                                          (optional) name + content
export function historyToChatCompletionMessages(
  history: OpenAICompatHistoryEntry[],
): ChatCompletionMessage[] {
  const out: ChatCompletionMessage[] = [];
  for (const entry of history) {
    if (entry.role === 'user') {
      out.push({
        role: 'user',
        content: openAIMessageContentToString(entry.content),
      });
      continue;
    }
    if (entry.role === 'assistant') {
      if ('tool_calls' in entry) {
        out.push({
          role: 'assistant',
          content:
            entry.content === null
              ? null
              : openAIMessageContentToString(entry.content),
          tool_calls: entry.tool_calls,
        });
        continue;
      }
      out.push({
        role: 'assistant',
        content: openAIMessageContentToString(entry.content),
      });
      continue;
    }
    const tool: ChatCompletionMessage = {
      role: 'tool',
      tool_call_id: entry.tool_call_id,
      content: entry.content,
    };
    if (entry.name) tool.name = entry.name;
    out.push(tool);
  }
  return out;
}

// vicoop-codex's `call` binary accepts string-or-multimodal-parts on
// `messages[].content` but the binary's "Known limitations" section
// states only text is forwarded — image / audio parts are silently
// dropped. Flatten multimodal arrays to plain text here so the
// downstream binary sees the shape it actually consumes.
function openAIMessageContentToString(
  content: OpenAICompatMessageContent,
): string {
  if (typeof content === 'string') return content;
  const sections: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) sections.push(text);
    }
    // image_url / unknown content-part types: dropped, mirroring the
    // backend's documented text-only limitation.
  }
  return sections.join('\n\n');
}

// Assemble the full `messages` array for the call body. Order, per the
// doc's "Per-role message JSON examples" section:
//   1. system (concatenated from envelope's `messages[]` system/developer
//      entries; one entry)
//   2. chat_history entries (prior user / assistant text turns + tool
//      round-trips, derived from envelope's `messages[]` minus the
//      trailing user) mapped 1:1 to OpenAI Chat Completions messages
//   3. current user turn (flattened from A2A parts)
//
// The user turn comes last so the model sees prior context before the
// new instruction. When `userContent` is null (tool-continuation edge
// case: A2A parts is the placeholder `[{text:""}]`), the trailing user
// is omitted — the chat_history's last entry is the tool result the
// model should respond to.
export function buildMessages(
  system: string | undefined,
  chatHistory: OpenAICompatHistoryEntry[] | null,
  userContent: string | null,
): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  if (chatHistory) {
    for (const m of historyToChatCompletionMessages(chatHistory)) {
      messages.push(m);
    }
  }
  if (userContent !== null) {
    messages.push({ role: 'user', content: userContent });
  }
  return messages;
}

// Assemble the call body from the openai-compat envelope. Forwards:
//   - `model`: the gateway-resolved model id so the CLI dispatches to the
//     caller's selection rather than the binary's DEFAULT_MODEL (#302).
//   - `tools` / `tool_choice`: verbatim off the envelope.
//   - `messages`: the pre-assembled array (system + chat_history + current
//     user turn).
//
// Besides those, a `prompt_cache_key` is attached for prompt-cache stickiness
// (see below). `reasoning_effort`, `parallel_tool_calls`, and every Group B /
// Group C parameter from the call command's input doc are left unset — the
// vicoop-codex binary applies its own defaults.
//
// `fallbackCacheKey` is the bridge's per-conversation id (`task.contextId`).
// The resolved `prompt_cache_key` is: an explicit caller-supplied key if
// present, else the fallback. Routing the same conversation's turns through
// one key is what makes the upstream prompt cache hit across turns (#11 /
// vicoop-codex-cli#12); a caller that already manages its own key wins so we
// don't override their grouping.
//
// The caller key is read from BOTH `prompt_cache_key` (the OpenAI wire name)
// and `promptCacheKey` (the camelCase form the Vercel AI SDK / opencode emit
// as a raw body field on openai-compatible providers — see opencode #4386).
// The gateway forwards the request body verbatim, so whichever spelling the
// client used rides through unchanged; we normalise to the snake_case
// `prompt_cache_key` that `vicoop-codex serve` actually reads. Snake_case wins
// when somehow both are present.
export function buildCallBody(
  envelope: OpenAICompatRequestEnvelope | null,
  messages: ChatCompletionMessage[],
  fallbackCacheKey?: string,
): VicoopCodexCallBody {
  const body: VicoopCodexCallBody = { messages };
  if (envelope) {
    if (typeof envelope.model === 'string' && envelope.model.length > 0) {
      body.model = envelope.model;
    }
    if (Array.isArray(envelope.tools) && envelope.tools.length > 0) {
      body.tools = envelope.tools;
    }
    if (envelope.tool_choice !== undefined && envelope.tool_choice !== null) {
      body.tool_choice = envelope.tool_choice;
    }
  }
  const asKey = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const callerCacheKey = envelope
    ? asKey(envelope.prompt_cache_key) ?? asKey(envelope.promptCacheKey)
    : undefined;
  const cacheKey = callerCacheKey ?? asKey(fallbackCacheKey);
  if (cacheKey) body.prompt_cache_key = cacheKey;
  return body;
}

// Convert the parsed `usage` block to a spec-compliant OpenAICompatUsage.
// vicoop-codex prints the standard OpenAI shape so the mapping is direct;
// total_tokens is recomputed by `buildOpenAICompatUsage` to enforce the
// `total === prompt + completion` invariant regardless of what the binary
// reported.
export function parseChatCompletionUsage(
  raw: ChatCompletionResponse['usage'],
  model: string | undefined,
): OpenAICompatUsage | null {
  if (!raw) return null;
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : null;
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : null;
  if (prompt === null || completion === null) return null;
  const cached =
    typeof raw.prompt_tokens_details?.cached_tokens === 'number'
      ? raw.prompt_tokens_details.cached_tokens
      : undefined;
  const reasoning =
    typeof raw.completion_tokens_details?.reasoning_tokens === 'number'
      ? raw.completion_tokens_details.reasoning_tokens
      : undefined;
  return buildOpenAICompatUsage({
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
    model,
  });
}

// Assemble the OpenAI ChatCompletion envelope placed under
// `metadata[OPENAI_COMPAT_EXTENSION_URI].chat_completion` on the terminal
// A2A message, per the openai-compat/v1 envelope contract (oai2a2a#80).
// The codec on the gateway unwraps this verbatim, so we own every required
// field — id / object / created / model / choices[*]{message, finish_reason,
// logprobs} / usage.
//
// `vicoop-codex call` already prints a near-complete OpenAI ChatCompletion
// envelope on stdout (see vicoop-codex-cli/src/translate/chat-completions.ts
// `buildChatCompletion`), so we mostly forward it verbatim. We:
//   - Synthesize defensive defaults for id / object / created / model when
//     upstream omits them (the spec REQUIREs them; advertising agents
//     SHOULD always provide them but a wrapper bug shouldn't break clients).
//   - Inject `logprobs: null` on each choice when upstream didn't surface
//     them — the spec marks logprobs as required on each choice (defaults
//     to null) and the upstream binary does not emit them.
//   - Put the normalized `OpenAICompatUsage` (with the spec-mandated
//     `total === prompt + completion` invariant) in `chat_completion.usage`
//     rather than the raw upstream usage.
//
// Spec: extensions/openai-compat/v1/README.md#response-metadata-payload-agent--gateway
export function buildChatCompletionEnvelope(
  response: ChatCompletionResponse,
  usage: OpenAICompatUsage | null,
  taskId: string,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    id: typeof response.id === 'string' && response.id.length > 0
      ? response.id
      : `chatcmpl-vicoop-codex-${taskId}`,
    object: typeof response.object === 'string' && response.object.length > 0
      ? response.object
      : 'chat.completion',
    created: typeof response.created === 'number'
      ? response.created
      : Math.floor(Date.now() / 1000),
    model: typeof response.model === 'string' && response.model.length > 0
      ? response.model
      : 'vicoop-codex',
    choices: Array.isArray(response.choices) && response.choices.length > 0
      ? response.choices.map((c) => {
          // Spread upstream verbatim and only add `logprobs: null` when the
          // upstream binary didn't emit it (which is the common case today).
          // Preserves any future fields codex may add (`message.refusal`,
          // etc.) without a spec or codec change.
          if (c && typeof c === 'object' && !('logprobs' in c)) {
            return { ...c, logprobs: null };
          }
          return c;
        })
      : [],
  };
  if (usage) envelope.usage = usage;
  return envelope;
}

// Build the metadata payload spread onto the final A2A message under
// `OPENAI_COMPAT_EXTENSION_URI`. Carries the chat_completion envelope per
// the envelope contract (oai2a2a#80); usage lives inside
// `chat_completion.usage`. `usage` is also passed through so the shared
// builder can fall back to a bare `{ usage }` payload on the plain-task
// path (envelope absent) — vicoop-codex never hits that path in practice
// because every turn synthesises an envelope.
export function buildResponseMetadata(
  response: ChatCompletionResponse,
  usage: OpenAICompatUsage | null,
  taskId: string,
): Record<string, unknown> {
  const envelope = buildChatCompletionEnvelope(response, usage, taskId);
  // `buildOpenAICompatResponseMetadata` returns `undefined` only when the
  // envelope is absent — for vicoop-codex we always synthesise an envelope
  // so the non-undefined branch is guaranteed. Coerce here to keep the
  // call-site type narrow.
  return buildOpenAICompatResponseMetadata(envelope, usage) ?? {
    [OPENAI_COMPAT_EXTENSION_URI]: { chat_completion: envelope },
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: VicoopCodexSpawnOptions,
): VicoopCodexChildHandle {
  // On Windows npm installs the `vicoop-codex` bin as a `.cmd` shim; bare
  // `spawn('vicoop-codex', …)` without `shell:true` doesn't pick up the
  // extension and fails with ENOENT. Route through the shell on win32 so
  // the shim resolves. Safe here because `command` and `args` are fully
  // determined by this module — no user-supplied tokens enter the argv.
  return nodeSpawn(command, Array.from(args), {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }) as ChildProcess;
}

// Default streaming transport: wrap the global `fetch` into the slim
// `VicoopCodexStreamResponse` the backend consumes. The SSE body is exposed
// as an async iterable of decoded UTF-8 string chunks read off the response's
// `ReadableStream`.
async function defaultFetch(
  url: string,
  init: { body: string; signal: AbortSignal },
): Promise<VicoopCodexStreamResponse> {
  const reqInit: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: init.body,
    signal: init.signal,
  };
  // Disable Bun's native fetch idle timeout (~255s) for the request to the
  // local `vicoop-codex serve`. A legitimately slow upstream (long reasoning /
  // slow first byte) can take minutes before serve emits its first SSE bytes —
  // observed first-byte latencies up to ~440s — and Bun would otherwise abort
  // at ~255s with "The operation timed out.", failing the task even though
  // serve's own 9-min upstream deadline has NOT fired and the request would
  // succeed. The request stays bounded by `init.signal` (the task abort) and by
  // serve's upstream deadline, so this never hangs unbounded. `timeout` is a Bun
  // extension to the DOM `RequestInit` type (Node's fetch ignores it), matching
  // vicoop-codex's own `postUpstream`; hence the cast.
  (reqInit as { timeout?: boolean }).timeout = false;
  const res = await fetch(url, reqInit);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    async *chunks() {
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// A live `vicoop-codex serve` instance: the child process plus the base URL
// (`http://127.0.0.1:<port>`) parsed from its `listening` line.
interface ServeHandle {
  child: VicoopCodexChildHandle;
  baseUrl: string;
}

// `vicoop-codex serve` prints a single JSON line on stdout when the HTTP
// server is up, e.g.
//   {"event":"listening","host":"127.0.0.1","port":8787,"url":"http://127.0.0.1:8787"}
// followed by human-readable text lines. Parse the JSON line to recover the
// base URL; ignore everything else. Returns null for non-JSON / non-listening
// lines so the caller keeps scanning.
export function parseServeListeningUrl(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.event !== 'listening') return null;
  if (typeof o.url === 'string' && o.url.length > 0) return o.url.replace(/\/$/, '');
  if (typeof o.host === 'string' && typeof o.port === 'number') {
    return `http://${o.host}:${o.port}`;
  }
  return null;
}

// A typed error carrying the A2A `task.fail` code the streaming layer wants
// the handler to surface, so HTTP/transport failures map cleanly without the
// handler re-inspecting error shapes.
class ServeRequestError extends Error {
  constructor(
    readonly a2aCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServeRequestError';
  }
}

// One `chat.completion.chunk` SSE frame. Only the fields the accumulator
// reads — everything optional / nullable per OpenAI's streaming schema.
interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      // Reasoning summary streamed by `vicoop-codex serve` (`summary:"auto"`,
      // vicoop-codex-cli). Forwarded as a `reasoning`-channel artifact, never
      // folded into `acc.content` — reasoning must stay out of the answer.
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatCompletionResponse['usage'];
  // In-band error frame. `vicoop-codex serve` relays an upstream `/responses`
  // error (e.g. "input exceeds the context window") as `{"error":{...}}` on an
  // otherwise-200 SSE stream. It carries no `choices`, so without explicit
  // handling the accumulator drops it and the turn synthesizes an empty
  // `finish_reason:"stop"` completion — a silent empty answer.
  error?: { message?: string; type?: string; code?: string | null } | null;
}

// Per-index tool-call assembly buffer. OpenAI streams a tool call's
// `function.arguments` as a sequence of string fragments across chunks, so we
// concatenate; `id` / `type` / `name` arrive on the first fragment for that
// index but we tolerate them landing on any.
interface ToolCallBuffer {
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
}

// Running fold over the SSE stream — assembled into a `ChatCompletionResponse`
// by `synthesizeStreamedResponse` once the stream ends.
interface StreamAccumulator {
  id?: string;
  model?: string;
  created?: number;
  content: string;
  toolCalls: Map<number, ToolCallBuffer>;
  finishReason?: string;
  usage?: ChatCompletionResponse['usage'];
}

function applyChunk(
  acc: StreamAccumulator,
  chunk: ChatCompletionChunk,
  onContentDelta: (text: string) => void,
  onReasoningDelta: (text: string) => void,
): void {
  if (typeof chunk.id === 'string' && chunk.id.length > 0) acc.id = chunk.id;
  if (typeof chunk.model === 'string' && chunk.model.length > 0) acc.model = chunk.model;
  if (typeof chunk.created === 'number') acc.created = chunk.created;
  if (chunk.usage) acc.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (typeof choice.finish_reason === 'string') acc.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (!delta) return;
  // Reasoning summary fragment — surfaced on the dedicated `reasoning` channel
  // by the caller. Deliberately NOT appended to `acc.content`: reasoning must
  // never co-mingle with the answer artifact / synthesised response text.
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    onReasoningDelta(delta.reasoning_content);
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    acc.content += delta.content;
    onContentDelta(delta.content);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === 'number' ? tc.index : 0;
      let cur = acc.toolCalls.get(idx);
      if (!cur) {
        cur = { arguments: '' };
        acc.toolCalls.set(idx, cur);
      }
      if (typeof tc.id === 'string') cur.id = tc.id;
      if (typeof tc.type === 'string') cur.type = tc.type;
      if (tc.function) {
        if (typeof tc.function.name === 'string') cur.name = tc.function.name;
        if (typeof tc.function.arguments === 'string') cur.arguments += tc.function.arguments;
      }
    }
  }
}

// Fold the accumulated SSE state into the non-streaming `ChatCompletionResponse`
// shape the existing envelope builders consume. Mirrors the OpenAI contract:
// a tool-call turn carries `content:null` + `tool_calls`, a text turn carries
// the assembled content.
function synthesizeStreamedResponse(acc: StreamAccumulator): ChatCompletionResponse {
  const toolCalls = [...acc.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id,
      type: t.type ?? 'function',
      function: { name: t.name, arguments: t.arguments },
    }));
  const hasToolCalls = toolCalls.length > 0;
  return {
    id: acc.id,
    object: 'chat.completion',
    created: acc.created,
    model: acc.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: hasToolCalls ? null : acc.content,
          ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: acc.finishReason ?? (hasToolCalls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: acc.usage,
  };
}

// POST the Chat Completions request (with `stream:true`) to `vicoop-codex
// serve` and fold the `chat.completion.chunk` SSE stream into a single
// `ChatCompletionResponse`. `onContentDelta` fires for each incremental text
// fragment so the caller can emit `append:true` artifacts. `onReasoningDelta`
// fires for each incremental `reasoning_content` fragment so the caller can
// emit them on the separate `reasoning` channel. `onFirstByte` fires once when
// the upstream HTTP response resolves OK (before any chunk), letting the caller
// split connection/model-wait from streaming time. Throws `ServeRequestError`
// (with an A2A code) on HTTP / transport failure; the caller maps abort
// separately via `signal.aborted`.
async function streamChatCompletions(
  fetchFn: VicoopCodexFetchFn,
  url: string,
  body: string,
  signal: AbortSignal,
  onContentDelta: (text: string) => void,
  onReasoningDelta: (text: string) => void,
  onFirstByte?: () => void,
): Promise<ChatCompletionResponse> {
  let res: VicoopCodexStreamResponse;
  try {
    res = await fetchFn(url, { body, signal });
  } catch (err) {
    throw new ServeRequestError(
      'network_error',
      `vicoop-codex serve request failed: ${errorMessage(err)}`,
    );
  }
  if (res.ok) onFirstByte?.();
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).trim().slice(0, 512);
    } catch {
      // best-effort — diagnostics only
    }
    throw new ServeRequestError(
      'upstream_error',
      `vicoop-codex serve returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  const acc: StreamAccumulator = { content: '', toolCalls: new Map() };
  // Set when an in-band `{"error":{...}}` frame is seen. Thrown after the read
  // loop (NOT from inside `consume`, whose throws are caught and re-wrapped as
  // a generic "stream interrupted" transport error below — that would mask the
  // upstream message and a2a code).
  let streamError: ServeRequestError | null = null;
  // Process one `data:` payload; returns true when the stream should stop —
  // the `[DONE]` sentinel or a terminal error frame.
  const consume = (data: string): boolean => {
    if (data === '[DONE]') return true;
    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      // Defensive: OpenAI guarantees valid JSON per data line, but a stray
      // keep-alive / comment shouldn't abort the turn — skip it.
      return false;
    }
    // In-band error frame (200 stream): surface it as a task failure carrying
    // the upstream message instead of dropping it and completing empty. This is
    // the path the oversized-context "input exceeds the context window" error
    // takes — serve relays it here, and it has no `choices` for applyChunk.
    if (chunk.error && typeof chunk.error === 'object') {
      const msg =
        typeof chunk.error.message === 'string' && chunk.error.message.length > 0
          ? chunk.error.message
          : 'vicoop-codex serve reported an upstream error with no message';
      streamError = new ServeRequestError('upstream_error', `vicoop-codex serve stream error: ${msg}`);
      return true; // terminal — stop reading
    }
    applyChunk(acc, chunk, onContentDelta, onReasoningDelta);
    return false;
  };

  let buf = '';
  try {
    let done = false;
    for await (const piece of res.chunks()) {
      buf += piece;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // blank lines, `event:`, comments
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        if (consume(data)) {
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if (!done) {
      // Flush a trailing `data:` payload that arrived without a final newline.
      const tail = buf.replace(/\r$/, '');
      if (tail.startsWith('data:')) {
        const data = tail.slice(5).trim();
        if (data.length > 0) consume(data);
      }
    }
  } catch (err) {
    // Surface as a transport error; the handler prioritises `signal.aborted`
    // (→ canceled) over this mapping when the abort caused the interruption.
    throw new ServeRequestError(
      'network_error',
      `vicoop-codex serve stream interrupted: ${errorMessage(err)}`,
    );
  }

  // A terminal error frame outranks whatever (empty) content accumulated —
  // thrown here, outside the transport catch, so its message and a2a code
  // survive to the handler's `task.fail` instead of a silent empty completion.
  if (streamError) throw streamError;

  return synthesizeStreamedResponse(acc);
}

// Probe the vicoop-codex CLI's `models --json` subcommand to discover the
// model ids this account / install advertises. Returns null on any failure
// (binary missing, timeout, non-JSON stdout, unexpected shape) so the
// caller can skip the advertise / `envelope.model` gate silently. Mirrors
// `probeClaudeModel`'s "best-effort, fail-open" contract.
// A model advertised by `vicoop-codex models --json`, reduced to the fields the
// bridge mirrors onto the openai-compat/v1 advertise. `contextWindow` is the
// effective window in tokens (null when the CLI doesn't report one — e.g. a
// vicoop-codex predating the field). vicoop-codex exposes no output-token
// ceiling, so `maxOutputTokens` is never advertised for this backend.
export interface VicoopCodexModel {
  id: string;
  contextWindow: number | null;
}

export async function probeVicoopCodexModels(args: {
  command: string;
  spawn: VicoopCodexSpawnFn;
  cwd?: string;
  timeoutMs: number;
}): Promise<VicoopCodexModel[] | null> {
  if (args.timeoutMs <= 0) return null;
  let child: VicoopCodexChildHandle;
  try {
    child = args.spawn(args.command, ['models', '--json'], { cwd: args.cwd });
  } catch {
    return null;
  }
  return await new Promise<VicoopCodexModel[] | null>((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: VicoopCodexModel[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), args.timeoutMs);
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
    }
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { models?: unknown };
        if (!Array.isArray(parsed.models)) {
          finish(null);
          return;
        }
        const models: VicoopCodexModel[] = [];
        for (const m of parsed.models) {
          if (!m || typeof m !== 'object') continue;
          const raw = m as { id?: unknown; context_window?: unknown };
          const id = typeof raw.id === 'string' ? raw.id : '';
          if (id.length === 0) continue;
          // Positive-integer guard: a missing / zero / negative / fractional
          // context_window degrades to null (no hint) rather than a bogus value.
          const cw = raw.context_window;
          const contextWindow =
            typeof cw === 'number' && Number.isInteger(cw) && cw > 0 ? cw : null;
          models.push({ id, contextWindow });
        }
        finish(models.length > 0 ? models : null);
      } catch {
        finish(null);
      }
    });
  });
}

export function createVicoopCodexBackend(
  opts: VicoopCodexBackendOptions = {},
): Backend {
  const command = opts.command ?? 'vicoop-codex';
  // `vicoop-codex serve -p 0` binds an ephemeral loopback port and prints its
  // URL on stdout (`parseServeListeningUrl`). One server is spawned lazily and
  // shared across every task (mirrors codex's `app-server` singleton).
  const serveArgs: readonly string[] = [
    'serve',
    '-p',
    '0',
    '-H',
    '127.0.0.1',
    ...(opts.extraArgs ?? []),
  ];
  const cwd = opts.cwd;
  const spawnFn = opts.spawn ?? defaultSpawn;
  const fetchFn = opts.fetch ?? defaultFetch;
  const stderrCap = opts.stderrCaptureBytes ?? 16 * 1024;
  const serveStartupTimeoutMs = opts.serveStartupTimeoutMs ?? 10_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
  const logger = opts.logger ?? createLogger();
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const setIntervalImpl =
    opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    opts.clearIntervalFn ??
    ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const openaiCompatTrace = opts.openaiCompatTrace === true;
  // openai-compat/v1 reasoning channel (#95 / #375). ON by default; disable via
  // `reasoning: false` (CLI `--no-vicoop-codex-reasoning` / config) when the
  // deployed codec predates 0.6.0 and can't yet understand the marker.
  const reasoningEnabled = opts.reasoning !== false;

  // Supported-models cache, populated by `resolveCapabilities` at daemon
  // startup and read sync from `handle()` to gate `envelope.model`
  // forwarding (#302). Mirrors claude's pattern — `undefined` = "never
  // probed", `null` = "probed but unavailable", non-empty `Set` = the
  // model ids the CLI's `models --json` advertised.
  let cachedSupportedModels: Set<string> | null | undefined = undefined;

  // Lazy `vicoop-codex serve` singleton + in-flight startup dedup. `serve`
  // holds the live server; `servePending` coalesces concurrent first-task
  // starts so we never spawn two servers. Both clear when the child dies so
  // the next task respawns.
  let serve: ServeHandle | null = null;
  let servePending: Promise<ServeHandle> | null = null;

  function startServe(): Promise<ServeHandle> {
    return new Promise<ServeHandle>((resolve, reject) => {
      let child: VicoopCodexChildHandle;
      try {
        child = spawnFn(command, serveArgs, { cwd });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
        return;
      }

      // `vicoop-codex serve` prints its `listening` JSON line — and all other
      // human-readable startup text — to STDERR, not stdout. We scan both
      // streams for the line (robust to a future change) and separately keep a
      // capped stderr buffer for the exit-before-listening diagnostic.
      let outBuf = '';
      let errBuf = '';
      let stderrDiag = '';
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const clearSingletonFor = (): void => {
        if (serve?.child === child) serve = null;
      };

      const scanForListening = (buf: string): { url: string | null; rest: string } => {
        let nl: number;
        let rest = buf;
        while ((nl = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          const url = parseServeListeningUrl(line);
          if (url) return { url, rest };
        }
        return { url: null, rest };
      };

      const onLine = (url: string | null): void => {
        if (settled || !url) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ child, baseUrl: url });
      };

      child.on('close', (code) => {
        clearSingletonFor();
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const head = stderrDiag.trim().slice(0, 512);
        reject(
          new Error(
            `vicoop-codex serve exited (code ${code}) before reporting listening` +
              (head ? `: ${head}` : ''),
          ),
        );
      });
      child.on('error', (err) => {
        clearSingletonFor();
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          outBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          const { url, rest } = scanForListening(outBuf);
          outBuf = rest;
          onLine(url);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer | string) => {
          const piece = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (stderrDiag.length < stderrCap) {
            stderrDiag += piece.slice(0, stderrCap - stderrDiag.length);
          }
          if (settled) return;
          errBuf += piece;
          const { url, rest } = scanForListening(errBuf);
          errBuf = rest;
          onLine(url);
        });
      }

      if (serveStartupTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // best-effort
          }
          reject(
            new Error(
              `vicoop-codex serve did not report listening within ${serveStartupTimeoutMs}ms`,
            ),
          );
        }, serveStartupTimeoutMs);
      }
    });
  }

  async function ensureServe(): Promise<ServeHandle> {
    if (serve) return serve;
    if (servePending) return servePending;
    servePending = startServe().then(
      (h) => {
        serve = h;
        servePending = null;
        return h;
      },
      (err) => {
        servePending = null;
        throw err;
      },
    );
    return servePending;
  }

  return {
    name: 'vicoop-codex',

    stop() {
      if (serve) {
        try {
          serve.child.kill('SIGTERM');
        } catch {
          // best-effort
        }
        serve = null;
      }
    },

    // Per-account Codex usage, served on demand for the bridge's usage API.
    // Reuses the shared `serve` singleton and hits its read-only GET /usage
    // (which does not consume quota), then normalises it into the canonical
    // BridgeUsage shape (the raw payload is preserved under `raw`).
    async usage(): Promise<BridgeUsage> {
      const handle = await ensureServe();
      const res = await fetch(`${handle.baseUrl}/usage`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `vicoop-codex serve /usage returned HTTP ${res.status}` +
            (detail ? `: ${detail.slice(0, 300)}` : ''),
        );
      }
      return normalizeCodexServeUsage(
        await res.json(),
        new Date().toISOString(),
        Date.now(),
      );
    },

    async resolveCapabilities() {
      const models = await probeVicoopCodexModels({
        command,
        spawn: spawnFn,
        cwd,
        timeoutMs: probeTimeoutMs,
      });
      if (!models || models.length === 0) {
        cachedSupportedModels = null;
        return {};
      }
      cachedSupportedModels = new Set(models.map((m) => m.id));
      // Advertise on the openai-compat/v1 `params.models[]` slot so
      // upstream A2A callers (and the gateway's model resolver) can see
      // the list without round-tripping through `vicoop-codex models`.
      // The first id is tagged as default — vicoop-codex's `models`
      // output is already ordered with the recommended model first.
      // `contextWindow` (when the CLI reports it) rides along as the
      // openai-compat/v1 hint; vicoop-codex has no output-token ceiling.
      const openaiCompatModels = models.map((m, i) =>
        i === 0
          ? {
              id: m.id,
              default: true as const,
              ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
            }
          : {
              id: m.id,
              ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
            },
      );
      return { openaiCompatModels };
    },

    async handle(task, rawEmit, signal) {
      // Per-task timing breadcrumb. Stamps milestones (serve readiness, first
      // upstream byte, first streamed delta) relative to handle entry and
      // emits one `[client] timing backend=vicoop-codex …` line at the
      // terminal frame — gated to `debug`, so operators opt in via
      // `VICOOP_CLIENT_LOG_LEVEL=debug` when diagnosing slow turns. The split
      // (firstByte → firstDelta ≈ model wait; total − firstDelta ≈ streaming)
      // is the only thing that distinguishes a long-but-healthy turn from a
      // stall, since this backend is a thin pass-through with no per-turn log.
      const recorder = createTimingRecorder({
        logger,
        backend: 'vicoop-codex',
        taskId: task.taskId,
        contextId: task.contextId,
        now,
      });
      // Timestamp of the last outbound frame, refreshed by the wrapped `emit`.
      // The shared liveness heartbeat reads it each tick so real traffic OR a
      // prior heartbeat resets the silence window. `settled` flips once a
      // terminal frame goes out so the heartbeat stops emitting `working`.
      let lastEmitAt = now();
      let settled = false;
      const emit: typeof rawEmit = (frame) => {
        lastEmitAt = now();
        const terminal = frame.type === 'task.complete' || frame.type === 'task.fail';
        if (terminal) {
          settled = true;
          recorder.mark('emit');
        }
        rawEmit(frame);
        if (terminal) {
          const state =
            frame.type === 'task.fail' ? 'failed' : frame.status?.state ?? 'completed';
          const code = frame.type === 'task.fail' ? frame.error?.code : undefined;
          recorder.finish({ state, code });
        }
      };

      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      // Envelope-direct (#302): read the full inbound OpenAI Chat Completions
      // request body off `metadata[URI].chat_completions_request` and drive
      // the call body from the envelope's fields (`model`, `messages[]`,
      // `tools`, `tool_choice`) instead of the legacy decomposed view.
      const envelope = parseOpenAICompatEnvelope(task.message.metadata);
      if (openaiCompatTrace) {
        dumpOpenAICompatTaskWire(
          'vicoop-codex',
          task.taskId,
          task.message.parts,
          task.message.metadata,
        );
      }

      const system = envelope ? collectSystemFromMessages(envelope.messages) : undefined;
      const chatHistory =
        envelope && Array.isArray(envelope.messages)
          ? chatHistoryFromMessages(envelope.messages)
          : null;

      const userContent = flattenA2AUserContent(task.message.parts);
      // Tool-continuation edge case (openai-compat spec): A2A parts is the
      // placeholder `[{text:""}]` and the conversation lives in
      // chat_history. Skip the empty_prompt check when chat_history will
      // supply the user-side content via the prior-turns sequence.
      const hasHistory = (chatHistory?.length ?? 0) > 0;
      if (userContent === null && !hasHistory) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'empty_prompt',
            message: 'vicoop-codex backend received no text or data content in the user message',
          },
        });
        return;
      }

      // Validate envelope.model against the cache populated by
      // `resolveCapabilities`. When the gateway sends a value this
      // vicoop-codex install does not advertise (e.g. an unresolved routing
      // key like `a2a/<card-url>`), drop the override so the CLI falls
      // back to its DEFAULT_MODEL rather than failing the call with an
      // upstream "model not found" error (#302). When the cache is
      // unpopulated (probeTimeoutMs ≤ 0, probe failed, or
      // `resolveCapabilities` hasn't been called yet) the validation is
      // skipped and `envelope.model` rides through unchanged.
      let effectiveEnvelope = envelope;
      if (
        envelope &&
        typeof envelope.model === 'string' &&
        envelope.model.length > 0 &&
        cachedSupportedModels instanceof Set &&
        !cachedSupportedModels.has(envelope.model)
      ) {
        logger.warn?.(
          `[vicoop-codex] envelope.model=${JSON.stringify(envelope.model)} is not in this account's advertised models list; falling back to vicoop-codex default`,
        );
        const { model: _droppedModel, ...rest } = envelope;
        effectiveEnvelope = rest as OpenAICompatRequestEnvelope;
      }

      const messages = buildMessages(system, chatHistory, userContent);
      // Pass `task.contextId` as the prompt-cache fallback key so successive
      // turns of one A2A conversation stay sticky to the same upstream cache
      // shard (#11). A caller-supplied `envelope.prompt_cache_key` still wins.
      const body = buildCallBody(effectiveEnvelope, messages, task.contextId);
      let serialized: string;
      try {
        // `stream:true` switches `vicoop-codex serve`'s `/v1/chat/completions`
        // into the `chat.completion.chunk` SSE mode we fold in
        // `streamChatCompletions`.
        //
        // `stream_options.include_usage:true` makes the terminal usage chunk
        // contractual. Per the OpenAI streaming contract `usage` is only
        // guaranteed in the stream when this flag is set — without it
        // `vicoop-codex serve` is free to omit usage on a given turn, which
        // surfaces downstream as a silently $0-billed 0-token call (#317).
        // We fold whichever chunk carries `usage` (piggybacked on the
        // finish_reason frame or a trailing `choices:[]` frame) into
        // `acc.usage`, so requesting it here is the robust fix regardless of
        // which frame the runtime chooses.
        serialized = JSON.stringify({
          ...body,
          stream: true,
          stream_options: { include_usage: true },
        });
      } catch (err) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'serialize_failed',
            message: `failed to serialize call body: ${errorMessage(err)}`,
          },
        });
        return;
      }

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      // Ensure the shared `vicoop-codex serve` is up. A startup failure (binary
      // missing, too old to expose `serve`, port never opened) is terminal for
      // this task — surface `serve_unavailable` with the captured stderr.
      let serveHandle: ServeHandle;
      try {
        serveHandle = await ensureServe();
      } catch (err) {
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: normalizeTaskFailError({
            code: 'serve_unavailable',
            message: `failed to start vicoop-codex serve: ${errorMessage(err)}`,
          }),
        });
        return;
      }
      recorder.mark('serveReady');

      // Stream the response. Each `delta.content` fragment is emitted as an
      // `append:true` text artifact (single reused artifactId) so the gateway
      // codec maps it to an OpenAI SSE `delta.content` chunk (#293/#294).
      let responseArtifactId: string | null = null;
      let emittedAnyArtifact = false;
      const emitDelta = (text: string): void => {
        if (!text) return;
        recorder.mark('firstDelta');
        responseArtifactId ??= randomUUID();
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: responseArtifactId,
            name: 'vicoop-codex-message',
            parts: [{ kind: 'text', text }],
          },
          append: true,
          lastChunk: false,
        });
        emittedAnyArtifact = true;
      };

      // Distinct artifact id for the reasoning channel (#95 / #375), kept
      // separate from `responseArtifactId` so reasoning never co-mingles with
      // the answer artifact. Lazily minted on the first reasoning delta.
      let reasoningArtifactId: string | null = null;
      // Emit a reasoning-summary fragment on the dedicated `reasoning` channel:
      // a separate `artifactId` carrying the openai-compat/v1 marker
      // `metadata[OPENAI_COMPAT_EXTENSION_URI] = { channel: 'reasoning' }`,
      // appended with `lastChunk:false`. The oai2a2a codec maps this to
      // `delta.reasoning_content`; the a2x-internal-router treats it as a
      // liveness signal so a healthy long-reasoning turn is never
      // false-failed-over (#95). NOT a `vicoop-codex-message` artifact —
      // reasoning must stay out of the answer. Deliberately does NOT touch
      // `emittedAnyArtifact` (the answer's finalization gate): a turn that
      // streamed only reasoning still hits the `!emittedAnyArtifact` fallback
      // that emits the assembled answer once. Gated by `reasoningEnabled` at
      // the call site below.
      const emitReasoningArtifact = (text: string): void => {
        if (!text) return;
        reasoningArtifactId ??= randomUUID();
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: reasoningArtifactId,
            name: 'vicoop-codex-reasoning',
            parts: [{ kind: 'text', text }],
            extensions: [OPENAI_COMPAT_EXTENSION_URI],
            metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { channel: 'reasoning' } },
          },
          append: true,
          lastChunk: false,
        });
      };

      // Shared liveness heartbeat — see heartbeat.ts. Armed for the duration of
      // the streaming call: a long silent reasoning turn (no `delta.content`
      // bytes for a while) must still keep `working` frames flowing so the
      // router doesn't false-fail-over (#95 — the exact incident this backend
      // caused). Routes through the wrapped `emit` so a heartbeat refreshes the
      // silence window; suppressed once settled / aborted. Stopped in `finally`
      // on every exit path.
      const heartbeat = startLivenessHeartbeat({
        taskId: task.taskId,
        emit,
        now,
        lastActivityAt: () => lastEmitAt,
        isSettled: () => settled,
        isAborted: () => signal.aborted,
        setIntervalFn: setIntervalImpl,
        clearIntervalFn: clearIntervalImpl,
        intervalMs: heartbeatMs,
      });

      let response: ChatCompletionResponse;
      try {
        response = await streamChatCompletions(
          fetchFn,
          `${serveHandle.baseUrl}/v1/chat/completions`,
          serialized,
          signal,
          emitDelta,
          // When the reasoning channel is off, swallow reasoning deltas
          // entirely — no artifact, and (since reasoning never enters
          // `acc.content`) no leak into the answer.
          reasoningEnabled ? emitReasoningArtifact : () => {},
          () => recorder.mark('firstByte'),
        );
      } catch (err) {
        // Abort wins over any transport-error mapping — the caller pulled the
        // plug, so surface canceled.
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }
        const code = err instanceof ServeRequestError ? err.a2aCode : 'vicoop_codex_failed';
        const message = errorMessage(err);
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: normalizeTaskFailError({ code, message }),
        });
        return;
      } finally {
        // Stop the heartbeat once streaming has resolved/thrown. Everything
        // after this point is synchronous (no further awaits), so the loop is
        // over and the terminal frame is imminent on every remaining path.
        heartbeat.stop();
      }

      // Aborted mid-stream — surface as canceled regardless of what arrived
      // before the abort delivered.
      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      // Doc invariants: `choices` is always length 1, n>1 is unsupported.
      // Tolerate variants regardless (future schema bump) but always read
      // index 0 — anything else would silently lose data.
      const choice = response.choices?.[0];
      const messagePayload = choice?.message;
      const contentText =
        typeof messagePayload?.content === 'string' ? messagePayload.content : '';
      const toolCalls = Array.isArray(messagePayload?.tool_calls)
        ? messagePayload.tool_calls
        : [];
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';

      // Envelope contract (oai2a2a#80): tool_calls flow exclusively through
      // the terminal `chat_completion` envelope metadata — NOT as a data-part
      // artifact. Text content already streamed as `append:true` artifacts
      // above. Fallback: if the server returned text WITHOUT chunking it (no
      // deltas seen), emit it once here so non-OpenAI A2A consumers still see
      // the response — mirrors codex's `!emittedAnyArtifact` guard.
      if (!emittedAnyArtifact && toolCalls.length === 0 && contentText) {
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'vicoop-codex-message',
            parts: [{ kind: 'text', text: contentText }],
          },
          lastChunk: true,
        });
      }

      let usage = parseChatCompletionUsage(response.usage, response.model);
      // Captured before the zero-backfill below. The protocol's `usage` field
      // is what the bridge bills on and has no "must be present" contract, so
      // it stays absent when the runtime reported nothing — absent is the
      // truth, and a fabricated zero would be indistinguishable from a
      // genuinely free call.
      const protocolUsage = toProtocolTaskUsage(usage);
      // We force `stream_options.include_usage` on the request, so a missing
      // usage block here means the runtime dropped it on this turn despite
      // being asked for it — the #317 failure mode, which still recurs
      // intermittently. Log it (the $0-billed breadcrumb, diagnosable by task
      // id + finish_reason) AND backfill a zero usage: the openai-compat/v1
      // extension REQUIRES `chat_completion.usage` with numeric
      // prompt/completion/total, so omitting it makes the gateway hard-reject
      // the entire response ("missing required usage") and the caller loses an
      // otherwise-valid answer. A zero-filled usage keeps the turn spec-
      // compliant and delivered — it under-bills, which the warning surfaces,
      // but a delivered-but-unbilled turn beats a dropped one.
      if (!usage) {
        logger.warn?.(
          `[vicoop-codex] task=${task.taskId} finish_reason=${JSON.stringify(
            typeof response.choices?.[0]?.finish_reason === 'string'
              ? response.choices[0].finish_reason
              : null,
          )}: streamed response carried no usage despite stream_options.include_usage; backfilling zero usage to stay spec-compliant (downstream will record 0 tokens)`,
        );
        usage = buildOpenAICompatUsage({
          prompt_tokens: 0,
          completion_tokens: 0,
          model: response.model,
        });
      }
      const responseMetadata = buildResponseMetadata(response, usage, task.taskId);

      // The final `task.complete` message mirrors codex.ts's pattern:
      //   - `parts`: the assistant's text content (omitted on the tool-call
      //     path so we don't double-stamp the tool_calls envelope onto the
      //     status message).
      //   - `metadata[OPENAI_COMPAT_EXTENSION_URI]`: usage + the full
      //     chat_completion envelope. Always emitted so the caller has
      //     access to id / model / created / choices / finish_reason
      //     without parsing the artifact.
      //   - `extensions`: the OPENAI_COMPAT_EXTENSION_URI marker.
      const parts: Part[] =
        toolCalls.length === 0 && contentText ? [{ kind: 'text', text: contentText }] : [];
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        ...(protocolUsage !== undefined ? { usage: protocolUsage } : {}),
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            messageId: randomUUID(),
            parts,
            metadata: responseMetadata,
            extensions: [OPENAI_COMPAT_EXTENSION_URI],
          },
        },
      });
      // finish_reason is informational; surfaced only via the metadata
      // envelope above. The A2A `task.complete` state is always `completed`
      // (incl. `finish_reason: "tool_calls"`) because the tool-call round
      // is a successful turn from the bridge's perspective — the next A2A
      // turn brings back the tool result via `chat_history`.
      void finishReason;
    },
  };
}
