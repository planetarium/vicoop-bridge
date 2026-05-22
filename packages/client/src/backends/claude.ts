import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type Part,
} from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { formatAcct, formatMention, type AgentIdentity } from '../identity.js';
import {
  buildOpenAICompatUsage,
  makeOpenAICompatUsageMetadata,
  type OpenAICompatUsage,
} from './openai-compat-usage.js';
import {
  startSendFileMcpServer,
  type SendFileMcpOptions,
  type SendFileMcpServer,
} from './send-file-mcp.js';
import {
  startCallerToolsMcpServer,
  type CallerToolDefinition,
  type CallerToolInvocation,
  type CallerToolsMcpServer,
} from './caller-tools-mcp.js';
import {
  FetchUriError,
  fetchUriToBytes,
  INPUT_FILE_MAX_BYTES,
  INPUT_IMAGE_MIME,
  type FetchUriPolicy,
} from './fetch-uri-file.js';
import { createLogger, safeToken } from '../logger.js';
import { createTimingRecorder } from './timing.js';

// Slim subset of ChildProcess that the backend actually uses. Tests inject a
// fake that satisfies this without wiring up a real OS process.
export interface ClaudeChildHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface ClaudeSpawnOptions {
  cwd?: string;
}

export type ClaudeSpawnFn = (
  command: string,
  args: readonly string[],
  options: ClaudeSpawnOptions,
) => ClaudeChildHandle;

export interface ClaudeBackendOptions {
  command?: string;
  cwd?: string;
  extraArgs?: readonly string[];
  spawn?: ClaudeSpawnFn;
  stderrCaptureBytes?: number;
  // How long an idle (contextId → claude session_id) mapping survives without
  // use. Defaults to 1 hour. Set to 0 to disable session reuse so every task
  // starts a fresh claude session even on a recurring contextId — useful when
  // the caller wants strict statelessness or for testing.
  sessionTtlMs?: number;
  // Test seam: deterministic clock for TTL eviction.
  now?: () => number;
  /**
   * Expose a local Streamable HTTP MCP server with a `send_file(path, name?)`
   * tool that delivers files from disk to the A2A caller as `FilePart`
   * artifacts. When set, the server is registered into the spawned claude
   * via `--mcp-config` so the agent sees `send_file` in its tool list.
   *
   * Routing: a single in-flight task per backend instance. Concurrent tool
   * calls across overlapping tasks are rejected with `ambiguous-task`.
   */
  sendFileMcp?: SendFileMcpOptions;
  // Idle-silence heartbeat. While a task is running, if no other frame has
  // gone out for at least `heartbeatMs`, emit a bare `task.status` (state:
  // working, no message body) so callers and intermediaries (Fly edge,
  // SSE consumers) see bytes on the wire and don't tear down the
  // connection as a dead read. Default 30000 ms; pass 0 to disable.
  heartbeatMs?: number;
  // Test seam: timer impls. Defaults to global setInterval/clearInterval.
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  // Fetch uri-only inbound FileParts under the shared HTTPS/SSRF/size/MIME
  // policy. Enabled by default; set enabled:false to require inline bytes.
  fetchUriPolicy?: FetchUriPolicy;
  // Agent's own A2A identity. When present, an `--append-system-prompt` is
  // injected on every spawned `claude` so the model can recognise its own
  // mention (`@<agentId>@<host>`) / acct in user messages and respond
  // directly instead of attempting an outbound A2A call to its own address.
  // See issue #128 for the failure mode this prevents.
  identity?: AgentIdentity;
  // Inline Claude Code settings JSON forwarded to each spawned `claude` via
  // `--settings <json>`. Primary use case is enabling the OS-level sandbox
  // (Seatbelt on macOS, bubblewrap on Linux) in `-p` mode, where the
  // `/sandbox` slash command is unavailable. See issue #138.
  //
  // The object is serialized with `JSON.stringify` at backend construction
  // and must therefore be JSON-safe: `BigInt` values throw, `undefined` /
  // functions / symbols drop, and `NaN` / `Infinity` become `null`. The
  // backend does not validate shape or merge defaults — operators that want
  // sandbox-on-by-default with the local `send_file` MCP server reachable
  // must include the loopback host in `sandbox.network` themselves; the URL
  // is dynamic per task so the backend cannot pre-populate it without
  // rewriting the operator's JSON. Serialization failures surface as a
  // thrown Error from `createClaudeBackend(...)` so misconfiguration is
  // visible at startup rather than as a corrupted argv on the first task.
  settings?: Record<string, unknown>;
  /**
   * Test seam: invoked once per task with the caller-tools MCP server
   * handle immediately after the bridge stands one up (when the
   * openai-compat extension is active with `tools`). Used by unit tests
   * to drive `invokeForTest` against the exact server the spawn will
   * see, without going through a real MCP transport. Not part of the
   * public API — leave unset in production.
   */
  onCallerToolsMcpReady?: (server: CallerToolsMcpServer) => void;
}

// Kept short and behaviour-focused. The risk we're guarding against is
// concrete: a Claude-as-caller skill (a2a-wallet) interpreting the agent's
// own mention as an external destination. Anything beyond self-reference
// detection belongs in the operator-controlled prompt, not here.
export function buildSelfIdentitySystemPrompt(id: AgentIdentity): string {
  const mention = formatMention(id);
  const acct = formatAcct(id);
  return [
    `You are an A2A agent reachable as the mention \`${mention}\` (${acct}).`,
    `If a user message references this mention or acct, treat it as a self-reference and respond directly — do not invoke any outbound A2A tool or skill (e.g. a2a-wallet) to contact this address as if it were a separate agent.`,
  ].join(' ');
}

interface SessionEntry {
  sessionId: string;
  lastUsedAt: number;
  // Monotonic per-write token. A rollback only deletes the entry when
  // this matches the writeId the rolling-back task itself stamped — so a
  // second concurrent task on the same contextId that has since refreshed
  // the binding (and bumped writeId) is not robbed of its session id.
  writeId: number;
}

// claude --output-format stream-json writes one JSON object per line.
// Mapping from stream event → upstream A2A frame:
//
//   spawn (initial)            → task.status (state: working)
//   assistant: text block(s)   → task.artifact (name: claude-message)
//   assistant: tool_use block  → trace task.artifact when requested
//   user: tool_result image/PDF→ trace task.artifact when requested
//   user: tool_result text     → dropped (size/secrets policy; see #100)
//   result                     → task.complete (state: completed)
//   <heartbeatMs of silence>   → task.status (state: working, no body)
//
// Traceability Extension opt-in is per A2A request. Without it,
// `claude-tool-call` and `claude-tool-result` are suppressed so regular
// clients see only assistant-facing messages and explicit `send_file`
// artifacts.
//
// The `claude-tool-call` summary line is bounded as a whole: the
// `<tool>: <input>` text part is hard-capped at TOOL_CALL_SUMMARY_MAX_CHARS
// (tool-name prefix + JSON overhead included), and the JSON serializer
// also pre-clips individual string values during walking so a single
// huge field can't drive a multi-MiB intermediate buffer. The structured
// tool name + tool_use_id ride along on a `data` part so consumers can
// filter/count tool calls reliably even after the text was clipped.
interface StreamEvent {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
  result?: unknown;
  terminal_reason?: unknown;
  is_error?: unknown;
  // Present on the terminal `result` event. `modelUsage` is the per-model
  // breakdown — preferred over the top-level `usage` because Claude Code
  // can route through internal sub-models (e.g. haiku for summarisation)
  // whose tokens never appear in `usage` but do appear here. Summing across
  // all entries honours the openai-compat/v1 spec's "every model invocation
  // that contributed to producing this response" requirement.
  modelUsage?: unknown;
}

// Parse Claude Code's `result.modelUsage` (a map keyed by model id with
// per-model { inputTokens, outputTokens, cacheCreationInputTokens,
// cacheReadInputTokens, ... }) into a spec-compliant OpenAICompatUsage.
//
// Mapping rule per the native-fields appendix
// (extensions/openai-compat/v1#native-field-mappings):
//   prompt_tokens = Σ_M (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)
//   prompt_tokens_details.cached_tokens = Σ_M cacheReadInputTokens  (lossless mirror)
//   completion_tokens = Σ_M outputTokens
// `model` is reported as the entry with the largest output share — usually
// the user-facing primary model; ties go to whichever Object.entries returns
// first, which is fine for telemetry.
export function parseClaudeModelUsageForOpenAICompat(raw: unknown): OpenAICompatUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let promptSum = 0;
  let completionSum = 0;
  let cacheReadSum = 0;
  let primaryModel: string | null = null;
  let primaryOutput = -1;
  let saw = false;
  for (const [modelKey, perModel] of Object.entries(raw as Record<string, unknown>)) {
    if (!perModel || typeof perModel !== 'object' || Array.isArray(perModel)) continue;
    const m = perModel as Record<string, unknown>;
    const input = typeof m.inputTokens === 'number' ? m.inputTokens : 0;
    const output = typeof m.outputTokens === 'number' ? m.outputTokens : 0;
    const cacheCreate =
      typeof m.cacheCreationInputTokens === 'number' ? m.cacheCreationInputTokens : 0;
    const cacheRead = typeof m.cacheReadInputTokens === 'number' ? m.cacheReadInputTokens : 0;
    promptSum += input + cacheCreate + cacheRead;
    completionSum += output;
    cacheReadSum += cacheRead;
    if (output > primaryOutput) {
      primaryOutput = output;
      primaryModel = modelKey;
    }
    saw = true;
  }
  if (!saw) return null;
  return buildOpenAICompatUsage({
    prompt_tokens: promptSum,
    completion_tokens: completionSum,
    cached_tokens: cacheReadSum > 0 ? cacheReadSum : undefined,
    model: primaryModel ?? undefined,
  });
}

