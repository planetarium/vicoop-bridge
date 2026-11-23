import { MAX_HOST_HISTORY_TURNS, readHostConversation, type HostTurn } from './codex-host-history.js';
import { hostProposalTool, proposalToolDefinition } from '../operation-proposals.js';
import { currentApprovalRequester, type RequestApproval } from '../remote-approval.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type Part,
} from '@vicoop-bridge/protocol';
import { callerFileToolSchema, MAX_FILE_REQUESTS_PER_EXECUTION, MAX_PENDING_FILE_REQUESTS, FILE_DELIVERY_REJECTION } from '../caller-file-delivery.js';
import type { Backend } from '../backend.js';
import {
  appendCallerContextInstruction,
  callerContextSessionKey,
  normalizeCallerContext,
  neutralizeCallerContextMarkers,
  wrapUserMessageWithCallerContext,
} from '../caller-context.js';
import { HEARTBEAT_INTERVAL_MS, startLivenessHeartbeat } from './heartbeat.js';
import { normalizeTaskFailError } from '../failure-code.js';
import { buildSelfIdentitySystemPrompt, type AgentIdentity } from '../identity.js';
import { createLogger, safeToken, type Logger } from '../logger.js';
import {
  callerToolDispatchActive,
  chatHistoryFromMessages,
  collectSystemFromMessages,
  dumpOpenAICompatTaskWire,
  parseOpenAICompatEnvelope,
} from './openai-compat.js';
import {
  buildOpenAICompatResponseMetadata,
  toProtocolTaskUsage,
  buildOpenAICompatUsage,
  sumOpenAICompatUsage,
  type OpenAICompatUsage,
} from './openai-compat-usage.js';
import { INPUT_FILE_MAX_BYTES, INPUT_IMAGE_MIME, decodedBase64Size } from './fetch-uri-file.js';
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
  type ModelListEntry,
  type ModelListResult,
  type ResponsesApiItem,
  type SandboxMode,
  type ThreadItem,
  type UserInputItem,
} from './codex-rpc.js';
import type {
  OpenAICompatHistoryEntry,
  OpenAICompatMessageContent,
} from './openai-compat.js';

export type CodexSandboxMode = SandboxMode;
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'remote';

export interface CodexBackendOptions {
  hostOperations?: string[];
  functionFileDelivery?: {
    description: string;
    filesEnabled?: boolean;
    operations?: string[];
    bind(): (input: unknown, signal: AbortSignal, tool?: string) => Promise<object>;
  };
  supportedModelIds?: readonly string[];
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
  mkdtemp?: (prefix: string, signal?: AbortSignal) => Promise<string>;
  writeFile?: (file: string, data: Buffer, signal?: AbortSignal) => Promise<void>;
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
  // How long to hold the `turn/interrupt` after an `item/tool/call`,
  // waiting for codex's `thread/tokenUsage/updated` to land first (#351).
  // Interrupting immediately races ahead of codex's token accounting and
  // the turn's usage is dropped entirely; the notification arrives within
  // tens of ms of the tool call once the bridge has answered it, while the
  // next model iteration takes ~500ms to start — so a short hold recovers
  // real usage at no extra model cost. On timeout the interrupt is sent
  // anyway and the `{0,0,0}` placeholder path applies. Default 1s.
  toolCallUsageWaitMs?: number;
  // Test seam — overrides the default codex config.toml reader used by
  // `resolveCapabilities` to advertise the underlying model on the
  // openai-compat/v1 extension. Returning `null` (or rejecting) keeps the
  // probe silent and the card's declared capabilities unchanged. Defaults
  // to reading `${CODEX_HOME ?? ~/.codex}/config.toml` via `fs.readFile`.
  readCodexConfigToml?: () => Promise<string | null>;
  // When true, dump A2A `parts` shape + metadata keys + raw
  // `chat_history` to stderr on every task. Operator diagnostic exposed
  // via `--openai-compat-trace`. Leave off in production.
  openaiCompatTrace?: boolean;
  // Agent's own A2A identity. When present, a self-identity directive is
  // sent as `developerInstructions` on every plain-task `thread/start` so
  // codex recognises its own mention (`@<agentId>@<host>`) / acct in user
  // messages and answers directly instead of attempting an outbound A2A
  // call to its own address via a2a-wallet. Mirrors what the claude backend
  // does via `--append-system-prompt`; see PR #129 / issue #128 for the
  // failure mode. Skipped entirely on openai-compat tasks (codex is a model
  // endpoint, not an A2A agent, there). Carries through `thread/resume`
  // because codex persists `developerInstructions` server-side per thread.
  identity?: AgentIdentity;
  // Opt into the corrective retry for a caller-tool turn that ended with no
  // tool call after a host-side tool failed, or despite a forced `tool_choice`
  // (#207). Off by default — it spends an extra turn when it fires. See
  // `shouldRetryStalledToolCall`.
  retryStalledToolCall?: boolean;
  /** Operator-owned instructions, also retained for model-endpoint requests. */
  operatorInstructions?: string;
  /** Bridge-owned workspace/proxy instructions, applied to plain A2A threads. */
  runtimeInstructions?: string;
}

interface SessionEntry {
  threadId: string;
  lastUsedAt: number;
  writeId: number;
  // developerInstructions persist with a codex thread. Reuse is therefore
  // safe only while both caller attribution and composed instructions match.
  callerKey: string;
  instructionsKey: string;
  toolsKey: string;
  hostTurns?: HostTurn[] | null;
}

const DEFAULT_HEARTBEAT_MS = HEARTBEAT_INTERVAL_MS;
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
    mkdtemp: (prefix: string, signal?: AbortSignal) => Promise<string>;
    writeFile: (file: string, data: Buffer, signal?: AbortSignal) => Promise<void>;
    rm: (file: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  },
  signal?: AbortSignal,
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
      signal?.throwIfAborted();
      tempDir = await io.mkdtemp(path.join(os.tmpdir(), 'vicoop-codex-'), signal);
      signal?.throwIfAborted();
      for (let i = 0; i < pendingImages.length; i++) {
        const image = pendingImages[i];
        const filePath = path.join(tempDir, `image-${i + 1}${imageExtForMime(image.mime)}`);
        await io.writeFile(filePath, Buffer.from(image.bytes, 'base64'), signal);
        signal?.throwIfAborted();
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

// Parse codex `thread/tokenUsage/updated.tokenUsage.last` into a
// spec-compliant OpenAICompatUsage payload.
//
// Native shape (codex app-server 0.134+):
//   { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }
//
// Mapping per the openai-compat/v1 native-fields appendix:
//   prompt_tokens                              = inputTokens
//                                                (cachedInputTokens is ALREADY
//                                                 included in inputTokens; do not
//                                                 add again)
//   prompt_tokens_details.cached_tokens        = cachedInputTokens
//   completion_tokens                          = outputTokens
//                                                (reasoningOutputTokens is a
//                                                 breakdown of outputTokens, not
//                                                 additive)
//   completion_tokens_details.reasoning_tokens = reasoningOutputTokens
export function parseCodexTokenUsageForOpenAICompat(raw: unknown): OpenAICompatUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tokenUsage = raw as Record<string, unknown>;
  const last = tokenUsage.last;
  if (!last || typeof last !== 'object' || Array.isArray(last)) return null;
  const u = last as Record<string, unknown>;
  const input = typeof u.inputTokens === 'number' ? u.inputTokens : null;
  const output = typeof u.outputTokens === 'number' ? u.outputTokens : null;
  if (input === null || output === null) return null;
  const cached = typeof u.cachedInputTokens === 'number' ? u.cachedInputTokens : undefined;
  const reasoning =
    typeof u.reasoningOutputTokens === 'number' ? u.reasoningOutputTokens : undefined;
  return buildOpenAICompatUsage({
    prompt_tokens: input,
    completion_tokens: output,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
  });
}

// What a `thread/tokenUsage/updated` payload says about the thread so far:
// `total` is codex's cumulative count for the whole thread, `lastKey` a
// comparable rendering of the per-response `last` block.
export interface CodexUsageMark {
  total: number | null;
  lastKey: string | null;
}

export function readCodexUsageMark(raw: unknown): CodexUsageMark {
  const tu = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { total?: unknown; last?: unknown })
    : {};
  const totalTokens =
    tu.total && typeof tu.total === 'object'
      ? (tu.total as { totalTokens?: unknown }).totalTokens
      : undefined;
  return {
    total: typeof totalTokens === 'number' && Number.isFinite(totalTokens) ? totalTokens : null,
    lastKey: tu.last && typeof tu.last === 'object' ? JSON.stringify(tu.last) : null,
  };
}

// Whether a usage update on a LATER turn of a thread is codex repeating the
// previous turn's accounting rather than reporting this turn's (#207 review).
//
// Observed on codex-cli 0.167.2: when a turn is interrupted before codex has
// accounted for it, codex still emits `thread/tokenUsage/updated` tagged with
// the new turn's id — carrying the PREVIOUS turn's `last` block, with `total`
// unchanged. A fresh thread has nothing to repeat, so this only matters for a
// second turn on the same thread, i.e. the corrective retry. Taken at face
// value it would bill the first attempt twice and hide that the retry went
// unreported.
//
// `prior` is the mark of the last update accepted before this turn started.
// The cumulative `total` is the reliable test: real accounting always advances
// it. When either side lacks a `total` (a codex that does not send one), fall
// back to the `last` block being byte-identical — two different model responses
// do not report the same prompt size.
//
// Exported for unit tests.
export function isStaleCodexUsageUpdate(prior: CodexUsageMark | null, update: CodexUsageMark): boolean {
  if (!prior) return false;
  if (prior.total !== null && update.total !== null) return update.total <= prior.total;
  return prior.lastKey !== null && update.lastKey === prior.lastKey;
}

