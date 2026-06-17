import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type OpenAICompatModelAdvertise,
  type Part,
} from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { normalizeTaskFailError } from '../failure-code.js';
import { buildSelfIdentitySystemPrompt, type AgentIdentity } from '../identity.js';
import {
  buildOpenAICompatResponseMetadata,
  buildOpenAICompatUsage,
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
import {
  callerToolDispatchActive,
  chatHistoryFromMessages,
  collectSystemFromMessages,
  describeToolChoice,
  dumpOpenAICompatTaskWire,
  formatChatHistoryBlocks,
  parseOpenAICompatEnvelope,
  requalifyHistoryToolNames,
} from './openai-compat.js';

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
  // Extra environment variables for the spawned process, merged OVER the parent
  // env (so the child still inherits the daemon's environment). Used for the
  // per-spawn knobs Claude Code only reads from the environment — it exposes no
  // CLI flag for them — e.g. `ENABLE_PROMPT_CACHING_1H`.
  env?: Record<string, string>;
}

export type ClaudeSpawnFn = (
  command: string,
  args: readonly string[],
  options: ClaudeSpawnOptions,
) => ClaudeChildHandle;

export interface ClaudeBackendOptions {
  command?: string;
  cwd?: string;
  // Working directory for stateless openai-compat spawns, overriding `cwd` for
  // those tasks only. They have no legitimate use for the operator's `cwd`:
  // native dispatch disables claude's built-ins (`--tools ""`) and the path
  // replaces claude's default prompt via `--system-prompt` (so cwd never even
  // reaches the model), while the operator-cwd's CLAUDE.md, project settings,
  // and hooks are all off-target for a generic chat/completions proxy turn —
  // and re-paid on every fresh session. Pointing these spawns at an empty dir
  // with no CLAUDE.md / project-settings ancestors drops that overhead.
  // Defaults to a stable dir under the OS temp root (created on first use);
  // overridable for tests. Plain A2A tasks keep `cwd` untouched.
  openaiCompatCwd?: string;
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
  // Model id for the spawned `claude` (e.g. `claude-opus-4-8`), exposed via
  // the `--claude-model` flag. Merged into the resolved `--settings` JSON as
  // its `model` field so it survives alongside the default sandbox guard and
  // any operator-supplied `settings`. A per-request openai-compat envelope
  // `model` still wins: that path adds an explicit `--model <id>` argv, which
  // claude prioritises over the settings.json `model` field. When unset, the
  // model falls back to claude's own resolution (project/user settings.json,
  // ANTHROPIC_MODEL, built-in default).
  model?: string;
  // Additional model ids this claude install can serve (e.g.
  // ['claude-sonnet-4-6', 'claude-haiku-4-5']), exposed via the
  // `--claude-supported-models` flag. Claude Code has no headless "list models"
  // interface — the startup probe only reveals the single resolved default
  // (`system/init.model` echoes whatever `--model` was passed, verbatim,
  // without validating account access) — so multi-model support is
  // operator-declared: entries are advertised on the openai-compat/v1
  // `params.models[]` block after the default (the `--claude-model` pin or
  // the probed model) and accepted by the `envelope.model` gate, riding to
  // the spawn as `--model <id>`. The list is NOT validated against the
  // account: a declared model the account cannot access fails at task time
  // with claude's own `model_not_found` error, which is the operator's
  // signal to fix the declaration.
  supportedModels?: readonly string[];
  /**
   * Test seam: invoked once per task with the caller-tools MCP server
   * handle immediately after the bridge stands one up (when the
   * openai-compat extension is active with `tools`). Used by unit tests
   * to drive `invokeForTest` against the exact server the spawn will
   * see, without going through a real MCP transport. Not part of the
   * public API — leave unset in production.
   */
  onCallerToolsMcpReady?: (server: CallerToolsMcpServer) => void;
  // Max time the startup probe (`resolveCapabilities`) waits for the
  // `system/init` event before giving up. Default 10000 ms — `claude`
  // startup can take 5s+ on an operator cwd loaded with hooks, skills,
  // MCP servers, or a large CLAUDE.md (auto-discovery still runs because
  // we deliberately *don't* use `--bare`: bare mode skips
  // user/project settings.json, including its `model` field, which would
  // make the probed model diverge from the model the real task spawn
  // actually loads). Set to 0 to disable the probe entirely — the daemon
  // then advertises only the operator-declared `supportedModels` (if any) without a
  // default entry, or no `params.models` at all, which is harmless (the
  // spec is advisory) but blinds clients that want to route by declared
  // model.
  probeTimeoutMs?: number;
  // When true, dump A2A `parts` shape + metadata keys + raw
  // `chat_history` to stderr on every task. Operator diagnostic exposed
  // via `--openai-compat-trace`. Leave off in production.
  openaiCompatTrace?: boolean;
  // When true, split the replayed `<chat_history>` into a frozen prefix
  // (carrying a `cache_control` breakpoint) plus a small tail, so the stable
  // history reads from Anthropic's prompt cache instead of re-billing every
  // turn. Opt-in via `--openai-compat-history-cache`: it relies on claude's
  // stream-json input forwarding caller `cache_control` (verified on the
  // pinned CLI, but undocumented), and shares the API's 4-breakpoint budget
  // with claude's own system/tools markers — a future CLI change to that
  // placement could push a request over the limit (a hard 400). Leave off
  // unless validated against the deployed claude version.
  openaiCompatHistoryCache?: boolean;
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
  // `subtype` + top-level `model` ride on the `system/init` event — the
  // session metadata claude emits first, before any turn. `model` is the
  // model claude actually resolved to run with (real model id; a routing
  // slug / A2A card url is dropped before reaching `--model`, so init
  // reports claude's resolved default, never the slug). Used as the
  // openai-compat envelope's model fallback when no assistant turn named one
  // (e.g. a result-only turn) (#348).
  subtype?: unknown;
  model?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    // Present on `assistant` events: the model that produced this turn's
    // user-facing content. This is the authoritative model id for the
    // openai-compat envelope — unlike `result.modelUsage`, which can be
    // dominated by an internal sub-model (e.g. haiku for title generation)
    // on short responses and so mislabel the envelope's `model` (#348).
    model?: unknown;
  };
  event?: unknown;
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