// Anthropic-shaped content block we send on stdin.
type InputContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'document';
      source: { type: 'base64'; media_type: string; data: string };
    };

// Hard cap on a single tool_result media block's decoded size before
// it becomes an outbound A2A FilePart. Prevents a misbehaving tool
// (e.g. an MCP screenshot at unbounded resolution) from forcing a huge
// in-memory base64 decode and a giant artifact payload on the wire.
const TOOL_RESULT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

// Tool-call summary line length. Bounds the on-wire size of a single
// `claude-tool-call` artifact's text part — the model's `tool_use.input`
// can be megabytes (e.g. Write with full file `content`), and we don't
// want a single tool turn to fill the artifact stream or burn CPU
// stringifying the whole thing. The structured `toolName` rides on a
// separate `data` part so consumers still get a stable handle for
// filtering after the head was clipped.
//
// Threat model: SIZE only. Head-truncation is NOT a secrets guard —
// tokens, keys, or other sensitive values that appear in the first
// ~200 chars of the input WILL be emitted. Operators that need
// secret-safe artifacts must add per-tool redaction (or gate input
// summaries off entirely; #100 part B follow-up).
const TOOL_CALL_SUMMARY_MAX_CHARS = 200;

// Default idle-silence heartbeat. `dist/backends/claude.js` events that
// do tool work (Bash/Read/Grep/Edit/MCP) can run minute-plus without
// producing any assistant text — long enough to trip Fly edge and SSE
// caller idle timeouts. Below this many ms of silence, emit a bare
// `task.status: working` so bytes keep flowing.
const DEFAULT_HEARTBEAT_MS = 30_000;

// Defensive stringification — `(e as Error).message` is unsafe when the
// thrown value is null/undefined or a non-Error primitive (common in JS).
// Always returns a string suitable for logs/frames without throwing.
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
}

function decodedBase64Size(b64: string): number {
  if (b64.length === 0) return 0;
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  // Clamp to >= 0 so a malformed input like a bare "=" or "==" (which
  // would otherwise compute to -1) reports zero, not a negative size.
  // The size-cap callers only need a non-negative upper bound; any deeper
  // base64 validation belongs to whoever decodes the bytes.
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function sha256OfBase64(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
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

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: ClaudeSpawnOptions,
): ClaudeChildHandle {
  return nodeSpawn(command, Array.from(args), {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }) as ChildProcess;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

interface ToolUseBlock {
  toolName: string;
  toolUseId: string;
  summary: string;
  input: unknown;
}

// Bounded stringification for a `tool_use.input`. The naive
// `JSON.stringify(input)` materializes the whole input as a string
// before the caller clips to TOOL_CALL_SUMMARY_MAX_CHARS, so a tool
// with a multi-MiB string field — or a top-level array of 100k tiny
// values — would allocate a giant intermediate buffer just to chop
// the first 200 chars. We avoid both:
//
//   1. Per-string clip:  any individual string value longer than
//      `clipPerString` is sliced before serialization.
//   2. Hard total budget: we walk top-level keys/elements only and
//      bail out once the accumulator exceeds `budget` chars. The
//      caller's `clipTo` does the final trim.
//   3. No recursion:     nested objects / arrays are summarized as a
//      type tag (`"<object>"` / `"<array(N)>"`) rather than walked,
//      so depth is irrelevant to cost.
//
// Worst-case work is O(top-level-keys × clipPerString) and the
// returned string itself is bounded by `budget`, regardless of the
// input's actual size or shape.
function stringifyValueClipped(v: unknown, clipPerString: number): string {
  if (typeof v === 'string') {
    return JSON.stringify(v.length > clipPerString ? v.slice(0, clipPerString) : v);
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `"<array(${v.length})>"`;
  if (typeof v === 'object') return '"<object>"';
  try {
    return JSON.stringify(String(v));
  } catch {
    return '"?"';
  }
}

// Exported for direct tests of the bounded-walk behavior; the production
// caller (handleEvent → emitToolCallArtifact) goes through it indirectly.
export function summarizeToolInput(input: unknown, clipPerString: number): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input.slice(0, clipPerString + 1);
  if (typeof input !== 'object') {
    try {
      return String(input).slice(0, clipPerString + 1);
    } catch {
      return '<unserializable>';
    }
  }
  // Small overshoot lets the caller's clipTo see we exceeded and apply
  // its truncation marker; we don't need exact-budget output here.
  const budget = clipPerString + 16;
  try {
    if (Array.isArray(input)) {
      let out = '[';
      for (let i = 0; i < input.length; i++) {
        if (out.length >= budget) break;
        if (i > 0) out += ',';
        out += stringifyValueClipped(input[i], clipPerString);
      }
      return out + ']';
    }
    let out = '{';
    let first = true;
    // Stream keys via `for..in` rather than `Object.keys`: the latter
    // allocates the full key array up front, which would itself be
    // unbounded on a tool input with 100k top-level keys. With `for..in`
    // we can stop walking as soon as we hit `budget` without paying for
    // keys we'll never look at.
    for (const k in input) {
      if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
      if (out.length >= budget) break;
      if (!first) out += ',';
      first = false;
      // Clip the key too: a 100-KB property name would otherwise drive
      // a 100-KB+ JSON.stringify allocation just to hit the budget on
      // the next line. Same `clipPerString` cap applies to keys and
      // values so the bounded-cost guarantee holds for both.
      const clippedKey = k.length > clipPerString ? k.slice(0, clipPerString) : k;
      out += JSON.stringify(clippedKey) + ':';
      out += stringifyValueClipped((input as Record<string, unknown>)[k], clipPerString);
    }
    return out + '}';
  } catch {
    return '<unserializable>';
  }
}

function clipTo(line: string, max: number): string {
  if (line.length <= max) return line;
  // 1-char ellipsis keeps the head as long as possible while still
  // signalling truncation. Callers know the cap; they can recover the
  // tool name (and full input from a server-side log) if needed.
  return `${line.slice(0, Math.max(0, max - 1))}…`;
}

function traceabilityRequested(task: {
  requestedExtensions?: readonly string[];
  message?: { extensions?: readonly string[] };
}): boolean {
  return (
    task.requestedExtensions?.includes(TRACEABILITY_EXTENSION_URI) === true ||
    task.message?.extensions?.includes(TRACEABILITY_EXTENSION_URI) === true
  );
}

// One entry of `tool_call_history` — either an `assistant` turn echoing the
// model's prior tool_calls envelope, or a `tool` turn carrying the function
// return that the gateway executed externally. Mirrors OpenAI Chat
// Completions message shape for these two roles.
export interface OpenAICompatHistoryAssistant {
  role: 'assistant';
  tool_calls: unknown[];
}
export interface OpenAICompatHistoryTool {
  role: 'tool';
  tool_call_id: string;
  name?: string;
  // OpenAI permits string-or-content-parts; on the wire we require string so
  // gateways own the normalisation. Bridges treat it as opaque text.
  content: string;
}
export type OpenAICompatHistoryEntry =
  | OpenAICompatHistoryAssistant
  | OpenAICompatHistoryTool;

// Payload of the openai-compat A2A extension as carried under
// `Message.metadata[OPENAI_COMPAT_EXTENSION_URI]`. Each field is optional and
// is forwarded verbatim from the OpenAI-shaped originating request.
export interface OpenAICompatMetadata {
  system?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  tool_call_history?: OpenAICompatHistoryEntry[];
}

// Whole-array validator for `tool_call_history`. Returns null (caller drops
// the field) on ANY malformed entry rather than skipping it — order and
// id-pairings between `assistant.tool_calls` and `role:"tool"` results
// matter, so dropping a middle entry would silently break the model's view
// of the prior round. Strict-or-nothing is safer than forgiving-with-holes.
function parseToolCallHistory(raw: unknown[]): OpenAICompatHistoryEntry[] | null {
  if (raw.length === 0) return null;
  const out: OpenAICompatHistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (
      e.role === 'assistant' &&
      Array.isArray(e.tool_calls) &&
      e.tool_calls.length > 0
    ) {
      out.push({ role: 'assistant', tool_calls: e.tool_calls });
      continue;
    }
    if (
      e.role === 'tool' &&
      typeof e.tool_call_id === 'string' &&
      e.tool_call_id.length > 0 &&
      typeof e.content === 'string'
    ) {
      const toolEntry: OpenAICompatHistoryTool = {
        role: 'tool',
        tool_call_id: e.tool_call_id,
        content: e.content,
      };
      if (typeof e.name === 'string' && e.name.length > 0) toolEntry.name = e.name;
      out.push(toolEntry);
      continue;
    }
    return null;
  }
  return out;
}

// True when the caller has supplied tool definitions AND has not explicitly
// disabled tool use (`tool_choice === "none"`). Backends consult this to
// decide whether to suppress agent-side built-in tools that would otherwise
// bypass the envelope-emit contract — see #175 for the codex case (built-in
// shell/exec executed `ls` directly instead of emitting a `tool_calls`
// envelope for the caller's `bash` definition) and #178 for the same
// pattern in claude (built-in Read/Glob/Bash served a `ls` request without
// surfacing the caller's `List`). The condition mirrors `hasTools` in
// `buildOpenAICompatSystemPrompt` so the gate that enables the envelope
// contract in the prompt is the same gate that disables the conflicting
// built-ins.
export function callerToolDispatchActive(meta: OpenAICompatMetadata | null): boolean {
  if (!meta) return false;
  if (meta.tools === undefined) return false;
  return meta.tool_choice !== 'none';
}

// Extract and shape-check the openai-compat metadata key. Returns null when
// the metadata key is absent, malformed, or actionably empty (all four
// fields missing or trivial) so the caller can fall back to its non-extension
// path without conditional null-checks on every read.
export function parseOpenAICompatMetadata(
  metadata: Record<string, unknown> | undefined,
): OpenAICompatMetadata | null {
  if (!metadata) return null;
  const raw = metadata[OPENAI_COMPAT_EXTENSION_URI];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: OpenAICompatMetadata = {};
  if (typeof r.system === 'string' && r.system.length > 0) out.system = r.system;
  if (Array.isArray(r.tools) && r.tools.length > 0) out.tools = r.tools;
  if (r.tool_choice !== undefined && r.tool_choice !== null) out.tool_choice = r.tool_choice;
  if (Array.isArray(r.tool_call_history)) {
    const history = parseToolCallHistory(r.tool_call_history);
    if (history) out.tool_call_history = history;
  }
  if (
    out.system === undefined &&
    out.tools === undefined &&
    out.tool_choice === undefined &&
    out.tool_call_history === undefined
  ) {
    return null;
  }
  return out;
}

function describeToolChoice(toolChoice: unknown): string | null {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === 'auto') {
    return 'tool_choice="auto": call a function only if appropriate; otherwise answer in natural language.';
  }
  if (toolChoice === 'required') {
    return 'tool_choice="required": you MUST emit a tool_calls envelope — answering in natural language is not allowed for this turn.';
  }
  if (typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const c = toolChoice as { type?: unknown; function?: unknown };
    if (c.type === 'function' && c.function && typeof c.function === 'object') {
      const fn = c.function as { name?: unknown };
      if (typeof fn.name === 'string' && fn.name.length > 0) {
        return `tool_choice: you MUST emit a tool_calls envelope that calls the function named "${fn.name}".`;
      }
    }
  }
  return null;
}