// Assemble a complete OpenAI ChatCompletion envelope for the openai-compat/v1
// envelope contract. The codec on the gateway unwraps this verbatim, so we
// own every required field — id / object / created / model / choices /
// finish_reason / logprobs / usage. `id` is synthesized from the A2A task id
// (codex's app-server doesn't expose a stable response id we can forward);
// `model` falls back to a placeholder when codex didn't surface it via
// tokenUsage.
//
// Spec: extensions/openai-compat/v1/README.md#response-metadata-payload-agent--gateway
export function buildCodexChatCompletionEnvelope(args: {
  taskId: string;
  model: string | undefined;
  content: string | null;
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined;
  finishReason: 'stop' | 'tool_calls';
  usage: OpenAICompatUsage | null;
}): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: args.content };
  if (args.toolCalls && args.toolCalls.length > 0) {
    message.tool_calls = args.toolCalls;
  }
  const envelope: Record<string, unknown> = {
    id: `chatcmpl-codex-${args.taskId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: args.model ?? 'codex',
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

// app-server `commandExecution` item summary. With remote approvals the
// command (and its output, which routinely echoes arguments) is private to the
// approval request, so the public trace carries only status and exit code.
function commandExecutionSummary(
  item: Extract<ThreadItem, { type: 'commandExecution' }>,
  redact = false,
): string {
  const status = typeof item.status === 'string' ? item.status : 'unknown';
  const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
  if (redact) return exit === null ? `command execution (${status})` : `command execution (${status}, exit ${exit})`;
  const command = typeof item.command === 'string' ? item.command : '<unknown command>';
  const rawOutput = (item as { aggregatedOutput?: unknown }).aggregatedOutput;
  const output = typeof rawOutput === 'string' ? rawOutput.trim() : '';
  const head = exit === null ? `${command} (${status})` : `${command} (${status}, exit ${exit})`;
  return clipTo(output ? `${head}\n${output}` : head, COMMAND_TRACE_MAX_CHARS);
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
export function composeNativeDevInstructions(
  system: string | undefined,
  toolChoice: unknown,
): string {
  const sections: string[] = [];
  if (system) sections.push(system);
  const tc = toolChoice;
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

// ─────────────────────────────────────────────────────────────────────────────
// Caller-tool turns that end with no tool call (#207)
//
// Under caller-tool dispatch the caller's `tools` are the only surface that can
// act: `environments: []` and the feature overrides strip codex's own execution
// tools, and the bridge declines every approval prompt. A turn that completes
// having emitted no `item/tool/call` therefore hands the caller nothing to run.
//
// That is correct when the text was a final answer (typically the turn after
// tool results came back) and a silent dead end when the model gave up. The
// codex shape of the dead end, traced live on codex-cli 0.167.2: the model
// reaches for a host-side tool first — a shell call that fails with "No usable
// execution environment", or an MCP server from the operator's own
// `~/.codex/config.toml` whose approval prompt the bridge declines — and then
// reports "I couldn't create the app because the tool calls were cancelled"
// instead of calling the caller's tools. The task used to complete with
// `finish_reason: "stop"` and nothing in the logs.
//
// The claude backend has the same instrumentation and opt-in retry for its
// version of this (#441 — `describeEmptyDispatchTurn` and
// `shouldRetryNarratedToolCall` in claude.ts). The detection differs because
// the failure does: claude narrates the call as prose, so its signal is the
// text; codex goes off to tools that cannot work, so the signal here is
// structural and no model output is inspected or logged.
// ─────────────────────────────────────────────────────────────────────────────

// Why a tool-less caller-tool turn is suspected of being a dead end rather than
// a final answer. Ordered strongest first; `classifyEmptyDispatchTurn` returns
// the first that applies.
//
//   - `tool_choice_unmet`: the caller sent `tool_choice: "required"` (or named
//     a function) and got prose. Not a heuristic — the request was not met.
//   - `host_tool_failed`: a codex-side tool item (MCP call, command execution,
//     file change, …) completed `failed` / `declined` during the turn.
//   - `host_tool_round`: the turn spent a model round on something that was not
//     a caller tool call — a host tool item that did not fail, or more than one
//     model round with no caller tool call to show for it. Covers the shell
//     failure above, which codex reports to the model but not as an item.
//     LOGGED ONLY, never retried (see `shouldRetryStalledToolCall`): a turn
//     that tries a tool codex does not have (`update_plan`), is told so, and
//     then answers correctly produces exactly the same wire trace, and nothing
//     short of reading the model's text tells the two apart.
export type EmptyDispatchTurnReason =
  | 'tool_choice_unmet'
  | 'host_tool_failed'
  | 'host_tool_round';

// Codex `ThreadItem` types that are tool activity run by codex itself rather
// than by the caller. An allow-list on purpose: an item type this file does not
// know about must not be counted as a failed tool. `dynamicToolCall` is absent
// because that IS the caller's tool — and it always completes `failed`, since
// the bridge answers `success: false` before interrupting the turn.
const HOST_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
]);

// Classify a completed thread item as host-side tool activity. Returns null for
// anything that is not (messages, reasoning, the caller's own dynamic tool
// call, unknown types). `kind` is safe to log: the item type, plus the MCP
// server name for `mcpToolCall` — operator configuration, which is what an
// operator needs to find the server leaking into caller-dispatch turns.
//
// Exported for unit tests.
export function classifyHostToolItem(
  item: ThreadItem,
): { kind: string; failed: boolean } | null {
  if (!HOST_TOOL_ITEM_TYPES.has(item.type)) return null;
  const rec = item as Record<string, unknown>;
  const status = typeof rec.status === 'string' ? rec.status : '';
  const server =
    item.type === 'mcpToolCall' && typeof rec.server === 'string' && rec.server
      ? `:${safeToken(rec.server, 40)}`
      : '';
  return {
    kind: `${item.type}${server}`,
    failed: status === 'failed' || status === 'declined',
  };
}

function functionName(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as { type?: unknown; function?: unknown };
  if (e.type !== 'function' || typeof e.function !== 'object' || e.function === null) return null;
  const name = (e.function as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

// Which caller tools an OpenAI `tool_choice` obliges the model to call, or null
// when it leaves the model free to answer in prose (`"auto"`, `"none"`, absent,
// or a shape this does not recognise — unknown is never read as "forced").
//
//   - `"required"`                                   → `[]` (any tool)
//   - `{ type: "function", function: { name } }`     → `[name]`
//   - `{ type: "allowed_tools", allowed_tools: { mode: "required", tools } }`
//                                                    → the named subset
//
// Exported for unit tests.
export function forcedToolChoice(toolChoice: unknown): string[] | null {
  if (toolChoice === 'required') return [];
  if (typeof toolChoice !== 'object' || toolChoice === null || Array.isArray(toolChoice)) {
    return null;
  }
  const tc = toolChoice as { type?: unknown; allowed_tools?: unknown };
  if (tc.type === 'function') {
    const name = functionName(tc);
    return name ? [name] : null;
  }
  if (tc.type === 'allowed_tools' && typeof tc.allowed_tools === 'object' && tc.allowed_tools !== null) {
    const allowed = tc.allowed_tools as { mode?: unknown; tools?: unknown };
    if (allowed.mode !== 'required') return null;
    const names = Array.isArray(allowed.tools)
      ? allowed.tools.map(functionName).filter((n): n is string => n !== null)
      : [];
    return names;
  }
  return null;
}

// Decide whether a completed caller-tool turn that emitted no tool call looks
// like a dead end. Only meaningful for that population — the caller checks
// dispatch / completion / zero tool calls first (see
// `describeEmptyDispatchTurn`). Returns null for the unremarkable case: one
// model round, no host tool activity, no forced `tool_choice`. That is what a
// final answer looks like, and it is left alone.
//
// Exported for unit tests.
export function classifyEmptyDispatchTurn(opts: {
  toolChoice: unknown;
  modelRounds: number;
  hostToolItems: number;
  hostToolFailures: number;
}): EmptyDispatchTurnReason | null {
  if (forcedToolChoice(opts.toolChoice) !== null) return 'tool_choice_unmet';
  if (opts.hostToolFailures > 0) return 'host_tool_failed';
  if (opts.hostToolItems > 0 || opts.modelRounds > 1) return 'host_tool_round';
  return null;
}

// Whether the opt-in corrective retry fires for a reason. Tuned for precision,
// like the claude retry it mirrors: a false positive spends a turn AND makes a
// streaming caller read a correct answer twice, which is worse than missing a
// stall.
//
// `host_tool_round` is excluded on evidence. It would rescue real stalls — the
// shell-failure shape was retried into a tool call 5 times out of 5 live — but
// "Record a plan with update_plan, then tell me 17*23" was flagged 4 times out
// of 4 on a turn that answered correctly, and the two are indistinguishable on
// the wire. So it stays a log-only signal until its rate in real traffic is
// known.
//
// Exported for unit tests.
export function shouldRetryStalledToolCall(reason: EmptyDispatchTurnReason | null): boolean {
  return reason === 'tool_choice_unmet' || reason === 'host_tool_failed';
}

// The log line for a caller-tool turn that completed with nothing for the
// caller to execute, or null when the turn is not in that population.
//
// Like the claude line it mirrors, this covers the WHOLE population, including
// legitimate final answers, so the rate stays measurable; `reason` is what
// separates the suspect ones. `info` when unclassified or only weakly flagged
// (`host_tool_round`), `warn` for the two strong reasons — those are anomalies
// an operator can act on (an MCP server reachable from caller-dispatch turns, a
// forced tool call the model ignored), and warn has to stay alertable.
//
// No model output reaches the log: `taskId` joins to the session transcript,
// `textLen` / `modelRounds` are the cheap discriminators, `toolHistory` says
// whether the request already carried tool results (a final answer usually
// follows some; a first turn that calls nothing is the more suspect one).
//
// Exported for unit tests.
export function describeEmptyDispatchTurn(opts: {
  taskId: string;
  dispatchActive: boolean;
  toolCallCount: number;
  completed: boolean;
  textLength: number;
  model: string | null;
  toolChoice: unknown;
  toolHistory: boolean;
  modelRounds: number;
  hostToolItems: number;
  hostToolFailures: number;
  hostToolKinds: readonly string[];
}): { level: 'info' | 'warn'; line: string; reason: EmptyDispatchTurnReason | null } | null {
  if (!opts.dispatchActive) return null;
  if (opts.toolCallCount > 0) return null;
  // A failed, interrupted or aborted turn already surfaces through its own
  // path; the interesting case is a turn that reported success while producing
  // nothing to execute.
  if (!opts.completed) return null;
  const reason = classifyEmptyDispatchTurn(opts);
  const line =
    `[codex] caller-tool turn produced no tool calls taskId=${safeToken(opts.taskId)} ` +
    `model=${safeToken(opts.model ?? 'unknown', 60)} textLen=${opts.textLength} ` +
    `modelRounds=${opts.modelRounds} toolHistory=${opts.toolHistory} ` +
    `hostToolItems=${opts.hostToolItems} hostToolFailures=${opts.hostToolFailures}` +
    (opts.hostToolKinds.length > 0 ? ` hostToolKinds=${opts.hostToolKinds.join(',')}` : '') +
    ` reason=${reason ?? 'none'}`;
  const level = reason === 'tool_choice_unmet' || reason === 'host_tool_failed' ? 'warn' : 'info';
  return { level, line, reason };
}

// The corrective turn sent on the same thread when `retryStalledToolCall` is on
// and a caller-tool turn was classified as a dead end. It names what went wrong
// (host tools cannot run here), names the tools that can, and leaves the task
// itself alone — the thread still holds the whole conversation.
//
// `forced` is `forcedToolChoice(tool_choice)`. When the request left the model
// free (null), the last sentence is the escape hatch for a false positive: a
// model that had genuinely finished should say so again rather than invent a
// tool call it does not need. When the request obliged a tool call there is no
// such option, so the nudge restates the obligation — naming the tool(s) the
// caller pinned, when they are among `toolNames` — instead.
//
// Exported for unit tests.
export function composeStalledToolCallNudge(
  toolNames: readonly string[],
  forced: readonly string[] | null = null,
): string {
  const list = (ns: readonly string[]): string => ns.map((n) => `\`${n}\``).join(', ');
  // Only name pinned tools the request actually offers. `tool_choice` is
  // caller input and is not validated against `tools`; telling the model to
  // call something that does not exist would be worse than the generic wording.
  const pinned = forced?.filter((n) => toolNames.includes(n)) ?? [];
  const ending =
    forced === null
      ? 'Continue the task now by calling them directly. ' +
        'If the task is already complete and no tool call is needed, reply with your final answer only.'
      : pinned.length === 0
        ? 'This request requires a tool call: call one of them now. Answering in prose is not allowed.'
        : `This request requires a tool call: call ${list(pinned)} now. Answering in prose is not allowed.`;
  return (
    'Your previous turn ended without calling any of the function tools the caller provided, so nothing ran. ' +
    'Tools that run on this host — shell or command execution, file patching, MCP servers, plugins — ' +
    'are not available in this session: they fail or are cancelled, and you must not use them. ' +
    `The only tools that can act are the caller-provided function tools: ${list(toolNames)}. ` +
    ending
  );
}

