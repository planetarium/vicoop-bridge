import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type Part,
} from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { createLogger, type Logger } from '../logger.js';
import {
  callerToolDispatchActive,
  parseOpenAICompatMetadata,
} from './claude.js';
import {
  buildOpenAICompatUsage,
  makeOpenAICompatUsageMetadata,
  type OpenAICompatUsage,
} from './openai-compat-usage.js';
import { INPUT_FILE_MAX_BYTES, INPUT_IMAGE_MIME } from './fetch-uri-file.js';
import { createTimingRecorder } from './timing.js';
import {
  AppServerRpcClient,
  DYNAMIC_TOOL_CALL_METHOD,
  defaultAppServerSpawn,
  TRANSPORT_CLOSED,
  type AppServerSpawnFn,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type DynamicToolSpec,
  type InitializeResult,
  type ResponsesApiItem,
  type SandboxMode,
  type ThreadItem,
  type UserInputItem,
} from './codex-rpc.js';
import type { OpenAICompatHistoryEntry, OpenAICompatMetadata } from './claude.js';

export type CodexSandboxMode = SandboxMode;
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

export interface CodexBackendOptions {
  command?: string;
  appServerArgs?: readonly string[];
  cwd?: string;
  sandboxMode?: SandboxMode;
  // What to answer when codex sends a server-initiated approval request
  // (execCommandApproval / applyPatchApproval). Default `decline` — safe
  // even under workspace-write; operators that explicitly want auto-accept
  // opt in via config.
  approvalDecision?: ApprovalDecision;
  spawn?: AppServerSpawnFn;
  stderrCaptureBytes?: number;
  // How long an idle `(contextId → threadId)` mapping survives without use.
  // Default 1 hour. `0` disables session reuse — every task does
  // `thread/start` from scratch.
  sessionTtlMs?: number;
  // Test seam: deterministic clock for TTL eviction and timing.
  now?: () => number;
  // Idle-silence heartbeat — same semantics as `codex` / `claude`.
  heartbeatMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  mkdtemp?: (prefix: string) => Promise<string>;
  writeFile?: (file: string, data: Buffer) => Promise<void>;
  rm?: (file: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  logger?: Logger;
  // Wait this long for `initialize` to complete on the first task before
  // surfacing `app_server_unavailable`. Subsequent tasks reuse the client
  // and skip this wait. Default 10s.
  initializeTimeoutMs?: number;
  // Wait this long for `turn/completed` after `turn/start`. Default 0
  // (no client-side timeout — the server is authoritative). Set to a
  // positive value to fail-fast against a hung agent.
  turnTimeoutMs?: number;
  // Test seam — overrides the default codex config.toml reader used by
  // `resolveCapabilities` to advertise the underlying model on the
  // openai-compat/v1 extension. Returning `null` (or rejecting) keeps the
  // probe silent and the card's declared capabilities unchanged. Defaults
  // to reading `${CODEX_HOME ?? ~/.codex}/config.toml` via `fs.readFile`.
  readCodexConfigToml?: () => Promise<string | null>;
}

interface SessionEntry {
  threadId: string;
  lastUsedAt: number;
  writeId: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const COMMAND_TRACE_MAX_CHARS = 2_000;

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Extract a basic TOML string value: `"…"` or `'…'`. Returns null if the
// raw value doesn't match either form. Intentionally narrow — codex writes
// these specific keys as plain quoted strings, and we don't want to pull
// in a full TOML parser for two fields.
function extractTomlStringValue(raw: string): string | null {
  let m = /^"((?:[^"\\]|\\[^])*)"$/.exec(raw);
  if (m) return m[1];
  m = /^'([^']*)'$/.exec(raw);
  if (m) return m[1];
  return null;
}

// Minimal TOML extractor for codex's root-level `model` and
// `model_reasoning_effort` keys. We deliberately do NOT depend on a real
// TOML parser: codex's config schema places both keys at the top, and a
// line-based scan that bails at the first `[table]` header covers our
// case without dragging a parser into the client bundle.
//
// Exported for unit testing the parser separately from the resolveCapabilities
// wiring.
export function parseCodexConfigTomlForModel(text: string): {
  model: string | null;
  hasReasoningEffort: boolean;
} {
  let model: string | null = null;
  let hasReasoningEffort = false;
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip comments. We accept the simple form (value contains no '#'
    // inside its quoted region) — sufficient because codex never embeds
    // '#' in a model id and `model_reasoning_effort` is a known enum.
    const stripped = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!stripped) continue;
    // First `[section]` header ends the root section — any later
    // occurrence of `model =` is a sub-table key (e.g. a profile) and
    // does NOT override the agent's default.
    if (stripped.startsWith('[')) break;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(stripped);
    if (!m) continue;
    const key = m[1];
    const rawVal = m[2].trim();
    if (key === 'model') {
      const v = extractTomlStringValue(rawVal);
      if (v !== null && v.length > 0) model = v;
    } else if (key === 'model_reasoning_effort') {
      const v = extractTomlStringValue(rawVal);
      // `none` is the explicit "no effort" enum value — treat it as
      // "model is not used in reasoning mode here" and leave
      // `hasReasoningEffort` false so we don't claim reasoning_tokens
      // will land for runs configured this way.
      if (v !== null && v.length > 0 && v.toLowerCase() !== 'none') {
        hasReasoningEffort = true;
      }
    }
  }
  return { model, hasReasoningEffort };
}

