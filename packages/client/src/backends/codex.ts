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
  buildOpenAICompatSystemPrompt,
  callerToolDispatchActive,
  parseOpenAICompatMetadata,
  tryParseToolCallsEnvelope,
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
  defaultAppServerSpawn,
  TRANSPORT_CLOSED,
  type AppServerSpawnFn,
  type InitializeResult,
  type ResponsesApiItem,
  type SandboxMode,
  type ThreadItem,
  type UserInputItem,
} from './codex-rpc.js';
import type { OpenAICompatHistoryEntry } from './claude.js';

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

// Map an openai-compat `tool_call_history` to OpenAI Responses API items
// suitable for `thread/inject_items`. Each `assistant.tool_calls[]` entry
// fans out into one `function_call` item; each `role:"tool"` entry maps to
// a matching `function_call_output`. Order is preserved so call_id pairing
// stays consistent with the originating conversation.
//
// Malformed entries (missing id / function name) are skipped silently —
// the gateway already validated the OpenAI request shape, so this is a
// defensive last filter rather than an error surface.
export function historyToInjectItems(
  history: OpenAICompatHistoryEntry[],
): ResponsesApiItem[] {
  const out: ResponsesApiItem[] = [];
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
      c.setServerRequestHandler((_id, _method) => ({ decision: approvalDecision }));
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

  return {
    name: 'codex',

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
        const openaiCompat = parseOpenAICompatMetadata(task.message.metadata);
        const systemPrompt =
          openaiCompat ? buildOpenAICompatSystemPrompt(openaiCompat) : '';
        const historyInjectItems = openaiCompat?.tool_call_history
          ? historyToInjectItems(openaiCompat.tool_call_history)
          : null;

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

        try {
          const userInput = buildUserInput(mapped.prompt, mapped.imageFiles);

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
          const tNow = now();
          if (sessionTtlMs > 0) evictExpired(tNow - sessionTtlMs);
          const existing = sessionTtlMs > 0 ? sessions.get(task.contextId) : undefined;
          let writeId = 0;
          if (sessionTtlMs > 0) {
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
            if (!isResume || sessionTtlMs <= 0) return;
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
            if (isResume || sessionTtlMs <= 0 || !observedThreadId) return;
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
                  ...(featuresOverride ? { config: featuresOverride } : {}),
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
                  ...(featuresOverride ? { config: featuresOverride } : {}),
                  ...(sendEmptyEnvironments ? { environments: [] } : {}),
                },
              );
              threadId = startResult.thread.id;
              observedThreadId = threadId;
              if (sessionTtlMs > 0) {
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
          const emitTraceArtifacts = traceabilityRequested(task);

          const emitAgentArtifact = (text: string): void => {
            if (!text) return;
            // openai-compat envelope detection — same contract the codex
            // backend uses, so callers see identical `data` parts.
            if (openaiCompat) {
              const envelope = tryParseToolCallsEnvelope(text);
              if (envelope) {
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
                return;
              }
            }
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
            rollbackFreshThread();
            rollbackResumeRefresh();
            emit({
              type: 'task.complete',
              taskId: task.taskId,
              status: { state: 'canceled', timestamp: new Date().toISOString() },
            });
            return;
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
          if (isResume && sessionTtlMs > 0) {
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
          // If the finalText is the openai-compat `{"tool_calls":[…]}`
          // envelope, it was already routed to a `data` artifact via
          // emitAgentArtifact. Re-stamping the raw JSON onto
          // status.message.parts violates A2A's "Messages SHOULD NOT be
          // used to deliver task outputs" and causes downstream gateways
          // (oai2a2a) to re-extract and re-emit the same tool_calls,
          // corrupting OpenAI streaming clients that concatenate
          // arguments by index. See issue #200.
          const envelopeAlreadyRouted =
            openaiCompat !== null && tryParseToolCallsEnvelope(completeText) !== null;
          const parts: Part[] = !envelopeAlreadyRouted && completeText
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
