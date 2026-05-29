import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  type Part,
} from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { createLogger, type Logger } from '../logger.js';
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
  buildOpenAICompatUsage,
  type OpenAICompatUsage,
} from './openai-compat-usage.js';

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

export interface VicoopCodexBackendOptions {
  // Test seams only — the production CLI calls `createVicoopCodexBackend()`
  // with no arguments. We don't expose operator-facing knobs here because
  // anything an operator could set would have to ride through the existing
  // CLI / config surface, and we are not extending that surface for this
  // backend. Defaults below cover the production path; tests inject
  // `spawn` / `logger` / timing overrides.
  command?: string;
  cwd?: string;
  extraArgs?: readonly string[];
  spawn?: VicoopCodexSpawnFn;
  stderrCaptureBytes?: number;
  callTimeoutMs?: number;
  // Max time the startup probe (`vicoop-codex models --json` via
  // `resolveCapabilities`) waits for the model list before giving up.
  // Setting to 0 disables the probe entirely — the agent card carries no
  // declared models and `envelope.model` validation is skipped. Default
  // 10s mirrors claude's probeTimeoutMs.
  probeTimeoutMs?: number;
  logger?: Logger;
  // When true, dump A2A `parts` shape + metadata keys + raw
  // `chat_history` to stderr on every task. Operator diagnostic exposed
  // via `--openai-compat-trace`. Leave off in production.
  openaiCompatTrace?: boolean;
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

// Parsed OpenAI Chat Completions non-streaming response (the shape
// `vicoop-codex call` prints to stdout). All optional / nullable
// per OpenAI — the binary always emits `id` / `object` / `model` / `choices`
// but we tolerate missing fields rather than crash on a future schema bump.
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
// Nothing else is forwarded. `reasoning_effort`, `parallel_tool_calls`,
// and every Group B / Group C parameter from the call command's input doc
// are left unset — the vicoop-codex binary applies its own defaults.
export function buildCallBody(
  envelope: OpenAICompatRequestEnvelope | null,
  messages: ChatCompletionMessage[],
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
  return body;
}

// Map `vicoop-codex call` exit codes (doc's "Exit codes" section) to A2A
// task.fail error codes. Anything outside the documented set surfaces as
// `vicoop_codex_failed` so an operator can grep stderr without needing to
// memorise the table.
function exitCodeToA2ACode(code: number | null): string {
  switch (code) {
    case 2:
      return 'invalid_input';
    case 3:
      return 'login_required';
    case 4:
      return 'upstream_error';
    case 5:
      return 'network_error';
    default:
      return 'vicoop_codex_failed';
  }
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

// Internal record of the binary's exit + collected streams. Returned by
// `runVicoopCodexCall` so `handle()` can branch on exit code without
// re-parsing the stderr / stdout itself.
interface CallResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

// Spawn `vicoop-codex call`, write the JSON body on stdin, and collect
// the result. Honours abort/cancel via `signal` — on abort we SIGTERM the
// child so the daemon doesn't wait on a stale subprocess after the
// caller's A2A `tasks/cancel` lands. Stderr is captured in full (no cap)
// because vicoop-codex's user-facing error guidance lives there and the
// task.fail message is operator-visible.
async function runVicoopCodexCall(
  body: string,
  opts: {
    command: string;
    args: readonly string[];
    cwd?: string;
    spawn: VicoopCodexSpawnFn;
    timeoutMs: number;
    signal: AbortSignal;
    stderrCap: number;
    logger?: Logger;
  },
): Promise<CallResult> {
  return await new Promise<CallResult>((resolve, reject) => {
    let child: VicoopCodexChildHandle;
    try {
      child = opts.spawn(opts.command, opts.args, { cwd: opts.cwd });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = null;
    let aborted = false;
    let settled = false;

    const finish = (result: CallResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    };

    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    };
    if (opts.signal.aborted) {
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    } else {
      opts.signal.addEventListener('abort', onAbort);
    }

    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGTERM');
        } catch {
          // best-effort
        }
        fail(new Error(`vicoop-codex call timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const piece = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderr.length < opts.stderrCap) {
          const remaining = opts.stderrCap - stderr.length;
          stderr += piece.length > remaining ? piece.slice(0, remaining) : piece;
        }
      });
    }

    child.on('error', (err) => {
      fail(err);
    });
    child.on('close', (code, signal) => {
      finish({
        code: aborted ? null : code,
        signal,
        stdout,
        stderr,
      });
    });

    if (child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE on early exit is expected (e.g. exit code 2 before reading
        // the body) — surface it as a normal close, not a hard error.
        if (err.code !== 'EPIPE') {
          opts.logger?.warn?.(`[vicoop-codex] stdin error: ${errorMessage(err)}`);
        }
      });
      try {
        child.stdin.write(body);
        child.stdin.end();
      } catch (err) {
        opts.logger?.warn?.(`[vicoop-codex] failed to write stdin: ${errorMessage(err)}`);
      }
    }
  });
}

// Construct the A2A Backend. The handler turns each task into a single
// non-streaming `vicoop-codex call` invocation: read the existing
// openai-compat extension metadata → assemble messages → invoke →
// translate response to A2A artifacts + final message metadata.
// Probe the vicoop-codex CLI's `models --json` subcommand to discover the
// model ids this account / install advertises. Returns null on any failure
// (binary missing, timeout, non-JSON stdout, unexpected shape) so the
// caller can skip the advertise / `envelope.model` gate silently. Mirrors
// `probeClaudeModel`'s "best-effort, fail-open" contract.
export async function probeVicoopCodexModels(args: {
  command: string;
  spawn: VicoopCodexSpawnFn;
  cwd?: string;
  timeoutMs: number;
}): Promise<string[] | null> {
  if (args.timeoutMs <= 0) return null;
  let child: VicoopCodexChildHandle;
  try {
    child = args.spawn(args.command, ['models', '--json'], { cwd: args.cwd });
  } catch {
    return null;
  }
  return await new Promise<string[] | null>((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string[] | null): void => {
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
        const ids: string[] = [];
        for (const m of parsed.models) {
          if (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string') {
            const id = (m as { id: string }).id;
            if (id.length > 0) ids.push(id);
          }
        }
        finish(ids.length > 0 ? ids : null);
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
  const baseArgs: readonly string[] = ['call', ...(opts.extraArgs ?? [])];
  const cwd = opts.cwd;
  const spawnFn = opts.spawn ?? defaultSpawn;
  const stderrCap = opts.stderrCaptureBytes ?? 16 * 1024;
  const callTimeoutMs = opts.callTimeoutMs ?? 0;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
  const logger = opts.logger ?? createLogger();
  const openaiCompatTrace = opts.openaiCompatTrace === true;

  // Supported-models cache, populated by `resolveCapabilities` at daemon
  // startup and read sync from `handle()` to gate `envelope.model`
  // forwarding (#302). Mirrors claude's pattern — `undefined` = "never
  // probed", `null` = "probed but unavailable", non-empty `Set` = the
  // model ids the CLI's `models --json` advertised.
  let cachedSupportedModels: Set<string> | null | undefined = undefined;

  return {
    name: 'vicoop-codex',

    async resolveCapabilities() {
      const ids = await probeVicoopCodexModels({
        command,
        spawn: spawnFn,
        cwd,
        timeoutMs: probeTimeoutMs,
      });
      if (!ids || ids.length === 0) {
        cachedSupportedModels = null;
        return {};
      }
      cachedSupportedModels = new Set(ids);
      // Advertise on the openai-compat/v1 `params.models[]` slot so
      // upstream A2A callers (and the gateway's model resolver) can see
      // the list without round-tripping through `vicoop-codex models`.
      // The first id is tagged as default — vicoop-codex's `models`
      // output is already ordered with the recommended model first.
      const openaiCompatModels = ids.map((id, i) =>
        i === 0 ? { id, default: true as const } : { id },
      );
      return { openaiCompatModels };
    },

    async handle(task, emit, signal) {
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
      const body = buildCallBody(effectiveEnvelope, messages);
      let serialized: string;
      try {
        serialized = JSON.stringify(body);
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

      let result: CallResult;
      try {
        result = await runVicoopCodexCall(serialized, {
          command,
          args: baseArgs,
          cwd,
          spawn: spawnFn,
          timeoutMs: callTimeoutMs,
          signal,
          stderrCap,
          logger,
        });
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
          error: {
            code: 'spawn_failed',
            message: `failed to spawn vicoop-codex: ${errorMessage(err)}`,
          },
        });
        return;
      }

      // Aborted mid-flight — caller already pulled the plug, surface as
      // canceled regardless of what the subprocess did before SIGTERM
      // delivered.
      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      if (result.code !== 0) {
        const trimmedStderr = result.stderr.trim();
        const message =
          trimmedStderr.length > 0
            ? trimmedStderr
            : `vicoop-codex exited with code ${result.code}`;
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: exitCodeToA2ACode(result.code),
            message,
          },
        });
        return;
      }

      // Parse the stdout payload. A malformed (non-JSON) stdout shouldn't
      // crash the backend — surface as `parse_failed` with the head of
      // the output so the operator can diagnose without `--verbose`.
      let response: ChatCompletionResponse;
      try {
        response = JSON.parse(result.stdout) as ChatCompletionResponse;
      } catch (err) {
        const head = result.stdout.slice(0, 256);
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'parse_failed',
            message: `failed to parse vicoop-codex stdout as JSON: ${errorMessage(err)}; head: ${JSON.stringify(head)}`,
          },
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
      // artifact. The legacy `data` part shaped `{ "tool_calls": [...] }`
      // is removed from this extension; consumers ignore it. Text content
      // still rides as a text artifact so non-OpenAI A2A consumers
      // (debugging UIs, traceability tooling) see the task's response
      // natively, per the spec's "Relationship to A2A artifacts" note.
      if (toolCalls.length === 0 && contentText) {
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

      const usage = parseChatCompletionUsage(response.usage, response.model);
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