// Build the system-prompt text injected via `--append-system-prompt` when the
// openai-compat extension is active. Composition rules:
//
//   - User-supplied `system` (if any) is included verbatim, first.
//   - The tool-envelope contract block is included only when `tools` were
//     provided and `tool_choice` is not "none" — without tools the envelope
//     would be a contract the model can't satisfy. With tool_choice="none"
//     we instead emit a short "do not use the envelope" directive so the
//     gateway's intent is preserved.
//   - A tool_choice descriptor line is appended when the value is one of
//     the recognised shapes (`"auto"` / `"required"` / `{type:"function",
//     function:{name}}`); unrecognised values are silently dropped because
//     the model can't act on a shape it doesn't understand.
export function buildOpenAICompatSystemPrompt(meta: OpenAICompatMetadata): string {
  const sections: string[] = [];
  if (meta.system) sections.push(meta.system);

  const toolChoiceIsNone = meta.tool_choice === 'none';
  const hasTools = meta.tools !== undefined && !toolChoiceIsNone;

  if (hasTools) {
    sections.push(
      [
        'You are routed through an OpenAI-compatible gateway and have access to the following callable functions.',
        '',
        'When you decide a function should be called, respond with ONLY a single JSON object (no prose, no code fences, no markdown) of the exact shape:',
        '',
        '{"tool_calls":[{"id":"call_<unique>","function":{"name":"<fn name>","arguments":{<args as JSON object>}}}]}',
        '',
        '- "id" must be a unique string starting with "call_".',
        '- "arguments" must be a JSON object matching the function\'s parameters schema.',
        '- Emit nothing outside the JSON object.',
        '- Do not execute the function yourself; just emit the call.',
        '- If no function should be called, answer normally in natural language.',
        '',
        // History-block contract: aligned with `formatToolCallHistory`'s
        // rendering. The model needs to know how to read the block AND that
        // already-resolved calls must not be repeated, otherwise it'll loop.
        'On follow-up turns the user message may begin with a <tool_call_history>...</tool_call_history> block containing a JSON array of prior round-trips. Each entry is one of:',
        '  - {"role":"assistant","tool_calls":[...]} — calls you previously emitted on an earlier turn.',
        '  - {"role":"tool","tool_call_id":"call_…","name":"…","content":"…"} — the authoritative return value for one of those calls.',
        'Treat the history as the source of truth for what has happened so far. Do NOT repeat a call whose tool_call_id already appears in the history. Either emit a NEW tool_calls envelope (to chain another call) or compose a natural-language answer using the prior results.',
        '',
        'Available functions:',
        JSON.stringify(meta.tools, null, 2),
      ].join('\n'),
    );
    const tcDesc = describeToolChoice(meta.tool_choice);
    if (tcDesc) sections.push(tcDesc);
  } else if (toolChoiceIsNone) {
    sections.push(
      'A list of OpenAI-style tools was supplied with tool_choice="none". Do not emit a tool_calls envelope; always answer in natural language.',
    );
  }

  return sections.join('\n\n');
}

// Map the caller-provided OpenAI `tools` array (the wire shape used in
// OpenAI Chat Completions: `{ type: 'function', function: { name, description,
// parameters } }`) to `CallerToolDefinition[]` for `caller-tools-mcp`. Mirrors
// `openaiToolsToDynamicToolSpecs` on the codex backend (#212) byte-for-byte
// in its mapping rules — same dropped entries (no name, missing function
// envelope, unknown type) and same empty-object schema default for tools
// declared without `parameters`. Returns `null` when no usable entries
// remain so callers can branch off "no tools to register" without checking
// `length`.
export function openaiToolsToCallerToolDefs(
  tools: readonly unknown[],
): CallerToolDefinition[] | null {
  const out: CallerToolDefinition[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const wrap = t as { type?: unknown; function?: unknown };
    if (wrap.type !== 'function') continue;
    if (!wrap.function || typeof wrap.function !== 'object') continue;
    const fn = wrap.function as {
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
    };
    if (typeof fn.name !== 'string' || !fn.name) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      // Forward the JSON Schema verbatim. The MCP server in turn forwards
      // it to claude unchanged, so the model sees exactly what the caller
      // declared. Missing `parameters` ⇒ the canonical empty-object
      // schema, matching OpenAI's convention for parameterless functions.
      inputSchema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : null;
}

// Build the system-prompt text injected via `--append-system-prompt` for the
// openai-compat path on the claude backend (#213). The caller's tools are
// exposed to the model through the native MCP tool surface
// (`caller-tools-mcp.ts`), so the prompt no longer teaches a JSON-emit
// contract or duplicates the tool list — the model discovers tools via
// `tools/list` and invokes them through its normal `tool_use` surface.
//
// What we still teach the model:
//   - Caller's `system` text — verbatim, first. No other transport carries
//     it: MCP `tools/list` only describes tools, not the conversation's
//     system message.
//   - How to read the `<tool_call_history>` block. Follow-up turns
//     text-prepend the history (`formatToolCallHistory`) because claude has
//     no native equivalent of codex's `thread/inject_items`. The model has
//     to know the block is authoritative and not to re-emit a call whose
//     result is already recorded.
//   - tool_choice descriptor for `"required"` and `{type:"function",
//     function:{name}}` — claude has no native `tool_choice` flag, so the
//     prompt is the only place we can express it.
//
// What we DON'T teach anymore:
//   - The "respond with ONLY a single JSON object …" envelope contract.
//   - The full `JSON.stringify(meta.tools)` dump.
//   - A "stop after invoking, don't chain" directive — `--max-turns 1` on
//     the spawned claude enforces it mechanically. The model can still
//     emit parallel `tool_use` blocks within one assistant message (which
//     is fine per OpenAI semantics), but it cannot proceed to a second
//     model turn within the same task.
//   - A "session memory vs history block" disambiguation — openai-compat
//     tasks always spawn with a fresh `--session-id` (see the session
//     reuse gate in `handle()`), so there's no prior session memory to
//     conflict with the history block.
export function buildOpenAICompatNativeSystemPrompt(meta: OpenAICompatMetadata): string {
  const sections: string[] = [];
  if (meta.system) sections.push(meta.system);

  const toolChoiceIsNone = meta.tool_choice === 'none';
  const hasTools = meta.tools !== undefined && !toolChoiceIsNone;

  if (hasTools) {
    sections.push(
      [
        'You are routed through an OpenAI-compatible gateway. The caller has supplied function tools that appear in your native tool list — invoke them through your normal tool-use surface.',
        '',
        'The user message may begin with a <tool_call_history>...</tool_call_history> block holding a JSON array of prior round-trips: {"role":"assistant","tool_calls":[...]} for calls you previously emitted, and {"role":"tool","tool_call_id":"call_…","name":"…","content":"…"} for the authoritative result of each call. Treat the block as the source of truth for what has happened so far — do not re-emit a call whose `tool_call_id` already has a recorded result.',
      ].join('\n'),
    );
    const tcDesc = describeToolChoice(meta.tool_choice);
    if (tcDesc) sections.push(tcDesc);
  } else if (toolChoiceIsNone) {
    sections.push(
      'A list of OpenAI-style tools was supplied with tool_choice="none". Do not invoke any caller-provided tool; always answer in natural language.',
    );
  }

  return sections.join('\n\n');
}

// Render a `tool_call_history` payload as a `<tool_call_history>`-wrapped
// JSON block. Goes at the front of the user content on follow-up turns so
// the model reads the prior round before the new instruction; the wrapper
// tag makes the boundary unambiguous against the user's own text. The
// inner array is the parsed history verbatim — same shape as on the wire,
// so the model only has to learn one structure (also taught in the
// SYSTEM_INSTRUCTION above).
//
// Note: the `codex` backend bypasses this text-prepend and instead injects
// native Responses API `function_call` / `function_call_output` items via
// `thread/inject_items` (see historyToInjectItems in codex.ts) — that gives
// the model proper native tool-call history rather than a JSON blob it has
// to be instructed to interpret. claude / openclaw still use this textual
// form because their native conversation channels are different.
export function formatToolCallHistory(history: OpenAICompatHistoryEntry[]): string {
  return [
    '<tool_call_history>',
    JSON.stringify(history, null, 2),
    '</tool_call_history>',
  ].join('\n');
}

// Attempt to interpret an assistant message as the OpenAI tool-call envelope
// the SYSTEM_INSTRUCTION above teaches the model to emit. Returns the parsed
// envelope verbatim (preserving unknown keys) when the trimmed text parses as
// a JSON object carrying a `tool_calls` array; otherwise null so the caller
// falls back to a text artifact. Strict: a leading non-`{` character (prose
// preamble, code fence, etc.) short-circuits without paying the JSON.parse.
export function tryParseToolCallsEnvelope(
  text: string,
): (Record<string, unknown> & { tool_calls: unknown[] }) | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.tool_calls)) return null;
  return obj as Record<string, unknown> & { tool_calls: unknown[] };
}