// Default config.toml reader. Honours `CODEX_HOME` to match the codex CLI's
// own override hook, falling back to `~/.codex/config.toml`. Returns null on
// any error so `resolveCapabilities` silently skips the advertise.
async function defaultReadCodexConfigToml(): Promise<string | null> {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  try {
    return await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
}

function traceabilityRequested(task: {
  message?: { extensions?: readonly string[] };
  requestedExtensions?: readonly string[];
}): boolean {
  return (
    task.requestedExtensions?.includes(TRACEABILITY_EXTENSION_URI) === true ||
    task.message?.extensions?.includes(TRACEABILITY_EXTENSION_URI) === true
  );
}

function clipTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function decodedBase64Size(b64: string): number {
  if (b64.length === 0) return 0;
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function imageExtForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.img';
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

// Result of mapping the user's A2A `Message.parts` to the codex input shape:
// a single prompt string (text + serialized data parts), zero or more
// materialised image temp paths, and the temp dir to clean up afterward.
export type MappedInput =
  | { ok: true; prompt: string; imageFiles: string[]; tempDir: string | null }
  | { ok: false; code: string; message: string };

export async function mapPartsToCodexInput(
  parts: readonly Part[],
  io: {
    mkdtemp: (prefix: string) => Promise<string>;
    writeFile: (file: string, data: Buffer) => Promise<void>;
    rm: (file: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  },
): Promise<MappedInput> {
  const textParts: string[] = [];
  const dataParts: string[] = [];
  const pendingImages: Array<{ mime: string; bytes: string }> = [];

  for (const p of parts) {
    if (p.kind === 'text') {
      if (p.text) textParts.push(p.text);
      continue;
    }
    if (p.kind === 'data') {
      const serialized = serializeDataPart(p.data);
      if (serialized) dataParts.push(serialized);
      continue;
    }
    if (p.kind === 'file') {
      const mime = p.file.mimeType ?? '';
      if (!p.file.bytes) {
        return {
          ok: false,
          code: p.file.uri ? 'unsupported_file_uri' : 'invalid_file_part',
          message: p.file.uri
            ? 'codex backend v1 requires inline FilePart bytes; file.uri is not supported'
            : 'codex backend FilePart must carry inline bytes',
        };
      }
      if (!INPUT_IMAGE_MIME.has(mime)) {
        return {
          ok: false,
          code: 'unsupported_file_mime',
          message: `codex backend accepts image/{png,jpeg,webp,gif} (got ${mime || 'unknown'})`,
        };
      }
      const decodedSize = decodedBase64Size(p.file.bytes);
      if (decodedSize > INPUT_FILE_MAX_BYTES) {
        return {
          ok: false,
          code: 'file_too_large',
          message: `FilePart exceeds INPUT_FILE_MAX_BYTES (${decodedSize} > ${INPUT_FILE_MAX_BYTES})`,
        };
      }
      pendingImages.push({ mime, bytes: p.file.bytes });
      continue;
    }
  }

  if (textParts.length === 0 && dataParts.length === 0 && pendingImages.length === 0) {
    return { ok: false, code: 'empty_prompt', message: 'no content in message' };
  }

  let tempDir: string | null = null;
  const imageFiles: string[] = [];
  if (pendingImages.length > 0) {
    try {
      tempDir = await io.mkdtemp(path.join(os.tmpdir(), 'vicoop-codex-'));
      for (let i = 0; i < pendingImages.length; i++) {
        const image = pendingImages[i];
        const filePath = path.join(tempDir, `image-${i + 1}${imageExtForMime(image.mime)}`);
        await io.writeFile(filePath, Buffer.from(image.bytes, 'base64'));
        imageFiles.push(filePath);
      }
    } catch (err) {
      if (tempDir) {
        try {
          await io.rm(tempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup before surfacing the input failure.
        }
      }
      return {
        ok: false,
        code: 'input_file_write_failed',
        message: `failed to materialize codex image input: ${errorMessage(err)}`,
      };
    }
  }

  const prompt = [...textParts, ...dataParts].join('\n\n');
  return { ok: true, prompt, imageFiles, tempDir };
}

// Parse codex `turn.completed.usage` (or any equivalent shape codex
// app-server emits on the terminal turn notification) into a spec-compliant
// OpenAICompatUsage payload.
//
// Native shape (codex 0.130+):
//   { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }
//
// Mapping per the openai-compat/v1 native-fields appendix:
//   prompt_tokens                              = input_tokens
//                                                (cached_input_tokens is ALREADY
//                                                 included in input_tokens; do not
//                                                 add again)
//   prompt_tokens_details.cached_tokens        = cached_input_tokens
//   completion_tokens                          = output_tokens
//                                                (reasoning_output_tokens is a
//                                                 breakdown of output_tokens, not
//                                                 additive)
//   completion_tokens_details.reasoning_tokens = reasoning_output_tokens
export function parseCodexTurnUsageForOpenAICompat(raw: unknown): OpenAICompatUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : null;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : null;
  if (input === null || output === null) return null;
  const cached = typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined;
  const reasoning =
    typeof u.reasoning_output_tokens === 'number' ? u.reasoning_output_tokens : undefined;
  return buildOpenAICompatUsage({
    prompt_tokens: input,
    completion_tokens: output,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
  });
}

// app-server `commandExecution` item summary.
function commandExecutionSummary(item: Extract<ThreadItem, { type: 'commandExecution' }>): string {
  const command = typeof item.command === 'string' ? item.command : '<unknown command>';
  const status = typeof item.status === 'string' ? item.status : 'unknown';
  const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
  const rawOutput = (item as { aggregatedOutput?: unknown }).aggregatedOutput;
  const output = typeof rawOutput === 'string' ? rawOutput.trim() : '';
  const head = exit === null ? `${command} (${status})` : `${command} (${status}, exit ${exit})`;
  return clipTo(output ? `${head}\n${output}` : head, COMMAND_TRACE_MAX_CHARS);
}

interface PreparedInput {
  input: UserInputItem[];
  tempDir: string | null;
  instructions: string | null;
}

// Convert mapped prompt + image files to the app-server `UserInput[]` shape.
// Order: user text → images appended. Tool-call history is no longer
// folded into the user text — see `historyToInjectItems`, which puts it
// into the thread's native model-visible context via `thread/inject_items`.
function buildUserInput(
  prompt: string,
  imageFiles: string[],
): UserInputItem[] {
  const items: UserInputItem[] = [];
  if (prompt) {
    items.push({ type: 'text', text: prompt, text_elements: [] });
  }
  for (const p of imageFiles) {
    items.push({ type: 'localImage', path: p });
  }
  return items;
}

// Map the caller-provided OpenAI `tools` array (the wire shape used in
// OpenAI Chat Completions: `{ type: 'function', function: { name, description,
// parameters } }`) to codex's `DynamicToolSpec` shape used on
// `thread/start.dynamicTools`. Entries missing the required pieces (name, or
// a `function` envelope) are silently dropped — the gateway already validated
// the OpenAI request shape, so this is a defensive last filter; an entirely
// empty result is returned as `null` so callers can branch off "no tools to
// inject" without checking `length`.
export function openaiToolsToDynamicToolSpecs(
  tools: readonly unknown[],
): DynamicToolSpec[] | null {
  const out: DynamicToolSpec[] = [];
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
      // codex requires an inputSchema; an empty object schema is the
      // canonical "no parameters" shape per OpenAI.
      inputSchema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : null;
}

// Compose `developerInstructions` for the native dispatch path. Includes the
// caller's `system` text verbatim plus a short directive when `tool_choice`
// is "required" or names a specific function — codex has no native
// `tool_choice` field, so we steer the model with a one-line note. The
// envelope-teaching block is omitted; the model sees the tools natively via
// codex's function-call surface, so describing a JSON-emit contract would
// only invite confusion.
export function composeNativeDevInstructions(meta: OpenAICompatMetadata): string {
  const sections: string[] = [];
  if (meta.system) sections.push(meta.system);
  const tc = meta.tool_choice;
  if (tc === 'required') {
    sections.push(
      'tool_choice="required": you MUST invoke one of the available tools this turn; answering in natural language is not allowed.',
    );
  } else if (typeof tc === 'object' && tc !== null && !Array.isArray(tc)) {
    const c = tc as { type?: unknown; function?: unknown };
    if (c.type === 'function' && c.function && typeof c.function === 'object') {
      const fn = c.function as { name?: unknown };
      if (typeof fn.name === 'string' && fn.name.length > 0) {
        sections.push(
          `tool_choice: you MUST invoke the tool named "${fn.name}".`,
        );
      }
    }
  }
  return sections.join('\n\n');
}

// Map an openai-compat `tool_call_history` to OpenAI Responses API items
// suitable for `thread/inject_items`. Each `assistant.tool_calls[]` entry
// fans out into one `function_call` item; each `role:"tool"` entry maps to
// a matching `function_call_output`. Order is preserved so call_id pairing
// stays consistent with the originating conversation.
//
// When `userPrompt` is non-empty, a `message` item with `role: "user"` is
// prepended to the result. Without this anchor the model sees the
// function_call / function_call_output pairs as orphan tool dispatch with
// no preceding user turn, and then takes the fresh `turn/start.input` text
// as a new imperative — re-emitting the same tool call instead of
// finalising on the existing results (#233). Putting the user message at
// the head reconstructs OpenAI Chat Completions ordering
// (`[user, assistant tool_call, tool result]`) so the model treats the
// tool results as satisfying the request.
//
// Malformed entries (missing id / function name) are skipped silently —
// the gateway already validated the OpenAI request shape, so this is a
// defensive last filter rather than an error surface.
export function historyToInjectItems(
  history: OpenAICompatHistoryEntry[],
  userPrompt: string = '',
): ResponsesApiItem[] {
  const out: ResponsesApiItem[] = [];
  if (userPrompt) {
    out.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: userPrompt }],
    });
  }
  for (const entry of history) {
    if (entry.role === 'assistant') {
      for (const tc of entry.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const call = tc as { id?: unknown; function?: unknown };
        if (typeof call.id !== 'string' || !call.id) continue;
        if (!call.function || typeof call.function !== 'object') continue;
        const fn = call.function as { name?: unknown; arguments?: unknown };
        if (typeof fn.name !== 'string' || !fn.name) continue;
        // OpenAI spec: `function.arguments` is a JSON-encoded string. Some
        // producers send the parsed object instead — re-stringify so the
        // Responses API item is spec-compliant either way.
        const args =
          typeof fn.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {});
        out.push({
          type: 'function_call',
          call_id: call.id,
          name: fn.name,
          arguments: args,
        });
      }
    } else {
      out.push({
        type: 'function_call_output',
        call_id: entry.tool_call_id,
        output: entry.content,
      });
    }
  }
  return out;
}