// Strip Claude Code's trailing tier suffix (e.g. `[1m]` for the 1M-context
// variant) from a model id. The suffix appears in `system/init.model` and
// `result.modelUsage` keys verbatim, but it is a Claude Code-specific
// notation (the CLI reads it off `--model` / `ANTHROPIC_MODEL` /
// settings.json `model` per-variable to pick a context tier); the
// canonical Anthropic API id is just `claude-opus-4-7` (or its dated
// form). Neither `@anthropic-ai/sdk` nor `@ai-sdk/anthropic` expose a
// normaliser, and the openai-compat/v1 spec is silent on id format, so
// this regex is the pragmatic option.
//
// Applied at both emission sites — the openai-compat/v1 `params.models[]`
// advertise (from `system/init`) and the `usage.model` echo (from
// `result.modelUsage`) — so the spec's "id SHOULD match usage.model"
// cross-check holds against the canonical form. Side-effect: the
// "running on the 1M tier" signal is dropped from the advertise; if a
// caller ever needs that, it should ride a forward-compat sub-field
// (e.g. `params.models[].contextWindow`), not the id itself.
//
// Exported for unit tests.
export function normalizeClaudeModelId(raw: string): string {
  return raw.replace(/\[[^\]]+\]$/, '');
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
//
// This computes token SUMS only — it does NOT pick a `model` label. The
// envelope's `model` is resolved by the caller from the model that actually
// answered (the `assistant` event) or the requested model id, not from a
// largest-output-share heuristic over `modelUsage` (which mislabels short
// responses — #348). The caller stamps the resolved id onto the returned
// usage so `usage.model` stays consistent with the envelope's top-level id.
export function parseClaudeModelUsageForOpenAICompat(raw: unknown): OpenAICompatUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let promptSum = 0;
  let completionSum = 0;
  let cacheReadSum = 0;
  let saw = false;
  for (const [, perModel] of Object.entries(raw as Record<string, unknown>)) {
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
    saw = true;
  }
  if (!saw) return null;
  return buildOpenAICompatUsage({
    prompt_tokens: promptSum,
    completion_tokens: completionSum,
    cached_tokens: cacheReadSum > 0 ? cacheReadSum : undefined,
  });
}

// Assemble a complete OpenAI ChatCompletion envelope for the openai-compat/v1
// envelope contract (oai2a2a#80). The codec on the gateway unwraps this
// verbatim, so we own every required field — id / object / created / model /
// choices / finish_reason / logprobs / usage. `id` is synthesized from the
// A2A task id (Claude Code does not expose a stable response id we can
// forward); `model` falls back to a placeholder when the run never reported
// modelUsage (e.g. an early-exit failure before any LLM round-trip). Mirrors
// `buildCodexChatCompletionEnvelope` in codex.ts so the two backends cannot
// drift on the response shape.
//
// `finishReason` is constrained to the values Claude Code can produce on this
// path: `tool_calls` when the model invoked a caller-side function tool,
// otherwise `stop`. Claude does not surface `length` or `refusal` through the
// stream-json transcript today, so we don't synthesize either — passing
// through whatever the SDK exposes when it gains the field is a future
// extension.
//
// Spec: extensions/openai-compat/v1/README.md#response-metadata-payload-agent--gateway
export function buildClaudeChatCompletionEnvelope(args: {
  taskId: string;
  model: string | undefined;
  content: string | null;
  toolCalls:
    | Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    | undefined;
  finishReason: 'stop' | 'tool_calls';
  usage: OpenAICompatUsage | null;
}): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: args.content };
  if (args.toolCalls && args.toolCalls.length > 0) {
    message.tool_calls = args.toolCalls;
  }
  const envelope: Record<string, unknown> = {
    id: `chatcmpl-claude-${args.taskId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: args.model ?? 'claude',
    choices: [
      {
        index: 0,
        message,
        finish_reason: args.finishReason,
        logprobs: null,
      },
    ],
  };
  if (args.usage) envelope.usage = args.usage;
  return envelope;
}

// Anthropic-shaped content block we send on stdin.
type InputContentBlock =
  | {
      type: 'text';
      text: string;
      // Optional prompt-cache breakpoint, passed through verbatim to the
      // Anthropic Messages API via claude's stream-json stdin. Only set on the
      // frozen `<chat_history>` prefix under the openai-compat history-cache
      // path (see openaiCompatHistoryCache).
      cache_control?: { type: 'ephemeral'; ttl?: '1h' | '5m' };
    }
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
    // Merge over (not replace) the inherited env so the child keeps the
    // daemon's environment and only the per-spawn overrides change.
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  }) as ChildProcess;
}

// Argv for the resolveCapabilities probe. Stream-json so `system/init`
// (the first non-rate-limit event, carrying the resolved `model`) lands
// as a parseable line we can read and bail out from before any LLM call
// is issued. We pass a minimal prompt because Claude Code rejects an
// empty `-p` argument — the probe SIGTERMs the child as soon as the
// init frame arrives, so the prompt is never actually sent to the API.
//
// Exported so tests can pin the exact argv the production resolveCapabilities
// expects, without coupling to a string literal in two places.
export const CLAUDE_PROBE_ARGS: readonly string[] = [
  '-p',
  'probe',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
];

// Spawn `claude` with stream-json output, read until the `system/init`
// event lands, capture its `model` field, and SIGTERM the child. Returns
// `null` on any failure (spawn error, timeout, malformed stream, child
// exits before init) so the caller can silently skip advertising.
//
// LLM cost: `system/init` is session metadata emitted before the model
// is called — see https://code.claude.com/docs/en/headless ("The
// system/init event reports session metadata including the model … It
// is the first event in the stream"). Killing the child at this stage
// produces no token usage. The rate_limit_event line that may precede
// it is also pre-LLM and is ignored here.
export async function probeClaudeModel(probeOpts: {
  command: string;
  spawn: ClaudeSpawnFn;
  cwd?: string;
  timeoutMs: number;
}): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let child: ClaudeChildHandle;
    try {
      child = probeOpts.spawn(probeOpts.command, CLAUDE_PROBE_ARGS, {
        ...(probeOpts.cwd ? { cwd: probeOpts.cwd } : {}),
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    // No `.unref()` here. The probe always settles via either the timeout,
    // a `system/init` line, or the child's close/error — and `settle()`
    // clears the timer in every path. Calling `.unref()` only matters if
    // the timer would otherwise outlive a daemon shutdown, but the probe
    // runs once at startup and is awaited; the `await` already prevents
    // any "linger after daemon exit" hazard. Worse, on Node's built-in
    // test runner an unref'd timer can let the event loop idle out while
    // the awaiting promise is still pending, which surfaces as
    // `Promise resolution is still pending but the event loop has
    // already resolved` and cancels the test plus everything after it
    // in the same file. See vicoop-bridge#282 for the failure mode.
    const timer = setTimeout(() => settle(null), probeOpts.timeoutMs);
    function settle(value: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      resolve(value);
    }
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (!evt || typeof evt !== 'object' || Array.isArray(evt)) continue;
        const e = evt as { type?: unknown; subtype?: unknown; model?: unknown };
        if (
          e.type === 'system' &&
          e.subtype === 'init' &&
          typeof e.model === 'string' &&
          e.model.length > 0
        ) {
          // Normalise here (and not at the resolveCapabilities caller) so
          // the function's contract — "returns the model id you'll see in
          // `usage.model`" — holds across both emission sites.
          const normalised = normalizeClaudeModelId(e.model);
          if (normalised.length === 0) {
            // The whole id was a bracketed tier marker — pathological,
            // but treat as no signal rather than advertise an empty id
            // and trip downstream zod min(1) checks.
            settle(null);
            return;
          }
          settle(normalised);
          return;
        }
      }
    });
    // stderr is intentionally not surfaced — the probe is best-effort and
    // a noisy `Notice:` from claude on a non-init code path should not
    // produce a log line on every daemon start.
    child.stderr?.on('data', () => {
      /* drain */
    });
    child.on('close', () => settle(null));
    child.on('error', () => settle(null));
  });
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