// Pull `tool_use` blocks out of an `assistant`-role message's content
// array. Each one becomes one `claude-tool-call` artifact upstream, with
// a head-truncated `<tool>: <input>` summary plus a `data` part carrying
// the structured tool name + tool_use_id for consumer-side filtering.
function extractAssistantToolUses(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolUseBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; name?: unknown; id?: unknown; input?: unknown };
    if (b.type !== 'tool_use') continue;
    const toolName = typeof b.name === 'string' ? b.name : '<unknown>';
    const toolUseId = typeof b.id === 'string' ? b.id : '';
    const summary = clipTo(
      `${toolName}: ${summarizeToolInput(b.input, TOOL_CALL_SUMMARY_MAX_CHARS)}`,
      TOOL_CALL_SUMMARY_MAX_CHARS,
    );
    out.push({ toolName, toolUseId, summary, input: b.input });
  }
  return out;
}

// Cap on the Task `description` text we surface in subagent bookend
// messages. Same head-truncation rule as tool-call summaries — long
// descriptions get a single-char ellipsis so consumers can still tell
// the message was clipped.
const TASK_DESCRIPTION_MAX_CHARS = 200;

// Pull the human-readable description out of a Task tool's input object.
// Claude Code's built-in Task tool accepts `{ description, prompt,
// subagent_type }`; `description` is the short 3-5-word label the model
// is supposed to write. Returns the empty string if the field is missing
// or unusable — the caller falls back to a bare "Task" label.
function extractTaskDescription(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const i = input as { description?: unknown };
  if (typeof i.description !== 'string') return '';
  const trimmed = i.description.trim();
  if (!trimmed) return '';
  return clipTo(trimmed, TASK_DESCRIPTION_MAX_CHARS);
}

interface TaskCompletion {
  toolUseId: string;
  description: string;
  isError: boolean;
}

// Walk a `user`-role event's content array for `tool_result` blocks
// matching tool_use_ids we previously registered as in-flight Task runs.
// We surface a bookend message per match so callers see the subagent
// finished even when the subagent itself emitted no user-visible text
// (its output is packed into the tool_result fed back to the main
// agent, not into the assistant stream).
function extractTaskCompletions(
  content: unknown,
  registry: ReadonlyMap<string, string>,
): TaskCompletion[] {
  if (!Array.isArray(content)) return [];
  const out: TaskCompletion[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown };
    if (b.type !== 'tool_result') continue;
    if (typeof b.tool_use_id !== 'string') continue;
    const description = registry.get(b.tool_use_id);
    if (description === undefined) continue;
    out.push({
      toolUseId: b.tool_use_id,
      description,
      isError: b.is_error === true,
    });
  }
  return out;
}

// Pull image/document blocks out of a `user`-role event's `tool_result`
// content array. MCP screenshot tools, image-generation tools, and built-in
// Read on a media file all surface here. Returned in encounter order.
function extractToolResultMediaParts(content: unknown): Part[] {
  if (!Array.isArray(content)) return [];
  const out: Part[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; content?: unknown };
    if (b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
    for (const inner of b.content) {
      if (!inner || typeof inner !== 'object') continue;
      const i = inner as {
        type?: unknown;
        source?: { type?: unknown; media_type?: unknown; data?: unknown };
      };
      if (i.type !== 'image' && i.type !== 'document') continue;
      const src = i.source;
      if (!src || src.type !== 'base64') continue;
      if (typeof src.media_type !== 'string' || typeof src.data !== 'string') continue;
      out.push({
        kind: 'file',
        file: { mimeType: src.media_type, bytes: src.data },
      });
    }
  }
  return out;
}

async function mapPartsToContentBlocks(
  parts: readonly Part[],
  fetchUriPolicy: FetchUriPolicy | undefined,
  signal: AbortSignal,
):
  Promise<
    | { ok: true; blocks: InputContentBlock[]; inboundHashes: Set<string> }
    | { ok: false; code: string; message: string }
  > {
  const blocks: InputContentBlock[] = [];
  // SHA-256 (hex) of every accepted FilePart's decoded bytes. Used by the
  // tool_result passthrough to skip echoes — if the model Reads a caller-
  // provided file the same bytes would otherwise re-emit as a new artifact.
  const inboundHashes = new Set<string>();
  for (const p of parts) {
    if (p.kind === 'text') {
      if (p.text) {
        blocks.push({ type: 'text', text: p.text });
      }
      continue;
    }
    if (p.kind === 'data') {
      // Auxiliary structured metadata. Render as a tagged JSON text block
      // appended after primary text — Anthropic's API takes one content array
      // and there's no dedicated data channel for caller-supplied context.
      const serialized = serializeDataPart(p.data);
      if (serialized) blocks.push({ type: 'text', text: serialized });
      continue;
    }
    if (p.kind === 'file') {
      let bytes = p.file.bytes;
      let mime = p.file.mimeType ?? '';
      if (!bytes && p.file.uri !== undefined && fetchUriPolicy?.enabled !== false) {
        try {
          const fetched = await fetchUriToBytes(p.file.uri, p.file.mimeType, fetchUriPolicy, signal);
          bytes = fetched.bytes;
          mime = fetched.mimeType;
        } catch (err) {
          if (err instanceof FetchUriError) {
            return { ok: false, code: err.code, message: err.message };
          }
          return {
            ok: false,
            code: 'fetch_failed',
            message: errorMessage(err),
          };
        }
      }
      if (!bytes && p.file.uri !== undefined && fetchUriPolicy?.enabled === false) {
        return {
          ok: false,
          code: 'unsupported_file_uri',
          message: 'claude backend URI fetching is disabled; provide inline FilePart bytes',
        };
      }
      if (!bytes && p.file.uri === undefined) {
        return {
          ok: false,
          code: 'invalid_file_part',
          message: 'claude backend FilePart must carry either bytes or uri',
        };
      }
      if (!bytes) {
        return {
          ok: false,
          code: 'unsupported_file_uri',
          message: 'claude backend requires inline FilePart bytes or fetchable file.uri',
        };
      }
      const decodedSize = decodedBase64Size(bytes);
      if (decodedSize > INPUT_FILE_MAX_BYTES) {
        return {
          ok: false,
          code: 'file_too_large',
          message: `FilePart exceeds INPUT_FILE_MAX_BYTES (${decodedSize} > ${INPUT_FILE_MAX_BYTES})`,
        };
      }
      if (INPUT_IMAGE_MIME.has(mime)) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mime, data: bytes },
        });
      } else if (mime === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: mime, data: bytes },
        });
      } else {
        return {
          ok: false,
          code: 'unsupported_file_mime',
          message: `claude backend accepts image/{png,jpeg,webp,gif} or application/pdf (got ${mime || 'unknown'})`,
        };
      }
      inboundHashes.add(sha256OfBase64(bytes));
      continue;
    }
  }
  // Media-only messages (image/document with no text) are accepted —
  // Anthropic's vision/document path can answer about them without an
  // accompanying prompt. Only a fully empty content array fails loud.
  if (blocks.length === 0) {
    return { ok: false, code: 'empty_prompt', message: 'no content in message' };
  }
  return { ok: true, blocks, inboundHashes };
}