// Per-task in-progress notification subscription — listens for
// `item/agentMessage/delta`, `item/completed`, and `turn/completed`
// scoped to the active turn, then resolves with the final state.
interface TurnRunOutcome {
  status: 'completed' | 'failed' | 'interrupted' | 'aborted';
  error?: { message: string };
  finalText: string | null;
}

export function createCodexBackend(
  opts: CodexBackendOptions = {},
): Backend {
  const command = opts.command ?? 'codex';
  const appServerArgs = opts.appServerArgs ?? ['app-server'];
  const cwd = opts.cwd;
  const sandboxMode: SandboxMode = opts.sandboxMode ?? 'read-only';
  const approvalDecision: ApprovalDecision = opts.approvalDecision ?? 'decline';
  const spawnFn = opts.spawn ?? defaultAppServerSpawn;
  const stderrCap = opts.stderrCaptureBytes ?? 8192;
  const sessionTtlMs = opts.sessionTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setIntervalImpl =
    opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    opts.clearIntervalFn ??
    ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const mkdtemp = opts.mkdtemp ?? fs.mkdtemp;
  const writeFile = opts.writeFile ?? fs.writeFile;
  const rm = opts.rm ?? fs.rm;
  const logger = opts.logger ?? createLogger();
  const initializeTimeoutMs = opts.initializeTimeoutMs ?? 10_000;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 0;

  // contextId → (threadId, lastUsedAt). writeId-protected rollback so a
  // concurrent task on the same contextId doesn't get its session entry
  // rolled back from under it.
  const sessions = new Map<string, SessionEntry>();
  let writeCounter = 0;

  function evictExpired(cutoff: number): void {
    for (const [key, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) sessions.delete(key);
    }
  }

  // contextId mutex — codex app-server requires turns within a thread to
  // be serialised (a second `turn/start` while another is active is
  // rejected). Funnel concurrent same-contextId tasks through a per-context
  // chain so the second turn waits for the first.
  const contextLocks = new Map<string, Promise<void>>();

  async function acquireContextLock(contextId: string): Promise<() => void> {
    const prev = contextLocks.get(contextId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chain off the prior holder; the next holder waits on `prev` and
    // installs `next` as the new tail. When `release()` fires the chain
    // moves forward. The tail is only cleared if no one else queued behind
    // us, to keep the map free of stale entries on idle contexts.
    contextLocks.set(
      contextId,
      prev.then(() => next),
    );
    await prev;
    return () => {
      release();
      // If we are still the tail, drop the entry so the map doesn't grow
      // unbounded with idle contexts.
      if (contextLocks.get(contextId) === next) {
        contextLocks.delete(contextId);
      }
    };
  }

  let rpcClient: AppServerRpcClient | null = null;
  let initInFlight: Promise<AppServerRpcClient> | null = null;
  let serverInfo: InitializeResult | null = null;

  // Per-thread handlers for `item/tool/call` (codex's native-function-call
  // server request). Registered by the active `handle()` after thread/start
  // returns a threadId, and unregistered in the matching `finally`. The
  // app-server client has exactly one server-request handler installed at
  // initialize time (see `ensureClient` below) — that handler dispatches by
  // method, routing `item/tool/call` here keyed on `threadId` so each task
  // sees only its own tool calls. Other server requests (approvals, MCP
  // elicitation) fall through to the default `approvalDecision`.
  const toolCallHandlers = new Map<
    string,
    (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse> | DynamicToolCallResponse
  >();

  // Spawn the app-server, do the handshake, register handlers. Subsequent
  // tasks reuse the same client until it dies; a dead client is replaced
  // on the next `ensureClient()` call.
  async function ensureClient(): Promise<AppServerRpcClient> {
    if (rpcClient && !rpcClient.isClosed()) return rpcClient;
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      const c = new AppServerRpcClient({
        command,
        args: appServerArgs,
        cwd,
        spawn: spawnFn,
        logger,
        stderrCaptureBytes: stderrCap,
      });
      c.setServerRequestHandler(async (_id, method, params) => {
        // Native function-call dispatch: route to the per-thread handler the
        // active task registered after `thread/start`. The dispatch table is
        // keyed on `threadId`; if a task with `dynamicTools` registered a
        // handler then codex's `item/tool/call` lands here with the model's
        // arguments. Missing handler ⇒ the request arrived after the task
        // unregistered (race against turn/interrupt) — respond `success:false`
        // so codex unwinds the turn cleanly rather than blocking.
        if (method === DYNAMIC_TOOL_CALL_METHOD) {
          const p = params as DynamicToolCallParams | undefined;
          const handler = p?.threadId ? toolCallHandlers.get(p.threadId) : null;
          if (handler && p) {
            try {
              return await handler(p);
            } catch (err) {
              logger?.warn?.(
                `[codex] tool-call handler for thread ${p.threadId} threw: ${errorMessage(err)}`,
              );
              return {
                contentItems: [
                  { type: 'inputText', text: 'caller tool handler failed' },
                ],
                success: false,
              } satisfies DynamicToolCallResponse;
            }
          }
          return {
            contentItems: [
              { type: 'inputText', text: 'no caller tool handler registered' },
            ],
            success: false,
          } satisfies DynamicToolCallResponse;
        }
        // Default: approval prompts and friends. We surface a single decision
        // for every approval-flavored request; the bridge's daemon mode has
        // no interactive operator to ask.
        return { decision: approvalDecision };
      });
      try {
        c.start();
      } catch (err) {
        initInFlight = null;
        throw err;
      }
      // Clear singleton on crash so the next task respawns.
      void c.waitForClose().then(() => {
        if (rpcClient === c) {
          rpcClient = null;
          serverInfo = null;
        }
      });
      try {
        const initParams = {
          clientInfo: {
            name: 'vicoop-bridge',
            title: 'vicoop-bridge client',
            version: '1',
          },
          // `experimentalApi: true` is required to send
          // `thread/start.environments` — the wholesale lever we use to
          // remove codex's built-in execution surfaces under openai-compat
          // dispatch (#183). Codex's app-server rejects the request with
          // `thread/start.environments requires experimentalApi capability`
          // otherwise. Opt-in is documented as the public stable handshake
          // for accessing gated fields; individual fields graduate
          // independently so this opt-in remains safe across upgrades.
          capabilities: { experimentalApi: true },
        };
        const result = await withTimeout(
          c.request<InitializeResult>('initialize', initParams),
          initializeTimeoutMs,
          'initialize timed out',
        );
        c.notify('initialized');
        serverInfo = result;
        rpcClient = c;
        return c;
      } catch (err) {
        try {
          c.kill();
        } catch {
          // best effort
        }
        throw err;
      } finally {
        initInFlight = null;
      }
    })();
    return initInFlight;
  }

  const readConfigToml = opts.readCodexConfigToml ?? defaultReadCodexConfigToml;

  return {
    name: 'codex',

    // Advertise the underlying model on the openai-compat/v1 extension's
    // `params.models[]` slot (planetarium/oai2a2a#63) by reading codex's
    // own `config.toml`. We honour `CODEX_HOME` (same override codex CLI
    // respects) so a wrapped install resolves to the right file.
    //
    // Best-effort: any failure (file missing, malformed TOML, no `model`
    // key) returns `{}` and leaves the card's declared capabilities
    // untouched. Operators who hot-swap models via `-c model=...` on the
    // codex CLI won't be reflected here — but our spawn (`codex
    // app-server`) doesn't carry that override, so the config file is
    // authoritative for what codex actually loads under us.
    //
    // `reasoning: true` is set only when `model_reasoning_effort` is
    // configured to a non-`none` value, since the spec defines the flag
    // by whether the model emits `completion_tokens_details.reasoning_tokens`.
    async resolveCapabilities() {
      let text: string | null;
      try {
        text = await readConfigToml();
      } catch {
        return {};
      }
      if (!text) return {};
      const parsed = parseCodexConfigTomlForModel(text);
      if (!parsed.model) return {};
      const entry: { id: string; reasoning?: boolean; default: true } = {
        id: parsed.model,
        default: true,
      };
      if (parsed.hasReasoningEffort) entry.reasoning = true;
      return { openaiCompatModels: [entry] };
    },

    // Daemon shutdown hook. Per-task abort flows through `signal` in
    // `handle()`, but the `codex app-server` subprocess is a singleton kept
    // alive across tasks via `ensureClient()` — without an explicit kill on
    // SIGINT/SIGTERM it would be re-parented to init and linger after the
    // daemon exits (issue #186). Best-effort SIGTERM; the OS delivers it
    // before `process.exit` runs even though we don't await the close.
    stop(): void {
      if (rpcClient && !rpcClient.isClosed()) {
        rpcClient.kill('SIGTERM');
      }
    },

    async handle(task, rawEmit, signal) {
      let lastEmitAt = now();
      const recorder = createTimingRecorder({
        logger,
        backend: 'codex',
        taskId: task.taskId,
        contextId: task.contextId,
        now,
      });
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

      // Funnel concurrent same-contextId tasks. The existing `codex`
      // backend dodged this race by spawning per-task; app-server serialises
      // turns per thread, so we enforce that here rather than letting the
      // server reject the second `turn/start`.
      const releaseLock = await acquireContextLock(task.contextId);
      // Captured by the inner try when the per-thread `item/tool/call`
      // handler is registered (after `thread/start` / `thread/resume`
      // succeed). Read in the outer finally to unregister the handler
      // regardless of which path the turn took. Kept out here because
      // `existing` / `observedThreadId` are block-scoped to the inner try
      // and not visible in its finally.
      let registeredThreadId: string | null = null;
      try {
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }

        // Detect the openai-compat extension once. The system-prompt text
        // feeds `developerInstructions` on the next thread/start; any
        // `tool_call_history` is materialised as native Responses API
        // items and pushed through `thread/inject_items` after thread/start
        // (see `historyToInjectItems` below) — this gives the model a real
        // function-call history rather than a JSON blob it has to be
        // instructed to interpret, eliminating the multi-turn re-call loop
        // observed under prompts like `"Use a tool to list …"` (#176).
        //
        // When the caller supplies tools, the codex backend dispatches them
        // natively via `thread/start.dynamicTools` + `item/tool/call` server
        // requests (#209), not via the JSON-text envelope contract — so the
        // `developerInstructions` is just the user's `system` text plus a
        // short `tool_choice` nudge when applicable. The wire shape we emit
        // upstream (`tool_calls` artifact, `tool_call_history` input) is
        // unchanged so callers see no difference.
        const openaiCompat = parseOpenAICompatMetadata(task.message.metadata);
        const dynamicTools =
          openaiCompat && callerToolDispatchActive(openaiCompat) && openaiCompat.tools
            ? openaiToolsToDynamicToolSpecs(openaiCompat.tools)
            : null;
        const systemPrompt = openaiCompat
          ? composeNativeDevInstructions(openaiCompat)
          : '';

        const mapped = await mapPartsToCodexInput(task.message.parts, {
          mkdtemp,
          writeFile,
          rm,
        });
        recorder.mark('map');
        if (!mapped.ok) {
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: { code: mapped.code, message: mapped.message },
          });
          return;
        }

        // When `tool_call_history` is present, the user prompt is prepended
        // to the injected history as a `message`-type item with
        // `role: "user"` so the model sees a coherent
        // `[user → assistant tool_call → tool result]` conversation. Without
        // this anchor the function_call / function_call_output pairs read
        // as orphan tool dispatch and the model takes the next user prompt
        // as a fresh imperative — the re-call loop #233 captured.
        //
        // `turn/start.input` then carries a single empty-string text item
        // instead of the user prompt:
        //   - The user prompt is already in the injected history at the
        //     head, so re-sending it at the tail would trigger
        //     fresh-imperative interpretation and re-trigger #233.
        //   - A truly empty input array (`[]`) goes silent on codex's
        //     app-server — the model is called against pure history but
        //     never emits a final assistant message. A present-but-empty
        //     text item is enough to wake it up while leaving no visible
        //     placeholder content in the conversation.
        //   - Images still ride on `turn/start.input` via the existing
        //     `localImage` path; codex's `ContentItem::InputImage` wants a
        //     URL, not a local path, so they can't be inlined into the
        //     injected user-message anchor.
        // Combined with `config.include_environment_context: false` at
        // thread/start (which suppresses codex's auto-injected
        // `<environment_context>` user turn), the model receives an OpenAI
        // Chat Completions-shaped conversation that ends in the tool
        // result, and finalises off it.
        const historyInjectItems = openaiCompat?.tool_call_history
          ? historyToInjectItems(openaiCompat.tool_call_history, mapped.prompt)
          : null;
        const userPromptInjected = historyInjectItems !== null && mapped.prompt !== '';

        try {
          const userInput = userPromptInjected
            ? [
                { type: 'text' as const, text: '', text_elements: [] as never[] },
                ...buildUserInput('', mapped.imageFiles),
              ]
            : buildUserInput(mapped.prompt, mapped.imageFiles);

          let client: AppServerRpcClient;
          try {
            client = await ensureClient();
            recorder.mark('initialized');
          } catch (err) {
            emit({
              type: 'task.fail',
              taskId: task.taskId,
              error: {
                code: 'app_server_unavailable',
                message: `codex app-server failed to start: ${errorMessage(err)}`,
              },
            });
            return;
          }

          // Session-reuse map: same writeId-protected pattern as codex.ts
          // so a concurrent task on the same contextId doesn't get its
          // session entry rolled back from under it.
          //
          // openai-compat tasks opt OUT of session reuse for the same reason
          // claude.ts does (see claude.ts session-reuse guard): the OpenAI
          // Chat Completions request is stateless and replays the full
          // history every turn, so resuming a prior codex thread would
          // double-feed the model — once from the persisted thread items,
          // once from the gateway-replayed `tool_call_history` we inject.
          // The duplicate user prompts / function_call pairs that
          // accumulate cause the model to drift (e.g. parroting an earlier
          // tool result instead of answering a fresh question). Force a
          // clean `thread/start` every openai-compat task; the injected
          // history + turn/start.input is the unambiguous source of truth.
          const sessionReuseEligible = openaiCompat === null && sessionTtlMs > 0;
          const tNow = now();
          if (sessionReuseEligible) evictExpired(tNow - sessionTtlMs);
          const existing = sessionReuseEligible ? sessions.get(task.contextId) : undefined;
          let writeId = 0;
          if (sessionReuseEligible) {
            writeId = ++writeCounter;
            if (existing) {
              sessions.set(task.contextId, {
                threadId: existing.threadId,
                lastUsedAt: tNow,
                writeId,
              });
            }
          }
          const isResume = existing !== undefined;
          let observedThreadId: string | null = null;

          const rollbackResumeRefresh = (): void => {
            if (!isResume || !sessionReuseEligible) return;
            const cur = sessions.get(task.contextId);
            if (cur?.threadId === existing.threadId && cur.writeId === writeId) {
              sessions.set(task.contextId, {
                threadId: existing.threadId,
                lastUsedAt: existing.lastUsedAt,
                writeId: ++writeCounter,
              });
            }
          };
          const rollbackFreshThread = (): void => {
            if (isResume || !sessionReuseEligible || !observedThreadId) return;
            const cur = sessions.get(task.contextId);
            if (cur?.threadId === observedThreadId && cur.writeId === writeId) {
              sessions.delete(task.contextId);
            }
          };

          emit({
            type: 'task.status',
            taskId: task.taskId,
            status: { state: 'working', timestamp: new Date().toISOString() },
          });

          // For resumes we re-attach to the existing thread; sandbox and
          // any developerInstructions set on initial `thread/start` carry
          // over via the server-side session record. Feature-flag overrides
          // (see `featuresOverride` below) are the exception — they do NOT
          // persist across resume and must be re-sent every turn that wants
          // them. `environments`, by contrast, IS sticky on `thread/start`
          // and `ThreadResumeParams` does not even accept it, so we only
          // send it on start.
          //
          // When caller-side tool dispatch is active (openai-compat with
          // tools), the caller's `tools` array is the ONLY legitimate
          // dispatch surface — anything codex can call itself would bypass
          // the envelope contract. We defend on two seams:
          //
          // 1. `environments: []` — structurally drops every handler that
          //    `spec_plan.rs` gates on `environment_mode.has_environment()`:
          //    `shell` / `local_shell` / `shell_command` / `exec_command` /
          //    `write_stdin` / `container.exec` / `apply_patch` / `view_image`.
          //    This is wholesale and not whack-a-mole: the model can't dispatch
          //    these handlers by name because they are not in the registry,
          //    regardless of which feature flags are set or which tool the
          //    model decides to invent. See #183 — `features.shell_tool=false`
          //    alone left `exec_command` callable in cli 0.130 because exec
          //    handlers have fallback registrations that survive the
          //    `ConfigShellToolType::Disabled` branch; `environments: []`
          //    closes that gap by removing the environment those handlers
          //    require.
          //
          // 2. `features.*: false` — for surfaces NOT covered by
          //    `environments: []`: hosted web search, image generation,
          //    multi-agent / fan-out, plugin / MCP discovery, etc. These
          //    handlers do not depend on `environment_mode` and must each be
          //    explicitly disabled by their feature key.
          //
          // Surfaces we can't disable from here: `update_plan` and
          // `request_user_input` are unconditional in codex's tool registry;
          // they have no feature key. They are benign in practice (plan
          // mutation is session-local; request_user_input blocks on an MCP
          // elicitation reply that never arrives under openai-compat).
          // `list_mcp_resources` and siblings are gated by codex's per-server
          // `mcp_tools` config — out of scope for this flag plumbing.
          const featuresOverride = callerToolDispatchActive(openaiCompat)
            ? {
                features: {
                  // Hosted modalities that bypass the caller's text envelope.
                  image_generation: false,
                  web_search_request: false,
                  web_search_cached: false,
                  // Codex-side tool catalog / discovery and plugin surfaces.
                  tool_search: false,
                  tool_suggest: false,
                  tool_call_mcp_elicitation: false,
                  builtin_mcp: false,
                  plugins: false,
                  apps: false,
                  enable_mcp_apps: false,
                  // Sub-agent / fan-out orchestration bypasses the single-
                  // agent envelope contract.
                  multi_agent: false,
                  multi_agent_v2: false,
                  enable_fanout: false,
                  // Permission-escalation prompts would block under openai-
                  // compat (no human in loop).
                  request_permissions_tool: false,
                  // Experimental code surfaces.
                  code_mode: false,
                  goals: false,
                  memories: false,
                  // Workspace introspection — fs reads that could leak host
                  // paths back into model context.
                  workspace_dependencies: false,
                },
              }
            : null;
          // Suppress codex's auto-injected `<environment_context>` user
          // message under openai-compat. Codex records one at thread/start
          // and a fresh one at the head of every `turn/start`; the second
          // one lands AT THE CONVERSATION TAIL when we drive a continuation
          // turn with `turn/start.input: []`, which re-introduces a
          // synthetic user turn after the injected tool history and lets
          // the model interpret the prompt as a fresh imperative (#233).
          // Suppressing it leaves a clean
          // `[user → assistant tool_call → tool result]` tail so the model
          // finalises naturally off the injected history. The cost is
          // minor: the model loses date/timezone/cwd context, which
          // openai-compat callers don't rely on.
          const envContextOverride =
            openaiCompat !== null ? { include_environment_context: false } : null;
          const threadConfig =
            featuresOverride || envContextOverride
              ? { ...(featuresOverride ?? {}), ...(envContextOverride ?? {}) }
              : null;
          // `environments: []` is sticky on `thread/start` and unsupported on
          // `thread/resume`, so we only send it on start. Gated by the same
          // condition as the feature override so non-openai-compat callers
          // keep their normal codex environment.
          const sendEmptyEnvironments = callerToolDispatchActive(openaiCompat);

          let threadId: string;
          try {
            if (isResume) {
              const resumeResult = await client.request<{ thread: { id: string } }>(
                'thread/resume',
                {
                  threadId: existing.threadId,
                  cwd,
                  sandbox: sandboxMode,
                  ...(threadConfig ? { config: threadConfig } : {}),
                },
              );
              threadId = resumeResult.thread.id;
            } else {
              const startResult = await client.request<{ thread: { id: string } }>(
                'thread/start',
                {
                  cwd,
                  sandbox: sandboxMode,
                  ...(systemPrompt ? { developerInstructions: systemPrompt } : {}),
                  ...(threadConfig ? { config: threadConfig } : {}),
                  ...(sendEmptyEnvironments ? { environments: [] } : {}),
                  // Native function-call surface for caller-side tools (#209).
                  // codex persists `dynamicTools` with `SessionMeta` and
                  // re-hydrates them on `thread/resume`, so we only send
                  // them on the initial start.
                  ...(dynamicTools ? { dynamicTools } : {}),
                },
              );
              threadId = startResult.thread.id;
              observedThreadId = threadId;
              if (sessionReuseEligible) {
                sessions.set(task.contextId, {
                  threadId,
                  lastUsedAt: now(),
                  writeId,
                });
              }
            }
            // Append prior round-trips (if any) as native Responses API
            // items so codex's session builder includes them in the model
            // prompt as proper function-call history. Without this, the
            // model only sees a JSON `tool_call_history` blob in user text
            // and may re-emit the same envelope when the user prompt
            // contains a "use a tool" imperative (#176). Skip when there
            // are no items to inject.
            if (historyInjectItems && historyInjectItems.length > 0) {
              await client.request('thread/inject_items', {
                threadId,
                items: historyInjectItems,
              });
            }
            recorder.mark('threadReady');
          } catch (err) {
            rollbackResumeRefresh();
            // Transport closed mid-handshake: report as crash so operator
            // sees the same code as a startup-time failure; the next task
            // will re-spawn the client.
            if (err instanceof Error && err.message.startsWith(TRANSPORT_CLOSED)) {
              emit({
                type: 'task.fail',
                taskId: task.taskId,
                error: {
                  code: 'app_server_crashed',
                  message: `codex app-server transport closed during ${isResume ? 'thread/resume' : 'thread/start'}: ${err.message}`,
                },
              });
              return;
            }
            emit({
              type: 'task.fail',
              taskId: task.taskId,
              error: {
                code: isResume ? 'thread_resume_failed' : 'thread_start_failed',
                message: errorMessage(err),
              },
            });
            return;
          }

          // Subscribe to notifications scoped to our turn. The turnId is
          // not known until `turn/start` returns; we capture it then
          // filter incoming notifications by it. Prior to capture we
          // ignore turn-level events (no turn of ours is yet on the wire).
          let activeTurnId: string | null = null;
          let finalText: string | null = null;
          let finalUsage: OpenAICompatUsage | null = null;
          let emittedAnyArtifact = false;
          // Set when an `item/tool/call` lands for this turn — the model
          // invoked a caller-side tool, we emitted a `tool_calls` artifact,
          // and asked codex to interrupt. The interrupted-turn outcome
          // below is mapped to `completed` (instead of `canceled`) on this
          // flag so the caller's A2A task surfaces as success with a
          // `tool_calls` artifact, matching OpenAI Chat Completions'
          // `finish_reason: "tool_calls"` semantics.
          let capturedToolCall = false;
          const emitTraceArtifacts = traceabilityRequested(task);

          // Register the per-thread `item/tool/call` handler for the
          // duration of this turn. We always register when the openai-compat
          // extension is active — even on `thread/resume` without
          // `dynamicTools` in the current task — because codex persists
          // dynamicTools with SessionMeta and the resumed thread can still
          // invoke them. The handler is unregistered in the `finally` of
          // the outer try that wraps the turn loop below.
          if (openaiCompat) {
            registeredThreadId = threadId;
            toolCallHandlers.set(threadId, async (p) => {
              capturedToolCall = true;
              // The OpenAI Chat Completions wire shape callers expect.
              // codex hands us `arguments` already parsed as a JSON value;
              // the envelope path historically forwarded the parsed object
              // verbatim, so the artifact stays byte-compatible with PR
              // #208's output and downstream gateways (oai2a2a) don't have
              // to special-case the source.
              const envelope = {
                tool_calls: [
                  {
                    id: p.callId,
                    function: {
                      name: p.tool,
                      arguments: p.arguments,
                    },
                  },
                ],
              };
              emit({
                type: 'task.artifact',
                taskId: task.taskId,
                artifact: {
                  artifactId: randomUUID(),
                  name: 'codex-message',
                  parts: [{ kind: 'data', data: envelope }],
                  extensions: [OPENAI_COMPAT_EXTENSION_URI],
                },
                lastChunk: true,
              });
              emittedAnyArtifact = true;
              // Best-effort `turn/interrupt` so codex unwinds the turn —
              // the model's function_call is already surfaced upstream and
              // we don't want it generating further text or chaining into
              // another tool call before the caller has had a chance to
              // reply via `tool_call_history`.
              if (activeTurnId) {
                void client
                  .request('turn/interrupt', { threadId, turnId: activeTurnId })
                  .catch(() => {
                    // Best-effort; the turn loop watches for turn/completed.
                  });
              }
              // codex still expects a structured answer to the server
              // request; success=false signals the model that the result
              // is unavailable, but since we are interrupting the turn the
              // model never gets to act on it.
              return {
                contentItems: [],
                success: false,
              };
            });
          }

          const emitAgentArtifact = (text: string): void => {
            if (!text) return;
            emit({
              type: 'task.artifact',
              taskId: task.taskId,
              artifact: {
                artifactId: randomUUID(),
                name: 'codex-message',
                parts: [{ kind: 'text', text }],
              },
              lastChunk: true,
            });
            emittedAnyArtifact = true;
          };

          const emitCommandTrace = (
            item: Extract<ThreadItem, { type: 'commandExecution' }>,
          ): void => {
            if (!emitTraceArtifacts) return;
            emit({
              type: 'task.artifact',
              taskId: task.taskId,
              artifact: {
                artifactId: randomUUID(),
                name: 'codex-command-execution',
                parts: [
                  { kind: 'text', text: commandExecutionSummary(item) },
                  {
                    kind: 'data',
                    data: {
                      command: typeof item.command === 'string' ? item.command : undefined,
                      status: typeof item.status === 'string' ? item.status : undefined,
                      exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
                    },
                  },
                ],
                extensions: [TRACEABILITY_EXTENSION_URI],
                metadata: { traceType: 'command-execution' },
              },
              lastChunk: true,
            });
            emittedAnyArtifact = true;
          };

          // Drive the turn to completion. The notification subscription
          // captures the agent's final message text and command-execution
          // traces; the loop resolves on `turn/completed` or `turn/failed`.
          const outcome: TurnRunOutcome = await new Promise((resolve) => {
            let settled = false;
            const finish = (o: TurnRunOutcome): void => {
              if (settled) return;
              settled = true;
              cleanupNotifications();
              if (heartbeatHandle !== null) clearIntervalImpl(heartbeatHandle);
              signal.removeEventListener('abort', onAbort);
              resolve(o);
            };

            const cleanupNotifications = client.onNotification((method, params) => {
              if (method === 'item/completed') {
                const p = params as { item?: ThreadItem; turnId?: string } | undefined;
                if (activeTurnId && p?.turnId !== activeTurnId) return;
                const item = p?.item;
                if (!item) return;
                if (item.type === 'agentMessage' && typeof item.text === 'string') {
                  recorder.mark('firstFinal');
                  finalText = item.text;
                  emitAgentArtifact(item.text);
                  return;
                }
                if (item.type === 'commandExecution') {
                  emitCommandTrace(item as Extract<ThreadItem, { type: 'commandExecution' }>);
                }
                return;
              }
              if (method === 'item/agentMessage/delta') {
                const p = params as { turnId?: string } | undefined;
                if (activeTurnId && p?.turnId !== activeTurnId) return;
                recorder.mark('firstDelta');
                return;
              }
              if (method === 'turn/completed') {
                const p = params as
                  | {
                      turn?: {
                        id?: string;
                        status?: string;
                        error?: { message?: string } | null;
                        usage?: unknown;
                      };
                      usage?: unknown;
                    }
                  | undefined;
                const t = p?.turn;
                if (activeTurnId && t?.id !== activeTurnId) return;
                // openai-compat/v1 response-side usage. Best-effort: codex
                // 0.130+ flat usage object on `turn.usage` (or `params.usage`,
                // depending on app-server schema version). A malformed shape
                // leaves finalUsage null and the gateway falls back to its
                // own estimate.
                const parsed =
                  parseCodexTurnUsageForOpenAICompat(t?.usage) ??
                  parseCodexTurnUsageForOpenAICompat(p?.usage);
                if (parsed) finalUsage = parsed;
                if (t?.status === 'completed') {
                  finish({ status: 'completed', finalText });
                } else if (t?.status === 'interrupted') {
                  finish({ status: 'interrupted', finalText });
                } else {
                  finish({
                    status: 'failed',
                    error: { message: t?.error?.message ?? `turn ended with status ${t?.status ?? 'unknown'}` },
                    finalText,
                  });
                }
              }
            });

            const onAbort = (): void => {
              // Best-effort `turn/interrupt`; the resolution will land on
              // turn/completed status:'interrupted'. If the rpc client is
              // dead we still resolve as aborted.
              if (activeTurnId) {
                client.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
              }
              // Don't `finish` immediately — wait for the server's terminal
              // event to land so we don't race with a `turn/completed`
              // arriving during the round-trip.
              setTimeoutCheckAbort();
            };
            // If turn/completed never arrives after abort (e.g. server
            // ignored interrupt because turn was already settling),
            // we still resolve to canceled after a short grace period.
            let abortGracePending = false;
            const setTimeoutCheckAbort = (): void => {
              if (abortGracePending) return;
              abortGracePending = true;
              setTimeout(() => {
                if (!settled) {
                  finish({ status: 'aborted', finalText });
                }
              }, 2_000);
            };
            signal.addEventListener('abort', onAbort);

            // Idle-silence heartbeat — same shape as codex.ts.
            let heartbeatHandle: unknown = null;
            if (heartbeatMs > 0) {
              heartbeatHandle = setIntervalImpl(() => {
                if (settled) return;
                if (now() - lastEmitAt < heartbeatMs) return;
                emit({
                  type: 'task.status',
                  taskId: task.taskId,
                  status: { state: 'working', timestamp: new Date().toISOString() },
                });
              }, heartbeatMs);
            }

            // Wire client-side timeout if configured. The default 0 means
            // wait for the server.
            if (turnTimeoutMs > 0) {
              setTimeout(() => {
                if (!settled) {
                  finish({
                    status: 'failed',
                    error: { message: `turn timed out after ${turnTimeoutMs}ms` },
                    finalText,
                  });
                }
              }, turnTimeoutMs);
            }

            // Detect a transport closure mid-turn — the rpc client rejects
            // pending requests on close, but our turn-result loop is
            // notification-driven. Race the close future against the rest.
            void client.waitForClose().then(() => {
              if (!settled) {
                finish({
                  status: 'failed',
                  error: { message: 'codex app-server transport closed during turn' },
                  finalText,
                });
              }
            });

            // Fire turn/start. The response carries our turnId so we can
            // filter notifications.
            client
              .request<{ turn: { id: string } }>('turn/start', {
                threadId,
                input: userInput,
              })
              .then(
                (res) => {
                  activeTurnId = res.turn.id;
                  recorder.mark('turnStarted');
                },
                (err) => {
                  finish({
                    status: 'failed',
                    error: { message: `turn/start failed: ${errorMessage(err)}` },
                    finalText,
                  });
                },
              );
          });

          // Map turn outcome to A2A lifecycle.
          if (outcome.status === 'interrupted' || outcome.status === 'aborted') {
            // Caller-side abort (`signal.aborted`) takes precedence: surface
            // as `canceled` regardless of whether we also captured a tool
            // call, because the caller asked for cancelation.
            const callerAborted = outcome.status === 'aborted' || signal.aborted;
            if (capturedToolCall && !callerAborted) {
              // We interrupted ourselves because the model invoked a caller
              // tool. The `tool_calls` artifact is already on the wire;
              // fall through to the completion path so the task surfaces as
              // success with `finish_reason: "tool_calls"` semantics on the
              // caller side (the next A2A turn ships the result via
              // `tool_call_history`).
            } else {
              rollbackFreshThread();
              rollbackResumeRefresh();
              emit({
                type: 'task.complete',
                taskId: task.taskId,
                status: { state: 'canceled', timestamp: new Date().toISOString() },
              });
              return;
            }
          }

          if (outcome.status === 'failed') {
            rollbackFreshThread();
            rollbackResumeRefresh();
            emit({
              type: 'task.fail',
              taskId: task.taskId,
              error: {
                code: 'turn_failed',
                message: outcome.error?.message ?? 'turn failed',
              },
            });
            return;
          }

          // Refresh the resumed binding on success so TTL extends.
          if (isResume && sessionReuseEligible) {
            const cur = sessions.get(task.contextId);
            if (cur?.threadId === existing.threadId && cur.writeId === writeId) {
              sessions.set(task.contextId, {
                threadId: existing.threadId,
                lastUsedAt: now(),
                writeId,
              });
            }
          }

          const completeText = outcome.finalText ?? '';
          // When the model invoked a caller tool, the `tool_calls` artifact
          // is the complete task output: any agent text codex streamed
          // before the function_call is best treated as reasoning preamble
          // and not re-stamped on `status.message.parts`. Re-stamping
          // violates A2A's "Messages SHOULD NOT be used to deliver task
          // outputs" and, downstream, caused gateways (oai2a2a) to
          // double-emit `tool_calls` on the envelope path (#200) — keep
          // the same invariant on the native path.
          const parts: Part[] = !capturedToolCall && completeText
            ? [{ kind: 'text', text: completeText }]
            : [];
          if (!emittedAnyArtifact && completeText) {
            emit({
              type: 'task.artifact',
              taskId: task.taskId,
              artifact: {
                artifactId: randomUUID(),
                name: 'codex-result',
                parts,
              },
              lastChunk: true,
            });
          }

          // Attach the openai-compat/v1 `usage` payload to the final A2A
          // message of this turn when codex reported it on turn/completed.
          // When usage is present but there are no parts we still emit the
          // message frame (with empty parts) to carry the metadata.
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
                      role: 'agent',
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
        } finally {
          // Drop the per-thread `item/tool/call` handler if we registered
          // one. Map.delete on a missing key is a no-op, so paths that
          // failed before registration (failed start/resume, aborted-before-
          // turn) cost nothing here.
          if (registeredThreadId) toolCallHandlers.delete(registeredThreadId);
          if (mapped.tempDir) {
            try {
              await rm(mapped.tempDir, { recursive: true, force: true });
            } catch {
              // best-effort cleanup
            }
          }
        }
      } finally {
        releaseLock();
      }
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