// Flatten an OpenAI message `content` (string or content-part array) into
// the codex Responses API text payload. The Responses API's
// `content[].type` discriminator differs by role — `input_text` for
// user/system input, `output_text` for assistant output — so the caller
// passes which one applies. `image_url` content parts and unknown part
// types are dropped: honouring `image_url` would require fetching the URL
// to a local file (Responses API `input_image` takes a path/URL we'd have
// to materialise) which we do not run on chat_history. Multimodal prior
// turns are out of scope for the inject path; the trailing user's images
// ride via `turn/start.input` as before.
function chatHistoryContentToCodexParts(
  content: OpenAICompatMessageContent,
  partType: 'input_text' | 'output_text',
): Array<{ type: string; text: string }> {
  const flat: string[] = [];
  if (typeof content === 'string') {
    if (content) flat.push(content);
  } else {
    for (const part of content) {
      if (part.type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) flat.push(text);
      }
    }
  }
  if (flat.length === 0) return [];
  return [{ type: partType, text: neutralizeCallerContextMarkers(flat.join('\n\n')) }];
}

// Map an openai-compat `chat_history` to OpenAI Responses API items
// suitable for `thread/inject_items`. Each entry maps as follows:
//   - role:"user"               → message item with role:"user",
//                                  content: [{ type: "input_text", ... }]
//   - role:"assistant" (text)   → message item with role:"assistant",
//                                  content: [{ type: "output_text", ... }]
//   - role:"assistant" (tool_calls) → one `function_call` item per call
//                                       (preceded by an output_text
//                                       `message` item when the entry also
//                                       carries text content — OpenAI Chat
//                                       Completions permits the hybrid
//                                       shape)
//   - role:"tool"               → `function_call_output` item
// Order is preserved so call_id pairing and turn ordering stay consistent
// with the originating conversation.
//
// Per the new chat_history spec, the trailing user turn is NOT in
// chat_history — it rides A2A `parts` and reaches the model via
// `turn/start.input`. The historic anchoring trick (#233 — prepend a
// synthetic user-message item to give the function_call pairs context) is
// therefore no longer needed: chat_history already opens with the
// originating user turn.
//
// Malformed entries (missing id / function name) are skipped silently —
// the gateway already validated the OpenAI request shape, so this is a
// defensive last filter rather than an error surface.
export function historyToInjectItems(
  history: OpenAICompatHistoryEntry[],
): ResponsesApiItem[] {
  const out: ResponsesApiItem[] = [];
  for (const entry of history) {
    if (entry.role === 'user') {
      const content = chatHistoryContentToCodexParts(entry.content, 'input_text');
      if (content.length === 0) continue;
      out.push({ type: 'message', role: 'user', content });
      continue;
    }
    if (entry.role === 'assistant') {
      if ('tool_calls' in entry) {
        // Hybrid (text + tool_calls): emit the assistant text message
        // FIRST, then the function_call items — matching the order the
        // model emitted them so the conversation reads as
        // "{explanation} → {tool dispatch}".
        if (entry.content !== null) {
          const content = chatHistoryContentToCodexParts(entry.content, 'output_text');
          if (content.length > 0) {
            out.push({ type: 'message', role: 'assistant', content });
          }
        }
        for (const tc of entry.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const call = tc as { id?: unknown; function?: unknown };
          if (typeof call.id !== 'string' || !call.id) continue;
          if (!call.function || typeof call.function !== 'object') continue;
          const fn = call.function as { name?: unknown; arguments?: unknown };
          if (typeof fn.name !== 'string' || !fn.name) continue;
          // OpenAI spec: `function.arguments` is a JSON-encoded string.
          // Some producers send the parsed object instead — re-stringify
          // so the Responses API item is spec-compliant either way.
          const args =
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {});
          out.push({
            type: 'function_call',
            call_id: call.id,
            name: fn.name,
            arguments: neutralizeCallerContextMarkers(args),
          });
        }
        continue;
      }
      const content = chatHistoryContentToCodexParts(entry.content, 'output_text');
      if (content.length === 0) continue;
      out.push({ type: 'message', role: 'assistant', content });
      continue;
    }
    out.push({
      type: 'function_call_output',
      call_id: entry.tool_call_id,
      output: neutralizeCallerContextMarkers(entry.content),
    });
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

function extractAgentMessageDelta(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const p = params as Record<string, unknown>;
  if (typeof p.delta === 'string') return p.delta;
  if (p.delta && typeof p.delta === 'object') {
    const d = p.delta as Record<string, unknown>;
    if (typeof d.text === 'string') return d.text;
    if (typeof d.content === 'string') return d.content;
  }
  if (typeof p.text === 'string') return p.text;
  return '';
}

/** Bind the app-server function to one execution and bound outstanding host-side reads. */
export function createCodexFileToolHandler(
  send: (input: unknown, signal: AbortSignal, tool?: string) => Promise<object>,
  signal: AbortSignal,
  currentTurn: () => string | null,
  allowedTools: readonly string[] = ['send_file'],
  waitForTurn?: () => Promise<string | null>,
): (call: DynamicToolCallParams) => Promise<DynamicToolCallResponse> {
  let requests = 0;
  let pending = 0;
  return async call => {
    if (!allowedTools.includes(call.tool) || call.namespace != null || signal.aborted)
      return { success: false, contentItems: [] };
    if (pending >= MAX_PENDING_FILE_REQUESTS || requests >= MAX_FILE_REQUESTS_PER_EXECUTION)
      return { success: false, contentItems: [{ type: 'inputText', text: 'Attachment request limit reached' }] };
    pending++;
    requests++;
    try {
      let turnId = currentTurn();
      if (call.tool === 'propose_operation' && !turnId) {
        // Server requests and the turn/start reply can arrive in either order.
        // Bound both outstanding requests (above) and a peer that never replies.
        turnId = waitForTurn ? await withTimeout(waitForTurn(), 5_000, 'Turn confirmation timed out') : null;
        if (!turnId || turnId !== currentTurn()) return { success: false, contentItems: [] };
      }
      if (signal.aborted || (turnId !== null && turnId !== call.turnId)) return { success: false, contentItems: [] };
      const receipt = await send(call.arguments, signal, call.tool);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(receipt) }] };
    } catch {
      return { success: false, contentItems: [{ type: 'inputText', text: call.tool === 'propose_operation' ? 'Proposal rejected' : FILE_DELIVERY_REJECTION }] };
    } finally {
      pending--;
    }
  };
}