function extractClaudeStreamTextDelta(evt: StreamEvent): string {
  if (evt.type !== 'stream_event') return '';
  const event = evt.event;
  if (!event || typeof event !== 'object') return '';
  const e = event as { type?: unknown; delta?: unknown; content_block?: unknown };
  if (e.type === 'content_block_delta' && e.delta && typeof e.delta === 'object') {
    const delta = e.delta as { type?: unknown; text?: unknown };
    if (delta.type === 'text_delta' && typeof delta.text === 'string') return delta.text;
  }
  if (e.type === 'content_block_start' && e.content_block && typeof e.content_block === 'object') {
    const block = e.content_block as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
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


// Map the caller-provided OpenAI `tools` array (the wire shape used in
// OpenAI Chat Completions: `{ type: 'function', function: { name, description,
// parameters } }`) to `CallerToolDefinition[]` for `caller-tools-mcp`. Mirrors
// `openaiToolsToDynamicToolSpecs` on the codex backend (#212) byte-for-byte
// in its mapping rules — same dropped entries (no name, missing function
// envelope, unknown type) and same empty-object schema default for tools
// declared without `parameters`. Returns `null` when no usable entries
// remain so callers can branch off "no tools to register" without checking
// `length`.
// MCP server name the bridge registers the per-task caller-tools server
// under (`--mcp-config`). claude exposes that server's tools to the model as
// `mcp__${CALLER_TOOLS_MCP_SERVER}__<tool>` — e.g. `mcp___vb-caller-tools__read`
// (the leading `_` of the server name abuts the `mcp__` prefix, hence the
// triple underscore). Single source of truth so the registration and the
// chat_history name-qualification below cannot drift.
const CALLER_TOOLS_MCP_SERVER = '_vb-caller-tools';

// The id the model must use to call a caller tool under native MCP dispatch.
function callerToolMcpId(toolName: string): string {
  return `mcp__${CALLER_TOOLS_MCP_SERVER}__${toolName}`;
}

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
//   - How to read the `<chat_history>` block. Follow-up turns text-prepend
//     the tool-round-trip slice of chat_history (`formatChatHistory`)
//     because claude has no native equivalent of codex's
//     `thread/inject_items`. The model has to know the block is
//     authoritative and not to re-emit a call whose result is already
//     recorded. Prior plain user/assistant text turns ride the native
//     conversation surface (assistant-role messages prepended to
//     `contentBlocks`), not the block.
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
export function buildOpenAICompatNativeSystemPrompt(
  system: string | undefined,
  tools: unknown,
  toolChoice: unknown,
): string {
  const sections: string[] = [];
  if (system) sections.push(system);

  const toolChoiceIsNone = toolChoice === 'none';
  const hasTools = Array.isArray(tools) && tools.length > 0 && !toolChoiceIsNone;

  if (hasTools) {
    sections.push(
      [
        'You are routed through an OpenAI-compatible gateway. The caller has supplied function tools that appear in your native tool list — invoke them through your normal tool-use surface.',
        '',
        'The user message may begin with a <chat_history>...</chat_history> block holding a JSON array of the prior conversation: prior {"role":"user","content":"…"} and {"role":"assistant","content":"…"} text turns, plus {"role":"assistant","content":null,"tool_calls":[...]} for calls you previously emitted and {"role":"tool","tool_call_id":"call_…","name":"…","content":"…"} for the authoritative result of each call. Treat the block as the source of truth for what has happened so far — read it as prior conversation, not as a fresh instruction. Do not re-emit a call whose `tool_call_id` already has a recorded result.',
      ].join('\n'),
    );
    const tcDesc = describeToolChoice(toolChoice);
    if (tcDesc) sections.push(tcDesc);
  } else if (toolChoiceIsNone) {
    sections.push(
      'A list of OpenAI-style tools was supplied with tool_choice="none". Do not invoke any caller-provided tool; always answer in natural language.',
    );
  }

  // Never return an empty prompt. A bare chat-completion (no caller `system`,
  // no tools, and tool_choice !== "none") would otherwise leave `sections`
  // empty. Appending "" to claude's default prompt is harmless, but feeding
  // "" to `--system-prompt` would *replace* the default with nothing — so the
  // builder owns a neutral fallback here, keeping its output safe to use via
  // either `--append-system-prompt` or `--system-prompt`.
  if (sections.length === 0) {
    return DEFAULT_OPENAI_COMPAT_SYSTEM_PROMPT;
  }
  return sections.join('\n\n');
}

// Neutral base prompt for a bare openai-compat chat-completion turn that
// carries no caller `system` and no tools. Kept minimal and transport-flavoured
// (not a coding-agent persona) because the openai-compat path serves a generic
// chat/completions proxy, not Claude Code's interactive CLI.
export const DEFAULT_OPENAI_COMPAT_SYSTEM_PROMPT =
  'You are a helpful assistant accessed through an OpenAI-compatible gateway. Respond to the user directly in natural language.';


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

// Tool names that, on the wire, identify a Claude Code subagent
// invocation. The user-facing tool is "Task" in the docs and the
// interactive UI, but `claude -p --output-format stream-json` emits
// `name: "Agent"` in the assistant tool_use block (verified against
// claude 2.1.148). We accept both so the bookends stay correct if
// Claude Code renames the wire identifier in either direction.
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

// Pull the human-readable description out of a subagent tool's input
// object. Claude Code's Agent/Task tool accepts `{ description, prompt,
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
// matching tool_use_ids we previously registered as in-flight subagent
// runs. We pair each with a `claude-subagent-event` trace artifact so
// consumers see the subagent finished even though its output is packed
// into the tool_result fed back to the main agent rather than the
// assistant stream — and a text-only subagent result, which would not
// otherwise produce a `claude-tool-result` trace artifact, still gets
// a "completed" marker.
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
  // Isolation cwd for openai-compat spawns (see ClaudeBackendOptions). Resolved
  // lazily on first use and memoized — including the fallback to the operator
  // `cwd` if the dir can't be created — so a hostile temp root degrades to the
  // pre-isolation behaviour rather than failing the task.
  const openaiCompatCwd = opts.openaiCompatCwd ?? join(tmpdir(), 'vicoop-bridge-claude-oai');
  // `null` = not yet resolved; afterwards holds the dir to spawn in (or the
  // operator cwd / undefined on a creation failure).
  let openaiCompatCwdResolved: string | undefined | null = null;
  const extraArgs = opts.extraArgs ?? [];
  const spawnFn = opts.spawn ?? defaultSpawn;
  const stderrCap = opts.stderrCaptureBytes ?? 8192;
  const sessionTtlMs = opts.sessionTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const openaiCompatTrace = opts.openaiCompatTrace === true;
  const openaiCompatHistoryCache = opts.openaiCompatHistoryCache === true;
  const setIntervalImpl = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const timingLogger = createLogger();
  // Resolve (and create-on-first-use) the openai-compat isolation cwd. Memoized
  // so the mkdir runs at most once per backend; on failure we fall back to the
  // operator `cwd` and remember that so we don't retry-and-warn every task.
  const resolveOpenAICompatCwd = (): string | undefined => {
    if (openaiCompatCwdResolved !== null) return openaiCompatCwdResolved;
    try {
      mkdirSync(openaiCompatCwd, { recursive: true });
      openaiCompatCwdResolved = openaiCompatCwd;
    } catch (err) {
      timingLogger.warn?.(
        `[claude] openai-compat isolation cwd ${openaiCompatCwd} could not be created; falling back to operator cwd: ${errorMessage(err)}`,
      );
      openaiCompatCwdResolved = cwd;
    }
    return openaiCompatCwdResolved;
  };
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
  // Fold `--claude-model` into the resolved settings as its `model` field.
  // Merging here (rather than at the cli.ts layer) means an operator who
  // passes only `--claude-model` still keeps the DEFAULT_SETTINGS sandbox
  // guard above — a naive `{ model }` at the call site would have replaced
  // it. The flag wins over a `model` already present in operator settings.
  const resolvedSettings = opts.model
    ? { ...(opts.settings ?? DEFAULT_SETTINGS), model: opts.model }
    : (opts.settings ?? DEFAULT_SETTINGS);
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

  const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;

  // Operator-declared additional models (`opts.supportedModels`), deduped on the
  // normalized form — against each other and against the `--claude-model`
  // pin — so the advertise never carries the same canonical id twice.
  // Original (un-normalized) spellings are preserved for the advertise so an
  // operator declaring `claude-opus-4-8[1m]` advertises the tiered form they
  // asked for; normalization is applied only where ids are compared.
  const declaredModels: string[] = [];
  {
    const seen = new Set<string>();
    if (opts.model) seen.add(normalizeClaudeModelId(opts.model));
    for (const raw of opts.supportedModels ?? []) {
      const id = raw.trim();
      if (!id) continue;
      const norm = normalizeClaudeModelId(id);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      declaredModels.push(id);
    }
  }

  // Advertised-model cache, populated by `resolveCapabilities` at daemon
  // startup and read sync from `handle()` to gate `envelope.model`
  // forwarding (#302). Ids are stored normalized (tier suffix stripped) so
  // the gate's membership check is canonical-form on both sides.
  // `undefined` = "never probed", `null` = "probed but unavailable",
  // Set = "these are the model ids this claude install advertises".
  // `handle()` deliberately does NOT trigger the probe on a miss — the
  // probe spawns its own short-lived child, and the daemon already calls
  // `resolveCapabilities` once at startup, so the cache is populated before
  // any task lands in production. Tests that want to exercise the gate
  // populate the cache via `resolveCapabilities` explicitly.
  //
  // A `--claude-model` pin (and any `--claude-supported-models` declarations) seeds
  // the cache directly: the pin IS the advertised default (every spawn
  // loads it via settings.model), so it must be what the `envelope.model`
  // gate compares against. Without this seed the probe — which deliberately
  // runs WITHOUT our `--settings` (see `CLAUDE_PROBE_ARGS`) — would report
  // claude's *unpinned* default, the gateway would route by that default,
  // and the matching `--model <default>` argv would then override the pin
  // on the spawn (CLI `--model` beats settings.model). Seeding here holds
  // the pin even if `resolveCapabilities` never runs.
  const seededModelIds = [
    ...(opts.model ? [opts.model] : []),
    ...declaredModels,
  ].map(normalizeClaudeModelId);
  let cachedAllowedModels: Set<string> | null | undefined =
    seededModelIds.length > 0 ? new Set(seededModelIds) : undefined;

  return {
    name: 'claude',

    getSendFileMcpServer: () => sendFileMcp,

    // Advertise the underlying model via the openai-compat/v1
    // `params.models[]` slot (planetarium/oai2a2a#63) so A2A callers can
    // route by declared model before the first task lands. The probe
    // spawns `claude` with stream-json output, reads the `system/init`
    // line, captures `model`, and SIGTERMs — no LLM call is made.
    // Any failure (timeout, missing binary, malformed stream) returns
    // `{}` and the card's declared capabilities are left untouched.
    //
    // `reasoning` is not set: Claude Code does not currently emit
    // `completion_tokens_details.reasoning_tokens` in `usage`, and per
    // spec "Absence means 'unspecified,' not 'false.'"
    async resolveCapabilities() {
      // A pinned model is authoritative — there's nothing to discover, so
      // skip the probe spawn entirely (it can't see our `--settings` anyway)
      // and advertise the pin (plus any operator-declared extra models),
      // which the construction-time seed already put in
      // `cachedAllowedModels`.
      if (opts.model) {
        return {
          openaiCompatModels: [
            { id: opts.model, default: true },
            ...declaredModels.map((id) => ({ id })),
          ],
        };
      }
      if (probeTimeoutMs <= 0) {
        // No probe means no discovered default; operator-declared models
        // (if any) are still advertised — without a `default: true` entry,
        // which the spec allows (`default` is optional).
        cachedAllowedModels =
          declaredModels.length > 0
            ? new Set(declaredModels.map(normalizeClaudeModelId))
            : null;
        return declaredModels.length > 0
          ? { openaiCompatModels: declaredModels.map((id) => ({ id })) }
          : {};
      }
      const model = await probeClaudeModel({
        command,
        spawn: spawnFn,
        cwd,
        timeoutMs: probeTimeoutMs,
      });
      // The probed default may collide with a declared extra (the
      // construction-time dedupe can only see the pin); drop the duplicate
      // declaration so the advertise stays one-entry-per-canonical-id.
      const extras = declaredModels.filter(
        (id) => model === null || normalizeClaudeModelId(id) !== model,
      );
      const allowed = new Set([
        ...(model ? [model] : []),
        ...extras.map(normalizeClaudeModelId),
      ]);
      cachedAllowedModels = allowed.size > 0 ? allowed : null;
      const entries: OpenAICompatModelAdvertise[] = [
        ...(model ? [{ id: model, default: true }] : []),
        ...extras.map((id) => ({ id })),
      ];
      return entries.length > 0 ? { openaiCompatModels: entries } : {};
    },

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

      // Envelope-direct (#302): read the full inbound OpenAI Chat Completions
      // request body off `metadata[URI].chat_completions_request` and project
      // system / tools / tool_choice / chat_history / model directly off the
      // envelope. Absent or malformed metadata leaves the run on the
      // original non-extension code path with no envelope-detection cost.
      const envelope = parseOpenAICompatEnvelope(task.message.metadata);
      if (openaiCompatTrace) {
        dumpOpenAICompatTaskWire(
          'claude',
          task.taskId,
          task.message.parts,
          task.message.metadata,
        );
      }
      const envelopeSystem = envelope
        ? collectSystemFromMessages(envelope.messages)
        : undefined;
      const envelopeTools = Array.isArray(envelope?.tools) && envelope.tools.length > 0
        ? envelope.tools
        : undefined;
      const envelopeToolChoice = envelope?.tool_choice;
      const envelopeChatHistory =
        envelope && Array.isArray(envelope.messages)
          ? chatHistoryFromMessages(envelope.messages)
          : null;
      const envelopeModelRaw =
        envelope && typeof envelope.model === 'string' && envelope.model.length > 0
          ? envelope.model
          : undefined;
      // Validate against the advertised model ids (cached by
      // `resolveCapabilities` from the probe, the `--claude-model` pin, and
      // any `--claude-supported-models` declarations). When the gateway sends a value
      // claude doesn't advertise — e.g. an unresolved routing key like
      // `a2a/<card-url>` — drop the override so claude falls back to its own
      // default rather than failing the turn (#302). Membership is checked
      // on the normalized (tier-suffix-stripped) form so a caller requesting
      // `claude-opus-4-8[1m]` matches an advertised `claude-opus-4-8`; the
      // raw inbound value still rides to the spawn so the tier selection
      // survives. When the cache is unpopulated (probeTimeoutMs ≤ 0 with no
      // declared models, probe failed, or `resolveCapabilities` hasn't been
      // called yet) the validation is skipped and `envelope.model` rides
      // through unchanged.
      let envelopeModel: string | undefined = envelopeModelRaw;
      if (
        envelopeModelRaw !== undefined &&
        cachedAllowedModels instanceof Set &&
        !cachedAllowedModels.has(normalizeClaudeModelId(envelopeModelRaw))
      ) {
        timingLogger.warn?.(
          `[claude] envelope.model=${JSON.stringify(envelopeModelRaw)} is not among this claude install's advertised models (${JSON.stringify([...cachedAllowedModels])}); falling back to claude default`,
        );
        envelopeModel = undefined;
      }

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
        envelopeTools && callerToolDispatchActive(envelopeTools, envelopeToolChoice)
          ? openaiToolsToCallerToolDefs(envelopeTools)
          : null;
      const nativeDispatchActive = callerToolDefs !== null;
      // Registered caller-tool names, used to qualify matching references in
      // the replayed chat_history to their live MCP ids (see the history
      // projection below). Empty on the non-native path.
      const callerToolNameSet = new Set(
        (callerToolDefs ?? []).map((d) => d.name),
      );

      const mappedRaw = await mapPartsToContentBlocks(task.message.parts, opts.fetchUriPolicy, signal);
      recorder.mark('map');

      // Tool-continuation edge case (openai-compat spec): the inbound
      // OpenAI request ends with `assistant.tool_calls` + `tool` rather
      // than a user turn, so the gateway emits A2A `parts` as
      // `[{ text: "" }]` and stuffs the whole sequence into
      // `chat_history`. `mapPartsToContentBlocks` returns
      // `empty_prompt` on those parts; tolerate it when the history
      // carries entries that will end up as the user content.
      const hasHistory = (envelopeChatHistory?.length ?? 0) > 0;
      const isToolContinuation =
        !mappedRaw.ok &&
        mappedRaw.code === 'empty_prompt' &&
        hasHistory;
      if (!mappedRaw.ok && !isToolContinuation) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: mappedRaw.code, message: mappedRaw.message },
        });
        return;
      }
      const mapped: {
        ok: true;
        blocks: InputContentBlock[];
        inboundHashes: Set<string>;
      } = mappedRaw.ok
        ? mappedRaw
        : { ok: true, blocks: [], inboundHashes: new Set() };

      if (envelopeChatHistory) {
        // Spec contract: bridges MUST replay the entire `chat_history`
        // in order. We render it as a single `<chat_history>` JSON
        // block (every entry — text turns AND tool round-trips —
        // verbatim from the wire) and prepend it to the final user
        // content so the model reads the prior conversation BEFORE the
        // current user turn.
        //
        // Why not split text turns into native stream-json envelopes:
        // claude's stream-json input treats every `{type:"user"}`
        // envelope as a fresh LLM call, and the matching
        // `{type:"assistant"}` envelopes are ignored rather than
        // recognised as prior model output. Sending N user envelopes
        // produces N separate assistant results, not one assistant
        // turn over a multi-turn conversation. Folding everything into
        // a single user message via this block is the only way to give
        // the model the conversation in one shot on this backend.
        //
        // Under native MCP dispatch (#213) the caller's tools are live as
        // `mcp___vb-caller-tools__<name>`, but the wire history records each
        // prior call by its bare OpenAI name (e.g. `read`). Replaying the bare
        // name conditions the model to re-emit it, and claude then rejects the
        // call ("No such tool available: read") — it never reaches the
        // caller-tools MCP (so it isn't captured), the model retries, and the
        // run dies at `--max-turns 1`. Qualify the history names to the live
        // MCP ids so the model's historical view matches its tool list. Only
        // names that are actually registered caller tools are rewritten;
        // everything else (and the non-native path, where callerToolDefs is
        // null) passes through untouched.
        const projectedHistory = callerToolDefs
          ? requalifyHistoryToolNames(envelopeChatHistory, (name) =>
              callerToolNameSet.has(name) ? callerToolMcpId(name) : name,
            )
          : envelopeChatHistory;
        // One block by default; under `--openai-compat-history-cache` the
        // frozen prefix is split out with a `cache_control` breakpoint so it
        // reads from Anthropic's prompt cache instead of re-billing every turn.
        // Concatenating the pieces is byte-identical to the single-block form,
        // so the model reads the same `<chat_history>` regardless.
        const historyBlocks = formatChatHistoryBlocks(projectedHistory, {
          split: openaiCompatHistoryCache,
        });
        const inputHistoryBlocks: InputContentBlock[] = historyBlocks.map((b) =>
          b.cache
            ? {
                type: 'text',
                text: b.text,
                // 1h TTL to match the system/tools breakpoints claude itself
                // sets under ENABLE_PROMPT_CACHING_1H — the API rejects a 5m
                // block ordered after a 1h one (tools → system → messages).
                cache_control: { type: 'ephemeral', ttl: '1h' },
              }
            : { type: 'text', text: b.text },
        );
        // unshift preserves order: [frozen, tail, ...live content blocks].
        if (inputHistoryBlocks.length) {
          mapped.blocks.unshift(...inputHistoryBlocks);
        }
      }

      // Final guard: a request with no text/files AND no history would
      // mint an envelope with zero content blocks. Claude rejects
      // those; surface the original empty_prompt to the caller.
      if (mapped.blocks.length === 0) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: 'empty_prompt', message: 'no content in message' },
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
      // prepended `<chat_history>` JSON block carrying the caller's real
      // tool results). Skip the session map entirely for openai-compat tasks so
      // every spawn starts on a clean `--session-id`; the history block in
      // the user message is then the unambiguous source of truth.
      const sessionReuseEligible = envelope === null && sessionTtlMs > 0;
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
      // `status.message.parts` — the terminal `chat_completion` envelope
      // (oai2a2a#80) is the complete output for this turn, matching OpenAI
      // Chat Completions' `finish_reason: "tool_calls"` semantics (the same
      // invariant codex backend enforces on its native path, see #212).
      let capturedToolCall = false;
      // OpenAI Chat Completions tool_calls accumulated from caller-tools MCP
      // invocations during this turn. Surfaced to the gateway via the
      // terminal `chat_completion` envelope on
      // `status.message.metadata[OPENAI_COMPAT_EXTENSION_URI]` per the
      // openai-compat/v1 envelope contract (oai2a2a#80). Replaces the legacy
      // data-part `tool_calls` artifact this backend used to emit.
      const capturedToolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];

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
              // Envelope contract (oai2a2a#80): tool_calls flow exclusively
              // through the terminal `chat_completion` envelope metadata —
              // NOT as a data-part artifact. Accumulate here; the terminal
              // block below builds the envelope from `capturedToolCalls` and
              // stamps it on `status.message.metadata`. OpenAI Chat
              // Completions requires `arguments` as a JSON-encoded string;
              // the MCP transport hands us a parsed JSON value, so we
              // stringify here for spec compliance (mirrors codex.ts's
              // capture path).
              const argsString =
                typeof invocation.arguments === 'string'
                  ? invocation.arguments
                  : JSON.stringify(invocation.arguments ?? {});
              capturedToolCalls.push({
                id: invocation.callId,
                type: 'function',
                function: {
                  name: invocation.toolName,
                  arguments: argsString,
                },
              });
              capturedToolCall = true;
              // The actual tool result is the caller's job — it arrives on
              // the next A2A turn via `chat_history`. Returning a
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
            error: normalizeTaskFailError({
              code: 'caller_tools_mcp_start_failed',
              message: `caller-tools MCP server failed to start: ${errorMessage(err)}`,
            }),
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

      // Per-task `--system-prompt` carrying the openai-compat extension's
      // system / tools / tool_choice. We *replace* claude's default agent
      // prompt (rather than `--append-system-prompt`-ing onto it) for two
      // reasons:
      //   - Cost: every openai-compat task spawns a fresh session (no reuse),
      //     so claude's multi-thousand-token coding-agent base prompt is
      //     re-paid on each request. Replacing it with this slim, caller-
      //     scoped prompt removes that fixed per-request overhead.
      //   - Correctness: the openai-compat path is a generic chat/completions
      //     proxy, not Claude Code's interactive CLI — the default persona
      //     (TodoWrite, file-edit conventions, CLI verbosity) is off-target.
      // Tool use is native to the model, not taught by the default prompt, so
      // native MCP dispatch is unaffected. `buildOpenAICompatNativeSystemPrompt`
      // never returns "" (it owns a neutral fallback), so the replacement is
      // always a non-empty base. Identity (`identityArgs`) and operator
      // `extraArgs` still ride `--append-system-prompt`, which claude appends
      // onto this base; note the base is therefore the model's first read,
      // ahead of any appended identity directive (a change from the prior
      // append-only ordering, immaterial on the stateless proxy turn).
      const openaiCompatArgs: readonly string[] = envelope
        ? [
            '--system-prompt',
            buildOpenAICompatNativeSystemPrompt(
              envelopeSystem,
              envelopeTools,
              envelopeToolChoice,
            ),
          ]
        : [];
      // Trim the cold-start overhead for openai-compat tasks. Every such task
      // spawns a fresh claude session (no reuse — see the gate above), so any
      // fixed per-request context is re-paid each time. `--disable-slash-commands`
      // drops the skills catalogue: the served backend never invokes skills
      // under openai-compat (the caller drives tool use), so the listing is dead
      // weight here. Auth-neutral, unlike `--bare`, so the operator's OAuth login
      // still works.
      //
      // Note we do NOT pass `--exclude-dynamic-system-prompt-sections`: it only
      // applies to claude's default system prompt and is ignored once we replace
      // that prompt via `--system-prompt` (see openaiCompatArgs above), which
      // already carries no per-machine dynamic sections. CLAUDE.md auto-discovery
      // can only be disabled via `--bare` (API-key auth only — out of reach under
      // OAuth), so it stays loaded.
      const leanContextArgs: readonly string[] = envelope
        ? ['--disable-slash-commands']
        : [];
      // Forward `envelope.model` to claude via `--model <id>` so the gateway-
      // resolved model id wins over claude's own default (#302). Sticky for
      // the spawn; per-task because every openai-compat task always spawns
      // fresh (no session reuse — see the gate above).
      const modelArgs: readonly string[] = envelopeModel
        ? ['--model', envelopeModel]
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
      const disableBuiltinToolArgs: readonly string[] = callerToolDispatchActive(
        envelopeTools,
        envelopeToolChoice,
      )
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
        mcpServers[CALLER_TOOLS_MCP_SERVER] = { type: 'http', url: callerToolsMcp.url };
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
        ...modelArgs,
        ...openaiCompatArgs,
        ...leanContextArgs,
        ...disableBuiltinToolArgs,
        ...nativeTurnCapArgs,
        '--include-partial-messages',
        ...settingsArgs,
        ...extraArgs,
      ];

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      // openai-compat tasks spawn in the isolation cwd (no operator CLAUDE.md /
      // project settings / hooks); plain A2A tasks keep the operator cwd.
      const effectiveCwd = envelope ? resolveOpenAICompatCwd() : cwd;

      // Opt openai-compat spawns into Anthropic's 1-hour extended prompt cache.
      // These turns are stateless (fresh session each time) and a conversation
      // often pauses for minutes between user turns, so the default 5-min cache
      // can lapse between turns even though our system+tools prefix is byte-
      // stable. The 1h cache keeps that prefix warm across longer gaps. Claude
      // Code reads this only from the environment (no CLI flag), so we set it on
      // the child process — scoped to openai-compat; plain A2A tasks keep the
      // 5-min default. Trade-off: a 1h cache *write* costs 2x base (vs 1.25x for
      // 5m), paid once per prefix; reads stay 0.1x, so it wins whenever the
      // prefix is reused at all within the hour.
      const effectiveEnv = envelope
        ? { ENABLE_PROMPT_CACHING_1H: '1' }
        : undefined;

      let child: ClaudeChildHandle;
      try {
        timingLogger.debug(
          `claude.spawn.start taskId=${safeToken(task.taskId)} command=${safeToken(command)} cwd=${effectiveCwd ? safeToken(effectiveCwd) : '<default>'} argv=${safeToken(JSON.stringify(args), 8000)}`,
        );
        child = spawnFn(command, args, { cwd: effectiveCwd, env: effectiveEnv });
        recorder.mark('spawn');
      } catch (err) {
        rollbackFreshSession();
        await closeCallerToolsMcp();
        timingLogger.debug(
          `claude.spawn.error taskId=${safeToken(task.taskId)} command=${safeToken(command)} cwd=${effectiveCwd ? safeToken(effectiveCwd) : '<default>'} argv=${safeToken(JSON.stringify(args), 8000)} error=${safeToken(errorMessage(err), 1000)}`,
        );
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: normalizeTaskFailError({ code: 'spawn_failed', message: errorMessage(err) }),
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
          error: normalizeTaskFailError({
            code: 'spawn_no_stdin',
            message: 'spawned claude has no stdin pipe; cannot deliver user message',
          }),
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
      // Explicit widening type — without this TS infers a too-narrow type
      // through the `if (parsed) finalUsage = parsed;` assignment when
      // `parseClaudeModelUsageForOpenAICompat` returns `OpenAICompatUsage | null`,
      // because the only assignment site narrows out the `null` branch and
      // later flow analysis collapses the type. Mirrors codex.ts's
      // `finalUsage` declaration for the same reason.
      let finalUsage: OpenAICompatUsage | null = null as OpenAICompatUsage | null;
      // The model id reported on `assistant` events — the model that actually
      // produced the user-facing turn. Preferred over the `result.modelUsage`
      // heuristic for the openai-compat envelope's `model` field (#348): on
      // short responses an internal sub-model (haiku for title generation) can
      // out-produce the response model in token count, so the largest-output
      // heuristic mislabels the envelope. The assistant event names the right
      // model directly. Last writer wins — under `--max-turns 1` there is a
      // single response turn.
      let assistantModel: string | null = null;
      // The model claude resolved to run with, from the `system/init` event.
      // Fallback for the envelope's `model` when no assistant turn named one
      // (e.g. a result-only turn). Always a real model id — a routing slug /
      // A2A card url in the request is dropped before reaching `--model`, so
      // init reports claude's resolved default rather than the slug (#348).
      let initModel: string | null = null;
      let responseArtifactId: string | null = null;
      let streamedResponseText = '';
      let sawCompletedResult = false;
      let sawErrorResult = false;
      // Set when a tool_result comes back as claude's "No such tool available:
      // <name>" error. Under native dispatch this is the signature of a
      // tool-name mismatch — the model called a tool by a name claude doesn't
      // expose (usually the bare OpenAI name when it should use the
      // `mcp___vb-caller-tools__<name>` id). The call never reaches the
      // caller-tools MCP, so it isn't captured, and the model burns the
      // `--max-turns 1` budget retrying. fix #1 (history name qualification)
      // should prevent it; this flag lets the terminal failure say WHY rather
      // than surfacing a bare `claude_exit_nonzero`.
      let sawUnknownToolError = false;
      let stdoutTail = '';
      let stderrTail = '';
      let aborted = false;
      let settled = false;
      const emitTraceArtifacts = traceabilityRequested(task);
      // tool_use_id → description for in-flight subagent runs.
      // Populated when an `Agent`/`Task` tool_use is observed (and
      // traceability is opted-in); drained when the matching
      // tool_result returns so we can pair the start with a
      // completed/failed bookend in the trace stream. Outside trace
      // mode it stays empty — see the assistant handler below.
      const activeTaskRuns = new Map<string, string>();
      const seenAssistantToolUseIds = new Set<string>();

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

      const emitAssistantArtifact = (text: string, append = false, lastChunk = true): void => {
        if (!text) return;
        responseArtifactId ??= randomUUID();
        // openai-compat caller tools surface via the terminal
        // `chat_completion` envelope (oai2a2a#80) on the final A2A status
        // message, NOT as any in-stream artifact. Assistant-text turns
        // (natural-language answers, or any turn from a task that didn't
        // request the extension) are emitted unchanged as a `text` part
        // artifact for A2A debuggability and non-OpenAI consumers.
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: responseArtifactId,
            name: 'claude-message',
            parts: [{ kind: 'text', text }],
          },
          ...(append ? { append: true } : {}),
          lastChunk,
        });
        emittedAnyArtifact = true;
      };

      const emitAssistantTextUpdate = (text: string): void => {
        if (!text) return;
        if (!streamedResponseText) {
          streamedResponseText = text;
          emitAssistantArtifact(text, true, false);
          return;
        }
        if (text.startsWith(streamedResponseText)) {
          const delta = text.slice(streamedResponseText.length);
          streamedResponseText = text;
          emitAssistantArtifact(delta, true, false);
          return;
        }
        responseArtifactId = null;
        streamedResponseText = text;
        emitAssistantArtifact(text, false, true);
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

      // Surface a subagent lifecycle event as a `claude-subagent-event`
      // trace artifact. Mirrors the `claude-tool-call` /
      // `claude-tool-result` shape (text summary + structured `data`
      // part + `extensions: [TRACEABILITY_EXTENSION_URI]` +
      // `metadata.traceType`) so it sits alongside them under the same
      // opt-in. The lifecycle pair adds value over `claude-tool-call`
      // alone because text-only subagent results don't otherwise
      // produce a `claude-tool-result` artifact — without this, trace
      // consumers see "Agent started" but never a matching "finished".
      const emitSubagentEventArtifact = (
        event: 'subagent-started' | 'subagent-completed' | 'subagent-failed',
        toolUseId: string,
        description: string,
      ): void => {
        if (!emitTraceArtifacts) return;
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
            name: 'claude-subagent-event',
            parts: [
              { kind: 'text', text: `Task ${verb}: ${label}` },
              { kind: 'data', data: { event, toolUseId, description: label } },
            ],
            extensions: [TRACEABILITY_EXTENSION_URI],
            metadata: { traceType: 'subagent-event', event, toolUseId },
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
        if (openaiCompatTrace) {
          const textLen =
            evt.type === 'assistant'
              ? extractAssistantText(evt.message?.content).length
              : evt.type === 'stream_event'
                ? extractClaudeStreamTextDelta(evt).length
              : evt.type === 'result' && typeof evt.result === 'string'
                ? evt.result.length
                : undefined;
          console.error(
            `[openai-compat trace] claude event type=${evt.type}` +
              (textLen !== undefined ? ` textLen=${textLen}` : ''),
          );
        }
        if (evt.type === 'system' && evt.subtype === 'init') {
          // Record claude's resolved model for the openai-compat envelope
          // fallback (#348). Normalised to drop the `[1m]` tier suffix so it
          // matches the advertised id form and `usage.model`.
          if (typeof evt.model === 'string' && evt.model.length > 0) {
            const normalised = normalizeClaudeModelId(evt.model);
            if (normalised.length > 0) initModel = normalised;
          }
          return;
        }
        if (evt.type === 'stream_event') {
          const delta = extractClaudeStreamTextDelta(evt);
          if (delta && !emittedAskUserQuestion) {
            recorder.mark('firstAssistant');
            streamedResponseText += delta;
            emitAssistantArtifact(delta, true, false);
          }
          return;
        }
        if (evt.type === 'assistant') {
          if (evt.message?.role !== 'assistant') return;
          recorder.mark('firstAssistant');
          // Record the model that produced this turn for the openai-compat
          // envelope (#348). Normalised to drop CC's `[1m]` tier suffix so it
          // matches the advertised model id and `usage.model`.
          if (typeof evt.message.model === 'string' && evt.message.model.length > 0) {
            assistantModel = normalizeClaudeModelId(evt.message.model);
          }
          // A single assistant turn can interleave plain text and tool_use
          // blocks. Emit the text (if any) first so observers see "what the
          // model said" before "what tools it then called", matching the
          // visible CLI ordering inside that turn.
          if (!emittedAskUserQuestion) {
            emitAssistantTextUpdate(extractAssistantText(evt.message.content));
          }
          if (emittedAskUserQuestion) return;
          for (const tu of extractAssistantToolUses(evt.message.content)) {
            if (tu.toolUseId) {
              if (seenAssistantToolUseIds.has(tu.toolUseId)) continue;
              seenAssistantToolUseIds.add(tu.toolUseId);
            }
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
              // Pair subagent tool_use blocks with their tool_result via
              // a `claude-subagent-event` lifecycle artifact so trace
              // consumers see a clean "Agent started / completed"
              // bookend alongside the raw `claude-tool-call` summary —
              // text-only subagent results don't fire a
              // `claude-tool-result`, so without this pair they'd see
              // "started" with no matching "finished". Both sides ride
              // the same traceability opt-in; skip registry tracking
              // entirely when trace is off.
              if (
                emitTraceArtifacts &&
                SUBAGENT_TOOL_NAMES.has(tu.toolName) &&
                tu.toolUseId
              ) {
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
          // Tool-name-mismatch detection (native dispatch): a tool_result of
          // "No such tool available: <name>" means the model called a tool id
          // claude doesn't expose. Flag it so the terminal failure can explain
          // the cause instead of a bare exit-nonzero. Cheap substring scan over
          // the tool_result text; only meaningful on the native path but
          // harmless elsewhere.
          if (!sawUnknownToolError && nativeDispatchActive) {
            const content = evt.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                const b = block as { type?: unknown; content?: unknown };
                if (b.type !== 'tool_result') continue;
                const text =
                  typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                if (text.includes('No such tool available')) {
                  sawUnknownToolError = true;
                  break;
                }
              }
            }
          }
          // Pair subagent completions back to the start events emitted
          // above. The registry is only populated when trace is on (see
          // the assistant handler above), so this loop is a no-op when
          // trace is off — the size check just avoids walking content
          // arrays in that path.
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

      // Flush any trailing line without a newline. claude normally terminates
      // each event with \n but recent CC builds can flush the final `result`
      // event without a trailing newline and exit. This MUST run before
      // `settled = true` — `handleEvent` returns early when `settled` is
      // set, and a swallowed trailing `result` event leaves
      // `sawCompletedResult` false, which then collapses the otherwise-
      // legitimate "exit 1 after completed result" case into a
      // `claude_exit_nonzero` failure.
      const trailing = stdoutBuf.trim();
      if (trailing) {
        try {
          handleEvent(JSON.parse(trailing) as StreamEvent);
        } catch {
          // ignore
        }
      }

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
          error: normalizeTaskFailError({ code: 'spawn_failed', message: errorMessage(exit.error) }),
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
        // Tool-name-mismatch diagnostic: a max_turns exit preceded by "No such
        // tool available" almost always means the model called a caller tool
        // by an id claude doesn't expose. Spell out the proximate cause so the
        // failure isn't an inscrutable exit-1 (fix #1 should keep this from
        // happening, but a model can still invent an unregistered name).
        const toolMismatchPart = sawUnknownToolError
          ? ' [hint: model called a tool name claude does not expose ("No such tool available"); caller tools are registered as mcp___vb-caller-tools__<name> — the call was never captured and the turn cap was exhausted retrying]'
          : '';
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: normalizeTaskFailError({
            code: 'claude_exit_nonzero',
            message: `claude exited with code ${exit.code}${sigPart}${detailPart}${stdoutPart}${stdinPart}${toolMismatchPart}`,
          }),
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
      // the terminal `chat_completion` envelope (assembled below) is the
      // complete task output. Any wrap-up text the model produced before
      // exiting the turn (the system-prompt directive tells it to stop, but
      // models occasionally emit a brief acknowledgement anyway) is
      // reasoning preamble and must NOT be re-stamped on
      // `status.message.parts` — same invariant codex backend enforces
      // under PR #212, same root-cause concern as #200.
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
      } else if (streamedResponseText && completeText.startsWith(streamedResponseText)) {
        emitAssistantArtifact(completeText.slice(streamedResponseText.length), true, true);
      }

      // Envelope response contract (oai2a2a#80): emit a complete OpenAI
      // ChatCompletion envelope under
      // `metadata[OPENAI_COMPAT_EXTENSION_URI].chat_completion` on the final
      // A2A message of this turn. The codec unwraps the envelope verbatim,
      // so we own id / created / model / choices / usage. When the
      // openai-compat extension wasn't on the request at all we skip the
      // envelope (no advertising consumer to feed it) but still emit the
      // bare `usage` payload when claude reported one — preserves the
      // pre-envelope behaviour for plain claude tasks. Mirrors codex.ts's
      // emit pattern via the shared `buildOpenAICompatResponseMetadata`
      // helper so claude and codex cannot drift on the wire shape.
      const finishReason: 'tool_calls' | 'stop' =
        capturedToolCalls.length > 0 ? 'tool_calls' : 'stop';
      const assistantContent = capturedToolCalls.length > 0 ? null : completeText;
      // Resolve the response model (#348). Both sources come from claude
      // itself and are always real model ids, in order: (1) the model the
      // `assistant` turn reported — the model that actually produced the
      // answer; (2) the `system/init` model — claude's resolved model — used
      // when no assistant event named one (e.g. claude emitted only a `result`
      // event). We deliberately do NOT fall back to the requested
      // `envelope.model`: that is the caller's request, which may be a routing
      // slug or an A2A card url (dropped before reaching `--model`, #302), not
      // a real model id. The old `modelUsage` largest-output-share heuristic is
      // gone — it mislabelled short responses with an internal sub-model (haiku
      // for title generation). When neither source is available the envelope
      // falls back to its `'claude'` placeholder.
      const responseModel = assistantModel ?? initModel ?? undefined;
      // Stamp the resolved id onto the usage so `usage.model` stays consistent
      // with the envelope's top-level `model` (the spec's "id SHOULD match
      // usage.model" cross-check). The token *sums* are untouched — they
      // remain the across-sub-model totals from `modelUsage`.
      const envelopeUsage =
        finalUsage && responseModel ? { ...finalUsage, model: responseModel } : finalUsage;
      const responseEnvelope = envelope
        ? buildClaudeChatCompletionEnvelope({
            taskId: task.taskId,
            model: responseModel,
            content: assistantContent,
            toolCalls: capturedToolCalls.length > 0 ? capturedToolCalls : undefined,
            finishReason,
            usage: envelopeUsage,
          })
        : undefined;

      // The bare `usage` path (no envelope) gets the same model stamp so plain
      // A2A telemetry consumers see the response model whenever one was
      // resolved (#348).
      const messageMetadata = buildOpenAICompatResponseMetadata(responseEnvelope, envelopeUsage);
      // When parts is empty but we have envelope/usage to convey, still
      // emit the message frame so the metadata reaches the gateway.
      const hasMessage = parts.length > 0 || messageMetadata !== undefined;
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