export function createClaudeBackend(
  opts: ClaudeBackendOptions = {},
): Backend & { getSendFileMcpServer(): SendFileMcpServer | null } {
  const command = opts.command ?? 'claude';
  const cwd = opts.cwd;
  const extraArgs = opts.extraArgs ?? [];
  const spawnFn = opts.spawn ?? defaultSpawn;
  const stderrCap = opts.stderrCaptureBytes ?? 8192;
  const sessionTtlMs = opts.sessionTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setIntervalImpl = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const timingLogger = createLogger();
  const sendFileMcpOpts =
    opts.sendFileMcp && opts.sendFileMcp.allowedRoots.length > 0
      ? opts.sendFileMcp
      : null;
  // Static per-backend args (placed before extraArgs so an operator-supplied
  // `--append-system-prompt` in extraArgs concatenates AFTER ours rather than
  // being ignored — claude appends each occurrence in order).
  const identityArgs: readonly string[] = opts.identity
    ? ['--append-system-prompt', buildSelfIdentitySystemPrompt(opts.identity)]
    : [];
  // Sandbox-on by default. Operators get the OS-level sandbox (Seatbelt on
  // macOS, bubblewrap on Linux) without having to opt in via
  // `CLAUDE_SETTINGS_JSON`, and `failIfUnavailable: true` makes the daemon
  // exit at startup on a host where the sandbox can't be enabled — failing
  // open here would silently run unsandboxed, which the agent's filesystem
  // and shell access make actively unsafe. An operator who explicitly passes
  // `settings` (via env or config.json) overrides this default entirely; to
  // turn the sandbox off they pass `{ "sandbox": { "enabled": false } }`.
  const DEFAULT_SETTINGS: Record<string, unknown> = {
    sandbox: { enabled: true, failIfUnavailable: true },
  };
  const resolvedSettings = opts.settings ?? DEFAULT_SETTINGS;
  // Serialize once at backend construction so per-task spawn stays cheap and
  // a malformed settings object (circular reference, BigInt value, etc.)
  // fails loud at setup time rather than producing a corrupted argv on the
  // first task. The wrapper Error name-checks the option and surfaces the
  // underlying `JSON.stringify` message so a misconfiguration is actionable
  // without the operator having to read a raw stack trace.
  //
  // `resolvedSettings` is unconditionally an object now (DEFAULT_SETTINGS
  // fallback above), so there's no `if (!resolvedSettings) return []` path —
  // operators that want to omit --settings entirely must pass an explicit
  // override that disables the sandbox (e.g. `{ sandbox: { enabled: false } }`).
  const settingsArgs: readonly string[] = ((): readonly string[] => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(resolvedSettings);
    } catch (err) {
      throw new Error(
        `createClaudeBackend: failed to serialize \`settings\` option as JSON for --settings argv: ${errorMessage(err)}`,
      );
    }
    // JSON.stringify can return `undefined` even without throwing — e.g. a
    // top-level `toJSON()` that returns undefined, or the value being a bare
    // function/symbol. Without this guard the argv would carry `undefined`
    // which the child spawn coerces to the string "undefined", silently
    // running claude with a bogus --settings payload. Surface the same
    // named error so callers can't miss it.
    if (typeof serialized !== 'string') {
      throw new Error(
        'createClaudeBackend: `settings` option serialized to `undefined` ' +
          '(toJSON returned undefined, or value was a function/symbol); ' +
          'pass a JSON-safe object for --settings argv',
      );
    }
    return ['--settings', serialized];
  })();

  // Lazy: first task that needs the MCP server starts it; backends that
  // never see send_file enabled don't open a port.
  let sendFileMcp: SendFileMcpServer | null = null;
  let sendFileMcpStarting: Promise<SendFileMcpServer> | null = null;
  async function ensureSendFileMcp(): Promise<SendFileMcpServer | null> {
    if (!sendFileMcpOpts) return null;
    if (sendFileMcp) return sendFileMcp;
    if (sendFileMcpStarting) return sendFileMcpStarting;
    sendFileMcpStarting = (async () => {
      const server = await startSendFileMcpServer(sendFileMcpOpts);
      sendFileMcp = server;
      console.log(`[claude] send_file MCP server listening at ${server.url}`);
      return server;
    })();
    try {
      return await sendFileMcpStarting;
    } finally {
      sendFileMcpStarting = null;
    }
  }

  // contextId → claude session_id. A follow-up task on the same A2A
  // contextId resumes the same claude conversation via --resume so the model
  // sees prior turns; without this every task would be a fresh chat with no
  // memory. The map is in-memory only — restarts lose the binding (next task
  // on a stale contextId starts a new session).
  const sessions = new Map<string, SessionEntry>();
  // Monotonic counter shared across all writes into `sessions`. Used to
  // disambiguate concurrent tasks on the same contextId so a rollback only
  // touches the entry the rolling-back task itself last wrote.
  let writeCounter = 0;

  function evictExpired(cutoff: number): void {
    for (const [key, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) sessions.delete(key);
    }
  }

  return {
    name: 'claude',

    getSendFileMcpServer: () => sendFileMcp,

    async handle(task, rawEmit, signal) {
      // Idle-silence heartbeat needs to observe every outbound frame so
      // it doesn't fire while real traffic is flowing. Wrap rawEmit so
      // every emission refreshes `lastEmitAt`. The heartbeat tick also
      // goes through this wrapped `emit` (NOT `rawEmit`) — that is what
      // resets `lastEmitAt` on a heartbeat frame so a follow-up tick at
      // the same instant sees a fresh window and skips. See the tick
      // site below for the rationale; the two comments must stay
      // consistent.
      let lastEmitAt = now();
      const recorder = createTimingRecorder({
        logger: timingLogger,
        backend: 'claude',
        taskId: task.taskId,
        contextId: task.contextId,
        now,
      });
      // Terminal frame types trigger the single per-task timing log line.
      // The mark fires BEFORE rawEmit so the emit-side cost is captured,
      // and finish fires AFTER so the line follows the lifecycle log.
      const emit: typeof rawEmit = (frame) => {
        lastEmitAt = now();
        const terminal = frame.type === 'task.complete' || frame.type === 'task.fail';
        if (terminal) recorder.mark('emit');
        rawEmit(frame);
        if (terminal) {
          const state =
            frame.type === 'task.fail'
              ? 'failed'
              : frame.status?.state ?? 'completed';
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

      // Detect the openai-compat extension payload once per task so the
      // result feeds both the spawn argv (--append-system-prompt) and the
      // assistant artifact path (tool_calls JSON → data part). Absent or
      // malformed metadata leaves the run on the original non-extension code
      // path with no envelope-detection cost.
      const openaiCompat = parseOpenAICompatMetadata(task.message.metadata);

      // Native MCP dispatch (#213): when the openai-compat extension is
      // active and carries `tools` (and `tool_choice !== "none"`), the
      // caller's tool surface is exposed through a per-task in-process MCP
      // server (`caller-tools-mcp`) — the claude analog of codex's
      // `dynamicTools` (#212). `callerToolDefs` is non-null only on that
      // path; downstream gates (`--mcp-config caller-tools`, native system
      // prompt, `--max-turns 1`) branch off this single check, so claude
      // tasks without the openai-compat extension (or without `tools`)
      // remain on the default agentic path with claude's built-ins intact.
      const callerToolDefs =
        callerToolDispatchActive(openaiCompat) && openaiCompat?.tools
          ? openaiToolsToCallerToolDefs(openaiCompat.tools)
          : null;
      const nativeDispatchActive = callerToolDefs !== null;

      const mapped = await mapPartsToContentBlocks(task.message.parts, opts.fetchUriPolicy, signal);
      recorder.mark('map');
      if (mapped.ok && openaiCompat?.tool_call_history) {
        // Spec contract: bridges MUST replay the entire `tool_call_history`
        // in order. We render it as a text block and prepend it to the user
        // content so the model reads the prior round BEFORE the current
        // user turn. Any internal optimisation (e.g. claude `--resume`
        // already holds the prior `assistant.tool_calls` in session
        // memory) is invisible to the wire and does not change replay
        // semantics — the redundancy is the price of cross-bridge interop.
        mapped.blocks.unshift({
          type: 'text',
          text: formatToolCallHistory(openaiCompat.tool_call_history),
        });
      }
      if (!mapped.ok) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: mapped.code, message: mapped.message },
        });
        return;
      }

      // Session reuse is for A2A callers that want conversation continuity
      // across tasks sharing a contextId. The openai-compat extension is
      // stateless by design — every OpenAI Chat Completions request carries
      // its own full message history, so resuming a prior claude session
      // would risk feeding the model two sources of truth (claude's own
      // session memory containing the sentinel "captured by bridge" result
      // we returned from the MCP `onInvoke` handler, AND the user message's
      // prepended `tool_call_history` JSON carrying the caller's real tool
      // results). Skip the session map entirely for openai-compat tasks so
      // every spawn starts on a clean `--session-id`; the history block in
      // the user message is then the unambiguous source of truth.
      const sessionReuseEligible = openaiCompat === null && sessionTtlMs > 0;
      const tNow = now();
      if (sessionReuseEligible) evictExpired(tNow - sessionTtlMs);
      const existing = sessionReuseEligible ? sessions.get(task.contextId) : undefined;
      const sessionId = existing?.sessionId ?? randomUUID();
      const isResume = existing !== undefined;
      let writeId = 0;
      if (sessionReuseEligible) {
        // Refresh lastUsedAt eagerly: a concurrent second task on the same
        // contextId arriving before this one finishes also resumes the same
        // session id (rather than racing to mint a new one).
        writeId = ++writeCounter;
        sessions.set(task.contextId, { sessionId, lastUsedAt: tNow, writeId });
      }

      // Drop the freshly-minted (contextId → sessionId) binding when the
      // run never reached a successful state, so the next task on this
      // contextId mints a brand-new id instead of `--resume`-ing a session
      // claude never persisted on disk. No-op if this run was already
      // resuming an existing session, or if session reuse is disabled.
      //
      // Concurrency: only delete when the entry is still the one THIS task
      // wrote. A second concurrent task on the same contextId would have
      // bumped `writeId` when refreshing the binding; if we see a different
      // writeId, that other task now "owns" the entry and should keep it.
      // Declared early so the early-return paths below (sendFile MCP
      // failure with a fatal escalation, caller-tools MCP failure) can
      // reach it before the spawn block redeclares it.
      const rollbackFreshSession = (): void => {
        if (isResume || !sessionReuseEligible) return;
        const cur = sessions.get(task.contextId);
        if (cur?.sessionId === sessionId && cur.writeId === writeId) {
          sessions.delete(task.contextId);
        }
      };

      // Bring up the MCP server first (if enabled) so we know its URL before
      // building argv. A startup failure disables the tool path for this task
      // but the run continues — the caller still gets text/markers.
      let mcpServerForTask: SendFileMcpServer | null = null;
      if (sendFileMcpOpts) {
        try {
          mcpServerForTask = await ensureSendFileMcp();
        } catch (err) {
          console.warn(
            `[claude] send_file MCP server failed to start; tool path disabled for this task: ${errorMessage(err)}`,
          );
        }
        recorder.mark('mcp');
      }

      // Flag flipped by the `caller-tools-mcp` invocation handler when the
      // model invokes a caller-supplied tool. Read in the terminal block
      // below to suppress re-stamping the model's wrap-up text on
      // `status.message.parts` — the `tool_calls` data artifact is the
      // complete output for this turn, matching OpenAI Chat Completions'
      // `finish_reason: "tool_calls"` semantics (the same invariant codex
      // backend enforces on its native path, see #212).
      let capturedToolCall = false;

      // Caller-side function tools, exposed as native MCP tools. Per-task
      // lifecycle: stood up here BEFORE the spawn (so we know the URL to
      // wire into `--mcp-config`), torn down in `closeCallerToolsMcp`
      // which is called once per terminal path. A startup failure
      // surfaces as a task.fail — there is no envelope-text fallback to
      // fall back to (#213 removed the envelope-shape dispatch entirely),
      // so a bind failure is a hard run failure that the caller needs to
      // see rather than a silent downgrade.
      let callerToolsMcp: CallerToolsMcpServer | null = null;
      const closeCallerToolsMcp = async (): Promise<void> => {
        // Idempotent: each return path may call this and we only want one
        // real close. Nulling out before the await also avoids a race if a
        // throw inside `close()` re-entered this function.
        if (!callerToolsMcp) return;
        const s = callerToolsMcp;
        callerToolsMcp = null;
        try {
          await s.close();
        } catch (err) {
          console.warn(
            `[claude] caller-tools MCP close failed: ${errorMessage(err)}`,
          );
        }
      };
      if (callerToolDefs) {
        try {
          callerToolsMcp = await startCallerToolsMcpServer({
            // Tests drive this listener-free via `invokeForTest`; production
            // leaves `skipHttp` unset so claude can connect over HTTP.
            skipHttp: opts.onCallerToolsMcpReady !== undefined,
            tools: callerToolDefs,
            onInvoke: (invocation: CallerToolInvocation) => {
              // Same OpenAI wire shape the envelope path emits — downstream
              // gateways (oai2a2a) see no difference between native and
              // envelope output, so this dispatch swap is invisible above
              // the bridge layer.
              const envelope = {
                tool_calls: [
                  {
                    id: invocation.callId,
                    function: {
                      name: invocation.toolName,
                      arguments: invocation.arguments,
                    },
                  },
                ],
              };
              emit({
                type: 'task.artifact',
                taskId: task.taskId,
                artifact: {
                  artifactId: randomUUID(),
                  name: 'claude-message',
                  parts: [{ kind: 'data', data: envelope }],
                  extensions: [OPENAI_COMPAT_EXTENSION_URI],
                },
                lastChunk: true,
              });
              capturedToolCall = true;
              // The actual tool result is the caller's job — it arrives on
              // the next A2A turn via `tool_call_history`. Returning a
              // short structured-error ack here so claude sees "tool gave
              // up; don't try again" rather than "tool succeeded with some
              // text result" (which it might then try to summarise). The
              // system-prompt directive in
              // `buildOpenAICompatNativeSystemPrompt` reinforces the same
              // stop-after-invoke rule from the prompt side.
              return {
                text: 'caller-tool call captured by bridge; the actual result will be delivered on the next turn',
                isError: true,
              };
            },
          });
        } catch (err) {
          rollbackFreshSession();
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'caller_tools_mcp_start_failed',
              message: `caller-tools MCP server failed to start: ${errorMessage(err)}`,
            },
          });
          return;
        }
        recorder.mark('caller-tools-mcp');
        if (callerToolsMcp && opts.onCallerToolsMcpReady) {
          opts.onCallerToolsMcpReady(callerToolsMcp);
        }
      }
      // When the openai-compat extension carries `tools`, by here the MCP
      // server is definitively up (a startup failure already short-circuited
      // above into task.fail). nativeReady is therefore equivalent to
      // nativeDispatchActive, but kept named so the argv conditions below
      // read in terms of the model's view ("native tool surface is live").
      const nativeReady = nativeDispatchActive && callerToolsMcp !== null;

      // Per-task `--append-system-prompt` carrying the openai-compat
      // extension's system / tools / tool_choice. Placed AFTER identityArgs
      // (so the self-identity directive is the model's first read) but
      // BEFORE extraArgs (so an operator-supplied append still wins by
      // appending last — claude concatenates each --append-system-prompt
      // occurrence in argv order).
      const openaiCompatArgs: readonly string[] = openaiCompat
        ? [
            '--append-system-prompt',
            buildOpenAICompatNativeSystemPrompt(openaiCompat),
          ]
        : [];
      // Disable claude's built-in tools (Read / Glob / Bash / Edit / Write /
      // ...) when the caller has supplied its own tool definitions via the
      // openai-compat extension. Without this, claude silently uses its own
      // tools to satisfy a request like "list the cwd" and emits the result
      // as plain text, bypassing the caller's `tool_calls` envelope contract
      // — see #178 for the observed case (envelope absent, response served
      // from agent-side filesystem). `--tools ""` is the documented switch
      // for blanket-disabling built-ins; MCP-registered tools (e.g.
      // `send_file`) continue to load via `--mcp-config`.
      const disableBuiltinToolArgs: readonly string[] = callerToolDispatchActive(openaiCompat)
        ? ['--tools', '']
        : [];
      // Cap claude to a single model turn when caller-tools are dispatched
      // natively (#213). Without this, the model would treat our MCP
      // sentinel ack (`isError:true` "captured by bridge…") as a tool
      // failure and CHAIN further tool calls within the same A2A turn —
      // each chain step is a full Anthropic API round-trip paying the
      // system-prompt + tools-definition cost, AND every chained call is
      // decided on stale / wrong feedback (the model never sees the
      // caller's real tool result until the next OpenAI request comes in).
      // Capping the turn forces a clean unwind after one tool call,
      // mirroring codex's `turn/interrupt` behaviour under PR #212. The
      // single text artifact path (no tool invoked) is unaffected because
      // it still fits in one model turn. Off when nativeReady is false so
      // the envelope path's existing semantics are preserved.
      const nativeTurnCapArgs: readonly string[] = nativeReady
        ? ['--max-turns', '1']
        : [];

      // Both MCP servers ride on a single `--mcp-config` argv with one
      // JSON blob. Keys are the MCP server names claude exposes the
      // tools under (`mcp__<name>__<tool>` is the resulting tool-id
      // pattern in the model's view). Either or both can be absent
      // depending on opts; an entirely empty `mcpServers` map skips
      // both `--mcp-config` and the matching `--allowedTools` below.
      const mcpServers: Record<string, { type: string; url: string }> = {};
      // Registration keys use a `_vb-` ("vicoop-bridge") prefix so they
      // can't collide with operator-supplied MCP server names under the
      // same `--mcp-config` map. The previous keys (`vicoop-bridge`,
      // `caller-tools`) were generic enough that an operator naming
      // their own MCP server identically would last-wins overwrite the
      // bridge's entry. The leading underscore marks these as internal
      // and the short brand prefix keeps the resulting tool ids
      // (`mcp___vb-<server>__<tool>`) readable. A future merge of these
      // two servers under #216 would naturally land at a single `_vb`.
      if (mcpServerForTask) {
        mcpServers['_vb-send-file'] = { type: 'http', url: mcpServerForTask.url };
      }
      if (callerToolsMcp) {
        mcpServers['_vb-caller-tools'] = { type: 'http', url: callerToolsMcp.url };
      }
      const mcpServerNames = Object.keys(mcpServers);
      const mcpConfigArgs: readonly string[] =
        mcpServerNames.length === 0
          ? []
          : ['--mcp-config', JSON.stringify({ mcpServers })];
      // Pre-approve the MCP servers we register. claude's permission system
      // runs even in `-p` mode, and with the built-in `defaultMode: "default"`
      // there's no TTY to answer a permission prompt — the request silently
      // auto-denies, the model's tool call never executes, and the run dies
      // at `--max-turns 1` with `permission_denials` in the result event
      // (see #235). Built-ins are already off via `--tools ""` so this
      // allowlist only opens tools the bridge itself stood up; operator
      // settings retain veto power because claude's `deny` rules beat
      // `allow`. Server-level rule (`mcp__<server>`) covers every tool
      // exposed by that server without naming them individually.
      const mcpAllowedToolsArgs: readonly string[] =
        mcpServerNames.length === 0
          ? []
          : ['--allowedTools', mcpServerNames.map((s) => `mcp__${s}`).join(' ')];

      const args: string[] = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        // Required alongside --output-format stream-json; without it claude
        // prints a banner and exits instead of streaming.
        '--verbose',
        ...(isResume ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...mcpConfigArgs,
        ...mcpAllowedToolsArgs,
        ...identityArgs,
        ...openaiCompatArgs,
        ...disableBuiltinToolArgs,
        ...nativeTurnCapArgs,
        ...settingsArgs,
        ...extraArgs,
      ];

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      let child: ClaudeChildHandle;
      try {
        timingLogger.debug(
          `claude.spawn.start taskId=${safeToken(task.taskId)} command=${safeToken(command)} cwd=${cwd ? safeToken(cwd) : '<default>'} argv=${safeToken(JSON.stringify(args), 8000)}`,
        );
        child = spawnFn(command, args, { cwd });
        recorder.mark('spawn');
      } catch (err) {
        rollbackFreshSession();
        await closeCallerToolsMcp();
        timingLogger.debug(
          `claude.spawn.error taskId=${safeToken(task.taskId)} command=${safeToken(command)} cwd=${cwd ? safeToken(cwd) : '<default>'} argv=${safeToken(JSON.stringify(args), 8000)} error=${safeToken(errorMessage(err), 1000)}`,
        );
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: 'spawn_failed', message: errorMessage(err) },
        });
        return;
      }

      // Write the user message envelope and close stdin so claude sees EOF
      // and proceeds. Errors here are recorded; the close listener still
      // drives the terminal frame so we don't double-emit.
      let stdinError: unknown = null;
      if (!child.stdin) {
        // A custom spawn that doesn't pipe stdin would otherwise leave
        // claude blocked waiting for input. Hard-fail loud rather than
        // hang the run.
        try {
          child.kill('SIGTERM');
        } catch {
          /* best effort */
        }
        // The freshly-minted sessionId never reached claude, so a follow-up
        // task on the same contextId must mint a new id rather than --resume.
        rollbackFreshSession();
        await closeCallerToolsMcp();
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'spawn_no_stdin',
            message: 'spawned claude has no stdin pipe; cannot deliver user message',
          },
        });
        return;
      }
      // Attach an error listener BEFORE writing. EPIPE and similar stream
      // failures surface asynchronously via `error` rather than as a
      // synchronous throw from `.end()`; without this, the unhandled error
      // would crash the process. The exit-nonzero handler already
      // formats `stdinError` into the surfaced message.
      child.stdin.on('error', (err: unknown) => {
        if (!stdinError) stdinError = err;
      });
      try {
        const envelope = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: mapped.blocks },
        });
        child.stdin.write(envelope + '\n');
        recorder.mark('stdin');
      } catch (err) {
        stdinError = err;
      }

      let emittedAnyArtifact = false;
      let emittedAskUserQuestion = false;
      let pendingInputRequest: {
        kind: 'tool_call'
        toolName: 'AskUserQuestion'
        toolUseId: string
        input: unknown
      } | null = null;
      let finalText: string | null = null;
      let finalUsage: OpenAICompatUsage | null = null;
      let sawCompletedResult = false;
      let sawErrorResult = false;
      let stdoutTail = '';
      let stderrTail = '';
      let aborted = false;
      let settled = false;
      const emitTraceArtifacts = traceabilityRequested(task);
      // tool_use_id → description for in-flight Task subagent runs.
      // Populated when a `Task` tool_use is observed; drained when the
      // matching tool_result returns so we can bookend the long silence
      // while the subagent is running with a visible "started/completed"
      // message. Surfaces regardless of the traceability opt-in because
      // without it callers see ZERO progress between the model's Task
      // call and its final response.
      const activeTaskRuns = new Map<string, string>();

      // Register this task with the send_file MCP server (if running) so
      // tool calls landing during this run resolve to this task's emit().
      // Released in the terminal block so a crashed/timed-out task doesn't
      // keep the slot occupied indefinitely.
      let sendFileRelease: (() => void) | null = null;
      if (mcpServerForTask) {
        const handle = mcpServerForTask.registerActiveTask({
          taskId: task.taskId,
          contextId: task.contextId,
          emit: (artifact) => {
            emit({
              type: 'task.artifact',
              taskId: task.taskId,
              artifact,
              lastChunk: true,
            });
            emittedAnyArtifact = true;
          },
        });
        sendFileRelease = handle.release;
      }

      const emitAssistantArtifact = (text: string): void => {
        if (!text) return;
        // openai-compat caller tools land as a `tool_calls` data artifact
        // through the caller-tools MCP onInvoke handler above, NOT via
        // any text-shape parsing. Assistant-text turns (natural-language
        // answers, or any turn from a task that didn't request the
        // extension) are emitted unchanged as a `text` part artifact.
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'claude-message',
            parts: [{ kind: 'text', text }],
          },
          // Each assistant message is a complete artifact on its own (same
          // shape openclaw uses for session.message streaming).
          lastChunk: true,
        });
        emittedAnyArtifact = true;
      };

      const emitToolResultMedia = (parts: Part[]): void => {
        if (!emitTraceArtifacts) return;
        if (parts.length === 0) return;
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'claude-tool-result',
            parts,
            extensions: [TRACEABILITY_EXTENSION_URI],
            metadata: { traceType: 'tool-result' },
          },
          lastChunk: true,
        });
        emittedAnyArtifact = true;
      };

      // Surface a subagent lifecycle bookend as a `claude-message`
      // artifact (NOT a trace artifact) so callers see it without opting
      // into the traceability extension. The structured event +
      // toolUseId on `metadata` let smart consumers style/correlate
      // start↔end, but a plain text reader sees a normal chat message.
      const emitSubagentEventArtifact = (
        event: 'subagent-started' | 'subagent-completed' | 'subagent-failed',
        toolUseId: string,
        description: string,
      ): void => {
        const verb =
          event === 'subagent-started'
            ? 'started'
            : event === 'subagent-completed'
              ? 'completed'
              : 'failed';
        const label = description || 'Task';
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'claude-message',
            parts: [{ kind: 'text', text: `Task ${verb}: ${label}` }],
            metadata: { event, toolUseId },
          },
          lastChunk: true,
        });
        emittedAnyArtifact = true;
      };

      const emitToolCallArtifact = (block: ToolUseBlock): void => {
        if (!emitTraceArtifacts) return;
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'claude-tool-call',
            parts: [
              { kind: 'text', text: block.summary },
              {
                kind: 'data',
                data: { toolName: block.toolName, toolUseId: block.toolUseId },
              },
            ],
            extensions: [TRACEABILITY_EXTENSION_URI],
            metadata: { traceType: 'tool-call' },
          },
          lastChunk: true,
        });
        emittedAnyArtifact = true;
      };

      const handleEvent = (evt: StreamEvent): void => {
        if (settled) return;
        if (evt.type === 'assistant') {
          if (evt.message?.role !== 'assistant') return;
          recorder.mark('firstAssistant');
          // A single assistant turn can interleave plain text and tool_use
          // blocks. Emit the text (if any) first so observers see "what the
          // model said" before "what tools it then called", matching the
          // visible CLI ordering inside that turn.
          if (!emittedAskUserQuestion) {
            emitAssistantArtifact(extractAssistantText(evt.message.content));
          }
          if (emittedAskUserQuestion) return;
          for (const tu of extractAssistantToolUses(evt.message.content)) {
            if (tu.toolName === 'AskUserQuestion' && tu.toolUseId && child.stdin) {
              // Stash for input-required terminal frame (A2A spec §9.4).
              // Placeholder tool_result + stdin.end() flushes CC's session state
              // so the next turn can --resume cleanly.
              pendingInputRequest = {
                kind: 'tool_call',
                toolName: 'AskUserQuestion',
                toolUseId: tu.toolUseId,
                input: tu.input,
              };
              emittedAskUserQuestion = true;
              const toolResult = JSON.stringify({
                type: 'user',
                message: {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: tu.toolUseId,
                      content: 'Question displayed to user. Do NOT attempt to answer on their behalf. Wait for their response in the next message. Stop here and end your response now.',
                    },
                  ],
                },
              });
              child.stdin.write(toolResult + '\n');
              try { child.stdin.end(); } catch { /* best effort */ }
            } else {
              // Surface Task starts as user-visible messages independently
              // of the trace artifact stream — they bookend the otherwise
              // silent window while the subagent runs. Trace artifact (if
              // requested) still fires so trace-aware consumers see the
              // structured tool-call alongside the human-readable bookend.
              if (tu.toolName === 'Task' && tu.toolUseId) {
                const description = extractTaskDescription(tu.input);
                activeTaskRuns.set(tu.toolUseId, description);
                emitSubagentEventArtifact('subagent-started', tu.toolUseId, description);
              }
              if (emitTraceArtifacts) emitToolCallArtifact(tu);
            }
          }
          return;
        }
        if (evt.type === 'user') {
          // Task completion bookends must fire BEFORE the trace gate —
          // they are always user-visible, regardless of the traceability
          // opt-in, to close the loop on the start message we emitted
          // above. A subagent that errored surfaces as "Task failed: ..."
          // so the caller can tell their request didn't quietly succeed.
          if (activeTaskRuns.size > 0) {
            for (const done of extractTaskCompletions(evt.message?.content, activeTaskRuns)) {
              activeTaskRuns.delete(done.toolUseId);
              emitSubagentEventArtifact(
                done.isError ? 'subagent-failed' : 'subagent-completed',
                done.toolUseId,
                done.description,
              );
            }
          }
          if (!emitTraceArtifacts) return;
          // tool_result events come in as a synthetic user message in the
          // stream-json transcript; pull out any image/document blocks and
          // emit them as A2A FileParts. Text-only tool results are skipped.
          // Two filters apply, in order:
          //   1. size cap — drop oversize blocks before we even base64-decode
          //      them for hashing (cheap length math first; full decode is
          //      O(payload size)).
          //   2. echo dedup — a tool_result whose decoded bytes match an
          //      inbound FilePart (e.g. the model Read the caller's image)
          //      would re-emit the same payload back. Drop those.
          const dedupActive = mapped.inboundHashes.size > 0;
          const parts = extractToolResultMediaParts(evt.message?.content).filter((p) => {
            if (p.kind !== 'file' || !p.file.bytes) return true;
            const decodedSize = decodedBase64Size(p.file.bytes);
            if (decodedSize > TOOL_RESULT_MEDIA_MAX_BYTES) {
              console.warn(
                `[claude] tool_result media dropped: decoded size ${decodedSize} > ${TOOL_RESULT_MEDIA_MAX_BYTES}`,
              );
              return false;
            }
            // Skip the hash when there are no inbound files to dedup against.
            // The hash decodes the full base64 (up to 5 MiB) and would burn
            // CPU/memory on every tool_result image for no possible match.
            if (!dedupActive) return true;
            return !mapped.inboundHashes.has(sha256OfBase64(p.file.bytes));
          });
          emitToolResultMedia(parts);
          return;
        }
        if (evt.type === 'result') {
          if (typeof evt.result === 'string' && !emittedAskUserQuestion) finalText = evt.result;
          if (evt.terminal_reason === 'completed') sawCompletedResult = true;
          if (evt.is_error === true) sawErrorResult = true;
          // openai-compat/v1 response-side usage: prefer modelUsage over the
          // top-level `usage` (latter omits internal sub-model invocations).
          // Best-effort: a malformed shape just leaves finalUsage null and
          // the gateway falls back to its own estimate.
          const parsed = parseClaudeModelUsageForOpenAICompat(evt.modelUsage);
          if (parsed) finalUsage = parsed;
          // CC finished — close stdin now that no more tool_results need writing.
          try { child.stdin?.end(); } catch { /* best effort */ }
        }
      };

      const onAbort = (): void => {
        if (aborted) return;
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Best-effort; if the process is already gone the close listener
          // still fires and drives the terminal frame.
        }
      };
      signal.addEventListener('abort', onAbort);

      let stdoutBuf = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        recorder.mark('firstOut');
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stdoutTail += text;
        if (stdoutTail.length > stderrCap) stdoutTail = stdoutTail.slice(-stderrCap);
        stdoutBuf += text;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let evt: StreamEvent;
          try {
            evt = JSON.parse(line) as StreamEvent;
          } catch {
            continue;
          }
          handleEvent(evt);
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderrTail.length > stderrCap) stderrTail = stderrTail.slice(-stderrCap);
      });

      // Idle-silence heartbeat: while the child is alive, every
      // `heartbeatMs` of no outbound traffic produces a bare
      // `task.status: working` so callers and intermediaries see bytes
      // on the wire. Disabled when heartbeatMs <= 0.
      let heartbeatHandle: unknown = null;
      if (heartbeatMs > 0) {
        heartbeatHandle = setIntervalImpl(() => {
          if (settled) return;
          // After abort the run is going to settle as `canceled` once
          // the child finishes tearing down; emitting more
          // `state: working` heartbeats in that window would actively
          // misrepresent the task status to the caller. Suppress them.
          if (aborted) return;
          if (now() - lastEmitAt < heartbeatMs) return;
          // Route through the wrapped `emit` (NOT `rawEmit`): the
          // wrapper refreshes `lastEmitAt` before forwarding the frame,
          // so a follow-up tick arriving at the same instant sees a
          // fresh window and skips. Calling `rawEmit` here would leave
          // `lastEmitAt` stale and let several ticks emit back-to-back
          // if the timer fired multiple times after a long pause.
          emit({
            type: 'task.status',
            taskId: task.taskId,
            status: { state: 'working', timestamp: new Date().toISOString() },
          });
        }, heartbeatMs);
      }

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: unknown }>((resolve) => {
        // The `error` event is *typed* with `Error`, but EventEmitter at
        // runtime can emit any value. Carry it as unknown so the frame
        // builder routes through `errorMessage` safely.
        child.on('error', (err) => resolve({ code: null, signal: null, error: err }));
        child.on('close', (code, sig) => resolve({ code, signal: sig }));
      });
      recorder.mark('closed');
      timingLogger.debug(
        `claude.spawn.close taskId=${safeToken(task.taskId)} command=${safeToken(command)} code=${exit.code === null ? 'null' : String(exit.code)} signal=${exit.signal ? safeToken(exit.signal) : 'null'} stdoutTailChars=${stdoutTail.length} stderrTailChars=${stderrTail.length}${exit.error ? ` error=${safeToken(errorMessage(exit.error), 1000)}` : ''}`,
      );

      signal.removeEventListener('abort', onAbort);
      settled = true;
      sendFileRelease?.();
      // Caller-tools MCP is per-task; release it as soon as claude has
      // exited so a misbehaving model that keeps the MCP request open
      // can't pin the listener after the run is conceptually done.
      // Awaited so a slow close (the SDK's transport teardown is async)
      // can't race a follow-up task starting a new server on the same
      // port. Safe to await even on the success path because by here
      // we're guaranteed claude has already disconnected.
      await closeCallerToolsMcp();
      if (heartbeatHandle !== null) clearIntervalImpl(heartbeatHandle);

      // Flush any trailing line without a newline. claude normally terminates
      // each event with \n but a crash mid-write could leave one orphan.
      const trailing = stdoutBuf.trim();
      if (trailing) {
        try {
          handleEvent(JSON.parse(trailing) as StreamEvent);
        } catch {
          // ignore
        }
      }

      if (aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      if (exit.error) {
        rollbackFreshSession();
        await closeCallerToolsMcp();
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          // exit.error is typed Error from the child `error` event but a
          // custom spawn / fake child could emit a non-Error here. Route
          // through errorMessage so .message access can't crash the frame.
          error: { code: 'spawn_failed', message: errorMessage(exit.error) },
        });
        return;
      }

      // Native dispatch (#213): under `--max-turns 1`, claude code exits
      // with code 1 immediately after the model emits its tool_use(s) —
      // it interprets the cap as "exceeded" the moment a follow-up turn
      // would be needed to feed the tool_result back. The `tool_calls`
      // data artifact(s) are already on the wire by this point, so the
      // task IS effectively complete from the caller's perspective; the
      // nonzero exit is bookkeeping noise, not a real failure. Same
      // invariant codex backend enforces on its native path (PR #212
      // maps `turn/interrupt` → `completed` when capturedToolCall is true).
      // Caller-initiated abort still wins — surfacing a captured tool call
      // when the caller explicitly canceled would override their request.
      //
      // Separately, recent Claude Code builds can emit a structured,
      // non-error terminal result with terminal_reason:"completed" and no
      // stderr, then still close with code 1. Treat the structured result as
      // authoritative in that narrow case; keep explicit is_error results,
      // stderr/stdin-error exits, and real startup/auth/model failures
      // failing.
      const treatExitAsSuccess =
        (capturedToolCall && exit.code !== 0 && !aborted) ||
        (
          exit.code !== 0 &&
          sawCompletedResult &&
          !sawErrorResult &&
          stderrTail.trim() === '' &&
          stdinError === null &&
          !aborted
        );

      if (exit.code !== 0 && !treatExitAsSuccess) {
        rollbackFreshSession();
        const detail = stderrTail.trim();
        const stdoutDetail = stdoutTail.trim();
        const sigPart = exit.signal ? ` (signal ${exit.signal})` : '';
        const detailPart = detail ? `: ${detail.slice(-500)}` : '';
        const stdoutPart = stdoutDetail ? ` [stdout: ${stdoutDetail.slice(-500)}]` : '';
        // If stdin write blew up and the process exited non-zero, surface
        // both: the stdin error is usually the proximate cause.
        const stdinPart = stdinError ? ` [stdin: ${errorMessage(stdinError)}]` : '';
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'claude_exit_nonzero',
            message: `claude exited with code ${exit.code}${sigPart}${detailPart}${stdoutPart}${stdinPart}`,
          },
        });
        return;
      }

      if (pendingInputRequest !== null) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: {
            state: 'input-required',
            timestamp: new Date().toISOString(),
            message: {
              role: 'agent' as const,
              messageId: randomUUID(),
              parts: [{ kind: 'data', data: pendingInputRequest }],
            },
          },
        });
        return;
      }

      const completeText = finalText ?? '';
      // Native MCP dispatch (#213): when the model invoked a caller tool,
      // the `tool_calls` data artifact (emitted via the MCP onInvoke
      // handler above) is the complete task output. Any wrap-up text the
      // model produced before exiting the turn (the system-prompt
      // directive tells it to stop, but models occasionally emit a brief
      // acknowledgement anyway) is reasoning preamble and must NOT be
      // re-stamped on `status.message.parts` — same invariant codex
      // backend enforces under PR #212, same root-cause concern as #200.
      const parts: Part[] = !capturedToolCall && completeText
        ? [{ kind: 'text', text: completeText }]
        : [];

      // Streaming produced nothing (e.g. claude only wrote a `result` event).
      // Emit the final text once so clients that ignore task.complete still
      // see content.
      if (!emittedAnyArtifact && completeText) {
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'claude-result',
            parts: [{ kind: 'text', text: completeText }],
          },
          lastChunk: true,
        });
      }

      // Attach the openai-compat/v1 `usage` payload to the final A2A
      // message of this turn when the underlying claude run reported it.
      // Per spec the carrier is `Task.status.message.metadata[<URI>].usage`,
      // so when usage is present but there is no completion text we still
      // emit a message frame (with empty parts) to carry the metadata.
      const hasMessage = parts.length > 0 || finalUsage !== null;
      const messageMetadata = finalUsage
        ? makeOpenAICompatUsageMetadata(finalUsage)
        : undefined;
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          ...(hasMessage
            ? {
                message: {
                  role: 'agent' as const,
                  messageId: randomUUID(),
                  parts,
                  ...(messageMetadata
                    ? {
                        metadata: messageMetadata,
                        extensions: [OPENAI_COMPAT_EXTENSION_URI],
                      }
                    : {}),
                },
              }
            : {}),
        },
      });
    },
  };
}