export function createCodexBackend(
  opts: CodexBackendOptions = {},
): Backend & {close():Promise<void>} {
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
  const openaiCompatTrace = opts.openaiCompatTrace === true;
  const setIntervalImpl =
    opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    opts.clearIntervalFn ??
    ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const mkdtemp: NonNullable<CodexBackendOptions['mkdtemp']> = opts.mkdtemp ?? ((prefix) => fs.mkdtemp(prefix));
  const writeFile: NonNullable<CodexBackendOptions['writeFile']> = opts.writeFile ?? ((file, data, signal) => fs.writeFile(file, data, { signal }));
  const rm = opts.rm ?? fs.rm;
  const logger = opts.logger ?? createLogger();
  const initializeTimeoutMs = opts.initializeTimeoutMs ?? 10_000;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 0;
  const toolCallUsageWaitMs = opts.toolCallUsageWaitMs ?? 1_000;
  // #207 opt-in: corrective retry for a caller-tool turn that stalled.
  const retryStalledToolCall = opts.retryStalledToolCall === true;
  // Precomputed once at construction (identity is per-daemon, not per-task).
  // Prepended to `developerInstructions` on every `thread/start` so the model
  // recognises its own mention / acct in user messages. See PR #129.
  const identityDevInstructions = [opts.identity ? buildSelfIdentitySystemPrompt(opts.identity) : '', opts.runtimeInstructions ?? ''].filter(Boolean).join('\n\n');

  // Supported-models cache, populated by `resolveCapabilities` at daemon
  // startup and read sync from `handle()` to gate `envelope.model`
  // forwarding (#302). Mirrors the claude / vicoop-codex pattern.
  // `undefined` = "never populated" — daemon hasn't called
  // `resolveCapabilities` yet or tests skipped it, so validation is
  // silently bypassed. `null` = "model/list was unavailable" — older
  // codex builds, app-server transport failure, advertise dropped — so
  // validation is again skipped. Non-empty Set = the visible model ids
  // (plus any operator-pinned override the agent card surfaces).
  let cachedSupportedModelIds: Set<string> | null | undefined = opts.supportedModelIds ? new Set(opts.supportedModelIds) : undefined;

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
  // Failed initialization can reject before the Docker supervisor closes.
  // Retain every live client until close so execution teardown can await it.
  const liveClients = new Set<AppServerRpcClient>();
  let initInFlight: Promise<AppServerRpcClient> | null = null;

  // Per-thread handlers for `item/tool/call` (codex's native-function-call
  // server request). Registered by the active `handle()` after thread/start
  // returns a threadId, and unregistered in the matching `finally`. The
  // app-server client has exactly one server-request handler installed at
  // initialize time (see `ensureClient` below) — that handler dispatches by
  // method, routing `item/tool/call` here keyed on `threadId` so each task
  // sees only its own tool calls. Other server requests (approvals, MCP
  // elicitation) fall through to the default `approvalDecision`.
  const approvalHandlers = new Map<string, { request: RequestApproval; signal: AbortSignal }>();
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
        if (approvalDecision === 'remote') {
          const p = params as Record<string, unknown> | undefined;
          const supported = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
          const handler = typeof p?.threadId === 'string' ? approvalHandlers.get(p.threadId) : undefined;
          if (!supported || !p || !handler) return { decision: 'decline' };
          const decision = await handler.request(method, p, handler.signal);
          return { decision: decision === 'allow_once' ? 'accept' : 'decline' };
        }
        return { decision: approvalDecision };
      });
      try {
        c.start();
        liveClients.add(c);
      } catch (err) {
        initInFlight = null;
        throw err;
      }
      // Clear singleton on crash so the next task respawns.
      void c.waitForClose().then(() => {
        liveClients.delete(c);
        if (rpcClient === c) {
          rpcClient = null;
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
        await withTimeout(
          c.request<InitializeResult>('initialize', initParams),
          initializeTimeoutMs,
          'initialize timed out',
        );
        c.notify('initialized');
        await withTimeout(c.authenticateExecution(), initializeTimeoutMs, 'execution authentication timed out');
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
    })().finally(()=>{initInFlight=null;});
    return initInFlight;
  }

  const readConfigToml = opts.readCodexConfigToml ?? defaultReadCodexConfigToml;

  return {
    name: 'codex',
    hostOperations: opts.hostOperations,
    remoteApprovals: approvalDecision === 'remote',

    // Advertise the underlying model(s) on the openai-compat/v1 extension's
    // `params.models[]` slot (planetarium/oai2a2a#63) using codex's own
    // `model/list` RPC. The RPC requires an initialized `app-server`, so
    // this triggers the same one-time spawn that would otherwise happen on
    // the first task — subsequent tasks reuse the existing client.
    //
    // Default picking, in order:
    //   1. operator override in `${CODEX_HOME ?? ~/.codex}/config.toml`'s
    //      root `model = "..."` — that's the value codex actually loads
    //      under us, even though `model/list.isDefault` reports its own
    //      recommended id;
    //   2. the entry where `isDefault: true` (codex's recommendation);
    //   3. the first non-hidden entry as a last resort.
    //
    // `reasoning: true` is set when codex's own per-model
    // `supportedReasoningEfforts` is non-empty — that flag tracks whether
    // the model emits `completion_tokens_details.reasoning_tokens`, which
    // matches the openai-compat/v1 spec's definition exactly.
    //
    // Best-effort: any failure (app-server not installed, `model/list`
    // unsupported on an older codex, transport closes) returns `{}` and
    // the card's declared capabilities are left untouched.
    async resolveCapabilities() {
      let operatorOverride: string | null = null;
      try {
        const tomlText = await readConfigToml();
        if (tomlText) {
          operatorOverride = parseCodexConfigTomlForModel(tomlText).model;
        }
      } catch {
        // config.toml read failure is tolerable — we'll fall back to
        // model/list.isDefault for the default-entry pick.
      }

      let client: AppServerRpcClient;
      try {
        client = await ensureClient();
      } catch {
        cachedSupportedModelIds = null;
        return {};
      }

      let modelList: ModelListEntry[];
      try {
        const result = await client.request<ModelListResult>('model/list', {});
        modelList = Array.isArray(result?.data) ? result.data : [];
      } catch {
        cachedSupportedModelIds = null;
        return {};
      }

      const visible = modelList.filter((m) => m && typeof m.id === 'string' && m.id.length > 0 && !m.hidden);
      if (visible.length === 0) {
        cachedSupportedModelIds = null;
        return {};
      }

      const defaultId =
        (operatorOverride && visible.find((m) => m.id === operatorOverride)?.id) ??
        operatorOverride ?? // operator pinned a model codex doesn't list (custom provider) — still honour it as the default tag
        visible.find((m) => m.isDefault)?.id ??
        visible[0].id;

      const openaiCompatModels = visible.map((m) => {
        const entry: {
          id: string;
          reasoning?: boolean;
          default?: true;
          contextWindow?: number;
        } = { id: m.id };
        if ((m.supportedReasoningEfforts?.length ?? 0) > 0) entry.reasoning = true;
        if (m.id === defaultId) entry.default = true;
        // codex's effective per-model window (advisory openai-compat/v1 hint).
        // Guard against a non-positive / non-integer value from a future
        // schema so we never advertise a bogus `contextWindow` (zod would
        // reject it downstream, dropping the whole entry).
        if (
          typeof m.context_window === 'number' &&
          Number.isInteger(m.context_window) &&
          m.context_window > 0
        ) {
          entry.contextWindow = m.context_window;
        }
        return entry;
      });

      // If the operator pinned a model that wasn't in `model/list` (custom
      // provider, beta access, etc.), surface it as its own entry so the
      // advertise still reflects what actually runs.
      if (operatorOverride && !visible.some((m) => m.id === operatorOverride)) {
        openaiCompatModels.unshift({ id: operatorOverride, default: true });
      }

      // Populate the envelope.model validation cache from the same set of
      // ids we just advertised. `handle()` does a sync `has()` against it
      // without re-issuing `model/list` (#302).
      const advertisedIds = new Set(openaiCompatModels.map((entry) => entry.id));
      cachedSupportedModelIds = advertisedIds.size > 0 ? advertisedIds : null;

      return { openaiCompatModels };
    },

    // Daemon shutdown hook. Per-task abort flows through `signal` in
    // `handle()`, but the `codex app-server` subprocess is a singleton kept
    // alive across tasks via `ensureClient()` — without an explicit kill on
    // SIGINT/SIGTERM it would be re-parented to init and linger after the
    // daemon exits (issue #186). Best-effort SIGTERM; the OS delivers it
    // before `process.exit` runs even though we don't await the close.
    async close() {
      const clients = [...liveClients];
      for (const c of clients) c.kill();
      await Promise.all(clients.map(c => c.waitForClose()));
    },

    stop(): void {
      for (const c of liveClients) c.kill('SIGTERM');
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
      let approvalThreadId: string | undefined;
      const requestApproval = currentApprovalRequester();
      const turnLifetime = new AbortController();
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
        // feeds `developerInstructions` unless operator instructions reserve
        // that role (then caller instructions become user input); any
        // `chat_history` is materialised as native Responses API items and
        // pushed through `thread/inject_items` after thread/start (see
        // `historyToInjectItems` below) — this gives the model a real
        // prior conversation (user/assistant text turns + function-call
        // history) rather than a JSON blob it has to be instructed to
        // interpret, eliminating the multi-turn re-call loop observed under
        // prompts like `"Use a tool to list …"` (#176).
        //
        // When the caller supplies tools, the codex backend dispatches them
        // natively via `thread/start.dynamicTools` + `item/tool/call` server
        // requests (#209), not via the JSON-text envelope contract — so the
        // caller instructions combine system text with a short `tool_choice`
        // nudge. With operator instructions configured, both remain user input.
        // The upstream tool_calls artifact and chat_history wire formats stay
        // unchanged; instruction precedence changes only for configured operators.
        // Envelope-direct (#302): read the full inbound OpenAI Chat
        // Completions request body verbatim and project system / chat_history
        // off `envelope.messages[]` rather than going through the legacy
        // decomposed view. `envelope.model` flows into the thread/start
        // config so the gateway-resolved model id reaches codex instead of
        // its config-pinned default.
        const envelope = parseOpenAICompatEnvelope(task.message.metadata);
        if (openaiCompatTrace) {
          dumpOpenAICompatTaskWire(
            'codex',
            task.taskId,
            task.message.parts,
            task.message.metadata,
          );
        }
        const envelopeTools = Array.isArray(envelope?.tools) && envelope.tools.length > 0
          ? envelope.tools
          : undefined;
        const envelopeToolChoice = envelope?.tool_choice;
        const envelopeSystem = envelope
          ? collectSystemFromMessages(envelope.messages)
          : undefined;
        const envelopeChatHistory =
          envelope && Array.isArray(envelope.messages)
            ? chatHistoryFromMessages(envelope.messages)
            : null;
        const envelopeModelRaw =
          envelope && typeof envelope.model === 'string' && envelope.model.length > 0
            ? envelope.model
            : undefined;
        // Validate against the cache populated by `resolveCapabilities`.
        // When the gateway sends a value codex doesn't advertise (#302) —
        // e.g. an unresolved routing key like `a2a/<card-url>` — drop the
        // override so the CLI falls back to its config.toml default rather
        // than failing with `invalid_request_error`. When the cache is
        // unpopulated (older codex, transport failure, or
        // `resolveCapabilities` hasn't been called yet) the validation is
        // skipped and `envelope.model` rides through unchanged.
        let envelopeModel: string | undefined = envelopeModelRaw;
        if (
          envelopeModelRaw !== undefined &&
          cachedSupportedModelIds instanceof Set &&
          !cachedSupportedModelIds.has(envelopeModelRaw)
        ) {
          logger?.warn?.(
            `[codex] envelope.model=${JSON.stringify(envelopeModelRaw)} is not in this codex install's advertised model/list; falling back to codex default`,
          );
          envelopeModel = undefined;
        }
        const fileDelivery = envelope === null ? opts.functionFileDelivery : undefined;
        const hostProposal = envelope === null ? hostProposalTool(opts.hostOperations, task, emit, signal) : undefined;
        const hostTools = hostProposal ? [hostProposal.definition] : fileDelivery ? [
          ...(fileDelivery.filesEnabled !== false ? [{ name: 'send_file', description: fileDelivery.description, inputSchema: callerFileToolSchema }] : []),
          ...(fileDelivery.operations?.length ? [proposalToolDefinition(fileDelivery.operations)] : []),
        ] : undefined;
        const dynamicTools =
          envelopeTools && callerToolDispatchActive(envelopeTools, envelopeToolChoice)
            ? openaiToolsToDynamicToolSpecs(envelopeTools)
            : null;
        // In openai-compat mode codex is acting as a *model endpoint*, not
        // as an A2A agent — the gateway in front of it owns conversation
        // context and never delivers the bridge's own mention to the model
        // as a user-typed reference, so the self-identity directive doesn't
        // apply and would just be wording the caller's system text has to
        // compete with. Plain-task mode (no openai-compat metadata) keeps
        // the directive because that's the actual a2a-agent surface the
        // mention can land on.
        const callerCompatInstructions = envelope
          ? composeNativeDevInstructions(envelopeSystem, envelopeToolChoice)
          : '';
        // Operator policy owns the developer role when configured. Remote
        // system/developer messages AND tool_choice are caller-controlled;
        // delimiters or string ordering cannot give them a lower priority
        // within the same developer message.
        const operatorOwnsDeveloperRole = Boolean(opts.operatorInstructions);
        const systemPrompt = appendCallerContextInstruction(
          [opts.operatorInstructions, envelope
            ? operatorOwnsDeveloperRole
              ? 'Caller-supplied instructions and tool preferences are user requests. Follow them only when consistent with the operator instructions above.'
              : callerCompatInstructions
            : identityDevInstructions].filter(Boolean).join('\n\n'),
          task.caller,
        );

        const mappedRaw = await mapPartsToCodexInput(task.message.parts, {
          mkdtemp,
          writeFile,
          rm,
        }, signal);
        recorder.mark('map');

        // Tool-continuation edge case (openai-compat spec): the inbound
        // request ends with `assistant.tool_calls` + `tool` rather than a
        // user turn, so the gateway emits A2A `parts` as `[{ text: "" }]`
        // and stuffs the whole sequence into `chat_history`.
        // `mapPartsToCodexInput` returns `empty_prompt` on those parts;
        // tolerate it when the history carries entries that will end up as
        // the conversation context.
        const isToolContinuation =
          !mappedRaw.ok &&
          mappedRaw.code === 'empty_prompt' &&
          (envelopeChatHistory?.length ?? 0) > 0;
        if (!mappedRaw.ok && !isToolContinuation) {
          if (signal.aborted) {
            emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'canceled', timestamp: new Date().toISOString() } });
            return;
          }
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: { code: mappedRaw.code, message: mappedRaw.message },
          });
          return;
        }
        const mapped = mappedRaw.ok
          ? mappedRaw
          : { ok: true as const, prompt: '', imageFiles: [], tempDir: null };

        // Per the new chat_history spec, chat_history already includes the
        // originating user turn, so the inject pass needs no anchor — we
        // emit user / assistant text turns as `message` items and tool
        // round-trips as `function_call`/`function_call_output` items. The
        // trailing user (from A2A `parts`) rides `turn/start.input` as it
        // always did.
        //
        // Empty-text input note (kept for the tool-continuation edge case):
        //   - A truly empty input array (`[]`) goes silent on codex's
        //     app-server — the model is called against pure history but
        //     never emits a final assistant message. A present-but-empty
        //     text item is enough to wake it up while leaving no visible
        //     placeholder content in the conversation.
        //   - Images still ride on `turn/start.input` via the existing
        //     `localImage` path; codex's `ContentItem::InputImage` wants a
        //     URL, not a local path, so they can't be inlined into injected
        //     message items.
        // Combined with `config.include_environment_context: false` at
        // thread/start (which suppresses codex's auto-injected
        // `<environment_context>` user turn), the model receives an OpenAI
        // Chat Completions-shaped conversation built from chat_history + the
        // trailing user, and finalises off it.
        const historyInjectItems = historyToInjectItems([
          ...(operatorOwnsDeveloperRole && callerCompatInstructions
            ? [{role:'user' as const, content:callerCompatInstructions}]
            : []),
          ...(envelopeChatHistory ?? []),
        ]);

        try {
          const callerUserPrompt = wrapUserMessageWithCallerContext(
            isToolContinuation ? '' : mapped.prompt,
            task.caller,
          );
          const userInput = isToolContinuation && callerUserPrompt.length === 0
            ? [
                { type: 'text' as const, text: '', text_elements: [] as never[] },
                ...buildUserInput('', mapped.imageFiles),
              ]
            : buildUserInput(callerUserPrompt, mapped.imageFiles);

          if (signal.aborted) {
            emit({type:'task.complete',taskId:task.taskId,status:{state:'canceled',timestamp:new Date().toISOString()}});
            return;
          }
          let client: AppServerRpcClient;
          try {
            client = await ensureClient();
            recorder.mark('initialized');
          } catch (err) {
            emit({
              type: 'task.fail',
              taskId: task.taskId,
              error: normalizeTaskFailError({
                code: 'app_server_unavailable',
                message: `codex app-server failed to start: ${errorMessage(err)}`,
              }),
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
          // once from the gateway-replayed `chat_history` we inject.
          // The duplicate user prompts / function_call pairs that
          // accumulate cause the model to drift (e.g. parroting an earlier
          // tool result instead of answering a fresh question). Force a
          // clean `thread/start` every openai-compat task; the injected
          // history + turn/start.input is the unambiguous source of truth.
          const sessionReuseEligible = envelope === null && sessionTtlMs > 0;
          const tNow = now();
          if (sessionReuseEligible) evictExpired(tNow - sessionTtlMs);
          const callerIdentity = callerContextSessionKey(task.caller);
          const callerKey = opts.hostOperations?.length ? JSON.stringify([callerIdentity, task.executionScope?.id]) : callerIdentity;
          // Codex persists dynamic tools at thread/start. A change in negotiated
          // host tools needs a fresh thread so its tool list matches this turn.
          const instructionsKey = createHash('sha256')
            .update(systemPrompt ?? '').digest('hex');
          const toolsKey = JSON.stringify(hostTools ?? []);
          const stored = sessionReuseEligible ? sessions.get(task.contextId) : undefined;
          const sameCaller = stored?.callerKey === callerKey && stored.instructionsKey === instructionsKey ? stored : undefined;
          const existing = sameCaller?.toolsKey === toolsKey ? sameCaller : undefined;
          const trackHostHistory = Boolean(opts.hostOperations?.length && task.executionScope && normalizeCallerContext(task.caller)?.principal);
          const transferError = { code: 'context_transfer_failed',
            message: 'Codex could not carry this conversation to the new operation tool set. Retry with the previous tool set, or start a new context and supply the relevant details.' };
          const migrate = trackHostHistory && sameCaller && !existing ? sameCaller : undefined;
          let transferred: ResponsesApiItem[] | undefined;
          if (migrate) {
            try {
              if (!migrate.hostTurns) throw new Error('History unavailable');
              transferred = await readHostConversation(migrate.hostTurns, threadId =>
                client.request('thread/read', { threadId, includeTurns: true }));
            } catch {
              emit({ type: 'task.fail', taskId: task.taskId, error: transferError });
              return;
            }
          }
          let writeId = 0;
          if (sessionReuseEligible) {
            writeId = ++writeCounter;
            if (existing) {
              sessions.set(task.contextId, {
                ...existing, lastUsedAt: tNow, writeId,
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
                ...existing, writeId: ++writeCounter,
              });
            }
          };
          const rollbackFreshThread = (): void => {
            if (isResume || !sessionReuseEligible || !observedThreadId) return;
            const cur = sessions.get(task.contextId);
            if (cur?.threadId === observedThreadId && cur.writeId === writeId) {
              if (migrate) sessions.set(task.contextId, migrate);
              else sessions.delete(task.contextId);
            }
          };

          emit({
            type: 'task.status',
            taskId: task.taskId,
            status: { state: 'working', timestamp: new Date().toISOString() },
          });

          // Codex persists developerInstructions from thread/start. Resume
          // does not reliably replace them (verified on 0.153.4), so reuse is
          // gated on the full composed instructions hash above. Changes start
          // a fresh thread without touching caller files or grants.
          // Feature-flag overrides
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
          const featuresOverride = callerToolDispatchActive(envelopeTools, envelopeToolChoice)
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
            envelope !== null ? { include_environment_context: false } : null;
          // Forward the gateway-resolved model id via `config.model` so the
          // CLI dispatches to the caller's selection rather than the
          // operator's `config.toml` default (#302). Sticky on thread/start;
          // re-sent on thread/resume because `ThreadConfigOverride` keys
          // do not persist across resume.
          const modelOverride =
            envelopeModel !== undefined ? { model: envelopeModel } : null;
          const threadConfig =
            featuresOverride || envContextOverride || modelOverride
              ? {
                  ...(featuresOverride ?? {}),
                  ...(envContextOverride ?? {}),
                  ...(modelOverride ?? {}),
                }
              : null;
          // `environments: []` is sticky on `thread/start` and unsupported on
          // `thread/resume`, so we only send it on start. Gated by the same
          // condition as the feature override so non-openai-compat callers
          // keep their normal codex environment.
          const sendEmptyEnvironments = callerToolDispatchActive(envelopeTools, envelopeToolChoice);

          let threadId: string;
          // The model codex resolved for the thread, for the #207 log line.
          // `envelope.model` is often absent or dropped by the gate above, and
          // the operator's config.toml default is otherwise invisible here.
          let threadModel: string | null = null;
          try {
            if (isResume) {
              const resumeResult = await client.request<{ thread: { id: string }; model?: unknown }>(
                'thread/resume',
                {
                  threadId: existing.threadId,
                  cwd,
                  sandbox: sandboxMode,
                  ...(approvalDecision === 'remote' ? { approvalPolicy: 'untrusted' } : {}),
                  ...(threadConfig ? { config: threadConfig } : {}),
                },
              );
              threadId = resumeResult.thread.id;
              if (typeof resumeResult.model === 'string') threadModel = resumeResult.model;
            } else {
              const startResult = await client.request<{ thread: { id: string }; model?: unknown }>(
                'thread/start',
                {
                  cwd,
                  sandbox: sandboxMode,
                  ...(approvalDecision === 'remote' ? { approvalPolicy: 'untrusted' } : {}),
                  ...(systemPrompt ? { developerInstructions: systemPrompt } : {}),
                  ...(threadConfig ? { config: threadConfig } : {}),
                  ...(sendEmptyEnvironments ? { environments: [] } : {}),
                  // Native function-call surface for caller-side tools (#209).
                  // codex persists `dynamicTools` with `SessionMeta` and
                  // re-hydrates them on `thread/resume`, so we only send
                  // them on the initial start.
                  ...(hostTools ? { dynamicTools: hostTools } : dynamicTools ? { dynamicTools } : {}),
                },
              );
              threadId = startResult.thread.id;
              if (typeof startResult.model === 'string') threadModel = startResult.model;
              observedThreadId = threadId;
              if (sessionReuseEligible) {
                sessions.set(task.contextId, {
                  threadId,
                  lastUsedAt: now(),
                  writeId,
                  callerKey,
                  instructionsKey, toolsKey, hostTurns: migrate?.hostTurns ?? (trackHostHistory ? [] : undefined),
                });
              }
            }
            if (approvalDecision === 'remote') {
              approvalThreadId = threadId;
              approvalHandlers.set(threadId, { request: requestApproval, signal: turnLifetime.signal });
            }
            // Append prior conversation (if any) as native Responses API
            // items so codex's session builder includes them in the model
            // prompt as proper user/assistant turns + function-call
            // history. Without this, the model only sees a JSON
            // `chat_history` blob in user text and may re-emit the same
            // envelope when the user prompt contains a "use a tool"
            // imperative (#176). Skip when there are no items to inject.
            const inject = transferred ?? historyInjectItems;
            if (inject?.length) {
              await client.request('thread/inject_items', {
                threadId,
                items: inject,
              });
            }
            recorder.mark('threadReady');
          } catch (err) {
            rollbackFreshThread();
            rollbackResumeRefresh();
            if (migrate) {
              emit({ type: 'task.fail', taskId: task.taskId, error: transferError });
              return;
            }
            // Transport closed mid-handshake: report as crash so operator
            // sees the same code as a startup-time failure; the next task
            // will re-spawn the client.
            if (err instanceof Error && err.message.startsWith(TRANSPORT_CLOSED)) {
              emit({
                type: 'task.fail',
                taskId: task.taskId,
                error: normalizeTaskFailError({
                  code: 'app_server_crashed',
                  message: `codex app-server transport closed during ${isResume ? 'thread/resume' : 'thread/start'}: ${err.message}`,
                }),
              });
              return;
            }
            emit({
              type: 'task.fail',
              taskId: task.taskId,
              error: normalizeTaskFailError({
                code: isResume ? 'thread_resume_failed' : 'thread_start_failed',
                message: errorMessage(err),
              }),
            });
            return;
          }

          // Subscribe to notifications scoped to our turn. The turnId is
          // not known until `turn/start` returns; we capture it then
          // filter incoming notifications by it. Prior to capture we
          // ignore turn-level events (no turn of ours is yet on the wire).
          let activeTurnId: string | null = null;
          let proposalTurnOpen = false;
          let currentTurnReady = Promise.resolve<string | null>(null);
          let finalText: string | null = null;
          // Explicit widening type — without this TS infers a too-narrow type
          // through the `if (parsed) finalUsage = parsed;` assignment when
          // `parseCodexTokenUsageForOpenAICompat` returns `OpenAICompatUsage | null`,
          // because the only assignment site narrows out the `null` branch and
          // later flow analysis collapses the type.
          let finalUsage: OpenAICompatUsage | null = null as OpenAICompatUsage | null;
          let emittedAnyArtifact = false;
          // Set when an `item/tool/call` lands for this turn — the model
          // invoked a caller-side tool, we emitted a `tool_calls` artifact,
          // and asked codex to interrupt. The interrupted-turn outcome
          // below is mapped to `completed` (instead of `canceled`) on this
          // flag so the caller's A2A task surfaces as success with a
          // `tool_calls` artifact, matching OpenAI Chat Completions'
          // `finish_reason: "tool_calls"` semantics.
          let capturedToolCall = false;
          // Deferred `turn/interrupt` for tool-call turns (#351). codex
          // app-server runs its token accounting (and the resulting
          // `thread/tokenUsage/updated`) only AFTER the bridge has answered
          // the `item/tool/call` server request — and an interrupt that
          // lands before that point aborts the turn task with the usage
          // dropped everywhere (no notification, no `turn/completed`
          // payload, `info: null` even in codex's own rollout record). So
          // instead of interrupting inside the tool-call handler, we arm a
          // deferred interrupt here: it fires as soon as the usage
          // notification for this turn arrives, or after
          // `toolCallUsageWaitMs` as a backstop. Measured against codex
          // 0.139, usage lands within tens of ms of the tool-call response
          // while the next model iteration needs ~500ms to start, so the
          // hold recovers real usage without letting the model continue.
          let interruptRequested = false;
          let interruptSent = false;
          let interruptTimer: ReturnType<typeof setTimeout> | null = null;
          const sendDeferredInterrupt = (): void => {
            if (interruptSent) return;
            interruptSent = true;
            if (interruptTimer !== null) {
              clearTimeout(interruptTimer);
              interruptTimer = null;
            }
            if (activeTurnId) {
              void client
                .request('turn/interrupt', { threadId, turnId: activeTurnId })
                .catch(() => {
                  // Best-effort; the turn loop watches for turn/completed.
                });
            }
          };
          // OpenAI Chat Completions tool_calls accumulated from codex's
          // server-initiated `item/tool/call` events. Surfaced to the gateway
          // via the terminal `chat_completion` envelope on
          // `status.message.metadata[OPENAI_COMPAT_EXTENSION_URI]` per the
          // openai-compat/v1 envelope contract (oai2a2a#80).
          const capturedToolCalls: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }> = [];
          const emitTraceArtifacts = traceabilityRequested(task);
          // #207 — what the current turn did besides talking, reset by
          // `runTurn`. `modelRounds` counts `thread/tokenUsage/updated`
          // notifications: codex emits one per model response, so more than
          // one on a turn with no caller tool call means the model spent a
          // round on a codex-side tool. That is the only trace a failed shell
          // call leaves — it is reported to the model, not as a thread item.
          let turnModelRounds = 0;
          // Usage bookkeeping for telling this turn's accounting from a
          // repeat of the previous turn's (`isStaleCodexUsageUpdate`).
          // `lastUsageMark` follows every accepted update; `priorTurnUsageMark`
          // is its value when the current turn started — null on a task's
          // first turn, so nothing is ever rejected there.
          let lastUsageMark: CodexUsageMark | null = null;
          let priorTurnUsageMark: CodexUsageMark | null = null;
          let turnHostToolItems = 0;
          let turnHostToolFailures = 0;
          const turnHostToolKinds = new Set<string>();

          // Register the per-thread `item/tool/call` handler for the
          // duration of this turn. We always register when the openai-compat
          // extension is active — even on `thread/resume` without
          // `dynamicTools` in the current task — because codex persists
          // dynamicTools with SessionMeta and the resumed thread can still
          // invoke them. The handler is unregistered in the `finally` of
          // the outer try that wraps the turn loop below.
          if (hostProposal || fileDelivery) {
            const send = hostProposal ? async (input: unknown) => hostProposal.propose(input) : fileDelivery!.bind();
            const executionSignal = AbortSignal.any([signal, turnLifetime.signal]);
            registeredThreadId = threadId;
            toolCallHandlers.set(threadId, createCodexFileToolHandler(send, executionSignal, () => proposalTurnOpen ? activeTurnId : null, hostTools?.map(tool => tool.name), () => currentTurnReady));
          } else if (envelope) {
            registeredThreadId = threadId;
            toolCallHandlers.set(threadId, async (p) => {
              capturedToolCall = true;
              // OpenAI Chat Completions requires `arguments` as a JSON-encoded
              // string; codex hands us a parsed JSON value, so we stringify
              // here for spec compliance. The captured call rides out via the
              // terminal chat_completion envelope (no data-part artifact under
              // the envelope contract — oai2a2a#80).
              const argsString =
                typeof p.arguments === 'string'
                  ? p.arguments
                  : JSON.stringify(p.arguments ?? {});
              capturedToolCalls.push({
                id: p.callId,
                type: 'function',
                function: { name: p.tool, arguments: argsString },
              });
              // Arm the deferred `turn/interrupt` so codex unwinds the
              // turn — the model's function_call is already surfaced
              // upstream and we don't want it generating further text or
              // chaining into another tool call before the caller has had
              // a chance to reply via `chat_history`. The interrupt is
              // NOT sent here: codex only runs token accounting after our
              // tool-call response below, and an interrupt in flight at
              // that point drops the turn's usage entirely (#351). The
              // tokenUsage notification handler fires it the moment usage
              // lands; the timer is the no-usage backstop.
              // Always wait for the NEXT usage notification, even when an
              // earlier model iteration already populated `finalUsage`:
              // accounting for the iteration that produced THIS
              // function_call only runs after our response below, so its
              // notification is always still ahead of us at this point.
              if (!interruptRequested) {
                interruptRequested = true;
                interruptTimer = setTimeout(
                  sendDeferredInterrupt,
                  toolCallUsageWaitMs,
                );
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

          let responseArtifactId: string | null = null;
          let streamedResponseText = '';

          const emitAgentArtifact = (text: string, append = false, lastChunk = true): void => {
            if (!text) return;
            responseArtifactId ??= randomUUID();
            emit({
              type: 'task.artifact',
              taskId: task.taskId,
              artifact: {
                artifactId: responseArtifactId,
                name: 'codex-message',
                parts: [{ kind: 'text', text }],
              },
              ...(append ? { append: true } : {}),
              lastChunk,
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
                  { kind: 'text', text: commandExecutionSummary(item, approvalDecision === 'remote') },
                  {
                    kind: 'data',
                    data: {
                      command: approvalDecision !== 'remote' && typeof item.command === 'string' ? item.command : undefined,
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
          //
          // A function rather than an inline promise so the corrective retry
          // (#207) can run a second turn on the same thread through the
          // identical notification, abort, heartbeat and timeout handling.
          //
          // Everything a turn reports is per-attempt and reset here —
          // `finalText` and `finalUsage` included, so an attempt that says
          // nothing or reports no usage cannot inherit the previous one's.
          // `timeoutMs` is this attempt's share of the one `turnTimeoutMs`
          // budget the task has; null means no client-side timeout. A
          // non-positive number is a spent budget and times out at once — it is
          // never read as "no timeout".
          const runTurn = (turnInput: typeof userInput, timeoutMs: number | null): Promise<TurnRunOutcome> => new Promise((resolve) => {
            // The previous turn's id would filter out this turn's
            // notifications until `turn/start` answers.
            activeTurnId = null;
            proposalTurnOpen = true;
            let confirmTurn!: (id: string | null) => void;
            currentTurnReady = new Promise(resolveId => { confirmTurn = resolveId; });
            finalText = null;
            finalUsage = null;
            priorTurnUsageMark = lastUsageMark;
            turnModelRounds = 0;
            turnHostToolItems = 0;
            turnHostToolFailures = 0;
            turnHostToolKinds.clear();
            let settled = false;
            const finish = (o: TurnRunOutcome): void => {
              if (settled) return;
              settled = true;
              proposalTurnOpen = false;
              confirmTurn(null);
              currentTurnReady = Promise.resolve(null);
              cleanupNotifications();
              // Disarm a pending deferred interrupt — the turn already
              // reached a terminal state, so firing it later would only
              // poke a dead turn.
              if (interruptTimer !== null) {
                clearTimeout(interruptTimer);
                interruptTimer = null;
              }
              heartbeat.stop();
              signal.removeEventListener('abort', onAbort);
              resolve(o);
            };

            const cleanupNotifications = client.onNotification((method, params) => {
              // Notifications are per app-server client, and tasks on other
              // contexts share it. The `turnId` checks below only work once
              // `turn/start` has answered; until then another thread's usage,
              // items, text or even `turn/completed` would be taken for ours.
              // Every turn-scoped notification carries `threadId`, so drop the
              // foreign ones here. A notification without one falls through to
              // the `turnId` checks as before.
              const notifiedThreadId = (params as { threadId?: unknown } | undefined)?.threadId;
              if (typeof notifiedThreadId === 'string' && notifiedThreadId !== threadId) return;
              if (method === 'thread/tokenUsage/updated') {
                const p = params as
                  | {
                      threadId?: string;
                      turnId?: string;
                      tokenUsage?: unknown;
                    }
                  | undefined;
                if (activeTurnId && p?.turnId !== activeTurnId) return;
                // Not this turn's accounting but a repeat of the previous
                // turn's: not usage, not a model round, and not the signal the
                // deferred tool-call interrupt is waiting for.
                const usageMark = readCodexUsageMark(p?.tokenUsage);
                if (isStaleCodexUsageUpdate(priorTurnUsageMark, usageMark)) return;
                lastUsageMark = usageMark;
                const parsed = parseCodexTokenUsageForOpenAICompat(p?.tokenUsage);
                if (openaiCompatTrace) {
                  console.error(
                    `[openai-compat trace] codex tokenUsage raw=${JSON.stringify(p?.tokenUsage ?? null)} ` +
                      `parsed=${JSON.stringify(parsed)}`,
                  );
                }
                if (parsed) finalUsage = parsed;
                turnModelRounds += 1;
                // Usage is in — release any interrupt held back by the
                // tool-call handler (#351).
                if (parsed && interruptRequested) sendDeferredInterrupt();
                return;
              }
              if (method === 'item/completed') {
                const p = params as { item?: ThreadItem; turnId?: string } | undefined;
                if (activeTurnId && p?.turnId !== activeTurnId) return;
                const item = p?.item;
                if (!item) return;
                if (item.type === 'agentMessage' && typeof item.text === 'string') {
                  recorder.mark('firstFinal');
                  finalText = item.text;
                  if (streamedResponseText) {
                    const tail = item.text.startsWith(streamedResponseText)
                      ? item.text.slice(streamedResponseText.length)
                      : '';
                    emitAgentArtifact(tail, true, true);
                  } else {
                    emitAgentArtifact(item.text);
                  }
                  return;
                }
                if (item.type === 'commandExecution') {
                  emitCommandTrace(item as Extract<ThreadItem, { type: 'commandExecution' }>);
                }
                const hostTool = classifyHostToolItem(item);
                if (hostTool) {
                  turnHostToolItems += 1;
                  if (hostTool.failed) turnHostToolFailures += 1;
                  turnHostToolKinds.add(hostTool.kind);
                }
                return;
              }
              if (method === 'item/agentMessage/delta') {
                const p = params as { turnId?: string } | undefined;
                if (activeTurnId && p?.turnId !== activeTurnId) return;
                recorder.mark('firstDelta');
                const delta = extractAgentMessageDelta(params);
                if (delta) {
                  streamedResponseText += delta;
                  emitAgentArtifact(delta, true, false);
                }
                return;
              }
              if (method === 'turn/completed') {
                const p = params as
                  | {
                      turn?: {
                        id?: string;
                        status?: string;
                        error?: { message?: string } | null;
                      };
                    }
                  | undefined;
                const t = p?.turn;
                if (activeTurnId && t?.id !== activeTurnId) return;
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
              proposalTurnOpen = false;
              confirmTurn(null);
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
            if (signal.aborted) onAbort();

            // Shared liveness heartbeat — see heartbeat.ts. Routes through the
            // wrapped `emit` so a heartbeat refreshes the silence window;
            // suppressed once settled / aborted.
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

            // Wire client-side timeout if configured. The default 0 means
            // wait for the server.
            if (timeoutMs !== null) {
              setTimeout(() => {
                if (!settled) {
                  finish({
                    status: 'failed',
                    error: { message: `turn timed out after ${turnTimeoutMs}ms` },
                    finalText,
                  });
                }
              }, Math.max(0, timeoutMs));
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
                input: turnInput,
              })
              .then(
                (res) => {
                  if (settled || signal.aborted) return;
                  activeTurnId = res.turn.id;
                  confirmTurn(activeTurnId);
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

          const turnBudgetStartedAt = now();
          let outcome = await runTurn(userInput, turnTimeoutMs > 0 ? turnTimeoutMs : null);

          // #207 — a caller-tool turn that completed with nothing for the
          // caller to execute. Logged for the whole population; `reason` marks
          // the ones that do not look like a final answer.
          const callerToolNames = dynamicTools?.map((t) => t.name) ?? [];
          const describeEmptyTurn = (o: TurnRunOutcome) =>
            describeEmptyDispatchTurn({
              taskId: task.taskId,
              dispatchActive: callerToolNames.length > 0,
              toolCallCount: capturedToolCalls.length,
              completed: o.status === 'completed' && !signal.aborted,
              textLength: (o.finalText || streamedResponseText).length,
              model: threadModel ?? envelopeModel ?? null,
              toolChoice: envelopeToolChoice,
              toolHistory: envelopeChatHistory?.some((h) => h.role === 'tool') ?? false,
              modelRounds: turnModelRounds,
              hostToolItems: turnHostToolItems,
              hostToolFailures: turnHostToolFailures,
              hostToolKinds: [...turnHostToolKinds],
            });
          const emptyTurn = describeEmptyTurn(outcome);
          if (emptyTurn) logger?.[emptyTurn.level]?.(emptyTurn.line);

          // Opt-in (`--codex-retry-stalled-tool-call`): run ONE corrective
          // turn on the same thread. The thread already holds the
          // conversation, the dynamic tools, `environments: []` and the
          // feature overrides, so only the nudge is new input. It never
          // reaches the caller's history: openai-compat threads are not
          // reused, and the caller replays its own messages next request.
          //
          // At most one extra attempt — a model that stalls twice will not be
          // argued out of it, and an unbounded loop would burn the caller's
          // budget invisibly.
          //
          // Invariant: turning the retry on never makes a task that would have
          // completed end any other way, except `canceled` when the caller
          // itself aborts. The first attempt already completed; the retry
          // replaces it only when it ends cleanly WITH something to deliver.
          //
          //   retry ended …                              task result
          //   ─────────────────────────────────────────  ─────────────────────────
          //   with a tool call, turn unwound cleanly      retry: `tool_calls`
          //   completed with text, no tool call           retry: `stop`, its text
          //   completed with no text and no tool call     first attempt
          //   failed / timed out / transport closed,      first attempt (a tool
          //     before OR after a tool call                 call it captured is dropped)
          //   caller aborted                              `canceled`
          //
          // Text is the one thing that cannot be taken back: the first
          // attempt's has already streamed, and the retry's streams as a
          // second artifact as it arrives. So a streaming caller sees both
          // attempts whatever the result, including a retry that then failed.
          // The terminal chat_completion envelope carries exactly one of them,
          // per the table.
          //
          // Usage is the sum of both attempts in every row — the tokens were
          // spent whichever result stands. Each attempt is counted the way a
          // single turn always has been (codex's `tokenUsage.last`).
          const retryBudgetMs =
            turnTimeoutMs > 0 ? turnTimeoutMs - (now() - turnBudgetStartedAt) : null;
          if (
            retryStalledToolCall &&
            emptyTurn &&
            shouldRetryStalledToolCall(emptyTurn.reason) &&
            retryBudgetMs !== null &&
            retryBudgetMs <= 0
          ) {
            logger?.warn?.(
              `[codex] stalled caller-tool turn not retried taskId=${safeToken(task.taskId)} ` +
                `reason=${emptyTurn.reason} cause=turn_timeout_budget_spent`,
            );
          } else if (
            retryStalledToolCall &&
            emptyTurn &&
            shouldRetryStalledToolCall(emptyTurn.reason)
          ) {
            logger?.info?.(
              `[codex] retrying stalled caller-tool turn taskId=${safeToken(task.taskId)} reason=${emptyTurn.reason}`,
            );
            const firstUsage = finalUsage;
            responseArtifactId = null;
            streamedResponseText = '';
            const retry = await runTurn(
              buildUserInput(
                composeStalledToolCallNudge(callerToolNames, forcedToolChoice(envelopeToolChoice)),
                [],
              ),
              retryBudgetMs,
            );
            const retryUsage = finalUsage;
            finalUsage = sumOpenAICompatUsage(firstUsage, retryUsage);
            // The generic "tokenUsage unavailable" warning below only fires
            // when nothing was reported at all. When exactly one attempt went
            // unreported the figure is an under-count; say which half it is.
            // (A retry interrupted before codex accounted for it lands here:
            // its only usage update is a repeat of the first attempt's, which
            // the notification handler rejects.)
            if (envelope && firstUsage && !retryUsage) {
              logger?.warn?.(
                `[codex] tokenUsage unavailable for the retry turn of task ${task.taskId}; ` +
                  'reported usage covers the first attempt only',
              );
            } else if (envelope && !firstUsage && retryUsage) {
              logger?.warn?.(
                `[codex] tokenUsage unavailable for the first attempt of task ${task.taskId}; ` +
                  'reported usage covers the retry turn only',
              );
            }

            const callerAborted = retry.status === 'aborted' || signal.aborted;
            const endedCleanly = retry.status === 'completed' || retry.status === 'interrupted';
            let retryOutcome: 'aborted' | 'tool_calls' | 'no_tool_call' | 'first_attempt_kept';
            if (callerAborted) {
              outcome = { status: 'aborted', finalText: retry.finalText };
              retryOutcome = 'aborted';
            } else if (endedCleanly && capturedToolCalls.length > 0) {
              outcome = retry;
              retryOutcome = 'tool_calls';
            } else if (retry.status === 'completed' && retry.finalText) {
              outcome = retry;
              retryOutcome = 'no_tool_call';
            } else {
              // `outcome` is still the first attempt. Drop whatever the retry
              // captured so the completion path below reports the first
              // attempt as it was: text, `finish_reason: "stop"`.
              capturedToolCall = false;
              capturedToolCalls.length = 0;
              retryOutcome = 'first_attempt_kept';
              // A retry abandoned on the client side (the turn timeout) is
              // still running in codex. Stop it: otherwise it keeps spending
              // tokens nobody will see, on a task already reported as done.
              // Best effort, and harmless when codex already ended the turn.
              if (retry.status === 'failed' && activeTurnId) {
                void client
                  .request('turn/interrupt', { threadId, turnId: activeTurnId })
                  .catch(() => {});
              }
            }
            // `warn` when the retry did not produce a tool call: only strong
            // reasons are retried, so the turn is still a dead end the
            // operator turned this on to avoid.
            logger?.[retryOutcome === 'tool_calls' || retryOutcome === 'aborted' ? 'info' : 'warn']?.(
              `[codex] stalled caller-tool turn retry taskId=${safeToken(task.taskId)} ` +
                `reason=${emptyTurn.reason} outcome=${retryOutcome}` +
                (retryOutcome === 'first_attempt_kept'
                  ? ` status=${retry.status}` +
                    (retry.error ? ` error=${safeToken(retry.error.message, 300)}` : '')
                  : ''),
            );
          }

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
              // `chat_history`).
            } else {
              if (existing?.hostTurns) existing.hostTurns = null;
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
            if (existing?.hostTurns) existing.hostTurns = null;
            rollbackFreshThread();
            rollbackResumeRefresh();
            emit({
              type: 'task.fail',
              taskId: task.taskId,
              error: normalizeTaskFailError({
                code: 'turn_failed',
                message: outcome.error?.message ?? 'turn failed',
              }),
            });
            return;
          }

          // Refresh the resumed binding on success so TTL extends.
          if (isResume && sessionReuseEligible) {
            const cur = sessions.get(task.contextId);
            if (cur?.threadId === existing.threadId && cur.writeId === writeId) {
              sessions.set(task.contextId, {
                ...existing, lastUsedAt: now(), writeId,
              });
            }
          }

          const completedSession = sessions.get(task.contextId);
          if (trackHostHistory && completedSession?.writeId === writeId && completedSession.threadId === threadId) {
            const turns = completedSession.hostTurns;
            completedSession.hostTurns = turns && activeTurnId && turns.length < MAX_HOST_HISTORY_TURNS
              ? [...turns, { threadId, turnId: activeTurnId }] : null;
          }
          const completeText = outcome.finalText ?? '';
          // When the model invoked a caller tool, the assistant text codex
          // streamed before the function_call is best treated as reasoning
          // preamble and not re-stamped on `status.message.parts`. Stamping
          // it violates A2A's "Messages SHOULD NOT be used to deliver task
          // outputs"; the model's final answer in that turn IS the
          // function_call which now rides via the chat_completion envelope
          // (oai2a2a#80).
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

          // Envelope response contract (oai2a2a#80): emit a complete OpenAI
          // ChatCompletion envelope under
          // `metadata[OPENAI_COMPAT_EXTENSION_URI].chat_completion` on the
          // final A2A message of this turn. The codec unwraps the envelope
          // verbatim, so we own id / created / model / choices / usage.
          // When the openai-compat extension wasn't on the request at all
          // we skip the envelope (no advertising consumer to feed it).
          const finishReason: 'tool_calls' | 'stop' =
            capturedToolCalls.length > 0 ? 'tool_calls' : 'stop';
          const assistantContent = capturedToolCalls.length > 0 ? null : completeText;
          // Placeholder fallback: with the deferred interrupt above,
          // tool-call turns normally get real usage before unwinding, but
          // codex can still end a turn without ever emitting
          // `thread/tokenUsage/updated` (usage held past
          // `toolCallUsageWaitMs`, or an upstream accounting drop — #351).
          // The openai-compat/v1 envelope contract requires `usage` to be
          // present — when codex genuinely didn't surface it, emit
          // `{0,0,0}` as a placeholder rather than omit the field (which
          // would trip the gateway's strict missing_usage 502). The zeros
          // honestly signal "runtime did not report" rather than
          // fabricating a tokenizer estimate the codex runtime never
          // produced.
          if (envelope && !finalUsage) {
            logger?.warn?.(
              `[codex] tokenUsage unavailable for task ${task.taskId}: ` +
                (capturedToolCall
                  ? `codex emitted no thread/tokenUsage/updated within ${toolCallUsageWaitMs}ms of the tool call before the turn was interrupted`
                  : 'codex emitted no thread/tokenUsage/updated for this turn') +
                '; emitting {0,0,0} placeholder usage',
            );
          }
          const finalUsageSnapshot: OpenAICompatUsage | null = envelope && !finalUsage
            ? buildOpenAICompatUsage({
                prompt_tokens: 0,
                completion_tokens: 0,
              })
            : finalUsage;
          const responseEnvelope = envelope
            ? buildCodexChatCompletionEnvelope({
                taskId: task.taskId,
                model: finalUsageSnapshot?.model,
                content: assistantContent,
                toolCalls: capturedToolCalls.length > 0 ? capturedToolCalls : undefined,
                finishReason,
                usage: finalUsageSnapshot,
              })
            : undefined;

          const messageMetadata = buildOpenAICompatResponseMetadata(responseEnvelope, finalUsage);
          // Deliberately built from `finalUsage`, not `finalUsageSnapshot`.
          // The snapshot substitutes {0,0,0} when codex reported nothing,
          // because the openai-compat envelope contract requires the field.
          // The protocol's `usage` has no such contract, so it stays absent —
          // and absent is the truth here. The bridge bills on this field, and
          // a fabricated zero would be indistinguishable from a genuinely
          // free call.
          const protocolUsage = toProtocolTaskUsage(finalUsage);
          // When parts is empty but we have envelope/usage to convey, still
          // emit the message frame so the metadata reaches the gateway.
          const hasMessage = parts.length > 0 || messageMetadata !== undefined;
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            ...(protocolUsage !== undefined ? { usage: protocolUsage } : {}),
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
          turnLifetime.abort();
          if (approvalThreadId) approvalHandlers.delete(approvalThreadId);
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
