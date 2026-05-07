import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { TRACEABILITY_EXTENSION_URI, type Part } from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import {
  startSendFileMcpServer,
  type SendFileMcpOptions,
  type SendFileMcpServer,
} from './send-file-mcp.js';
import {
  FetchUriError,
  fetchUriToBytes,
  INPUT_FILE_MAX_BYTES,
  INPUT_IMAGE_MIME,
  type FetchUriPolicy,
} from './fetch-uri-file.js';

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
    out.push({ toolName, toolUseId, summary });
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
    if (p.kind === 'file') {
      let bytes = p.file.bytes;
      let mime = p.file.mimeType ?? '';
      if (!bytes && p.file.uri && fetchUriPolicy?.enabled !== false) {
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
      if (!bytes && p.file.uri && fetchUriPolicy?.enabled === false) {
        return {
          ok: false,
          code: 'unsupported_file_uri',
          message: 'claude backend URI fetching is disabled; provide inline FilePart bytes',
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
    return {
      ok: false,
      code: 'unsupported_part_kind',
      message: `claude backend does not accept ${p.kind} parts`,
    };
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
  const sendFileMcpOpts =
    opts.sendFileMcp && opts.sendFileMcp.allowedRoots.length > 0
      ? opts.sendFileMcp
      : null;

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
      const emit: typeof rawEmit = (frame) => {
        lastEmitAt = now();
        rawEmit(frame);
      };

      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      const mapped = await mapPartsToContentBlocks(task.message.parts, opts.fetchUriPolicy, signal);
      if (!mapped.ok) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: mapped.code, message: mapped.message },
        });
        return;
      }

      // Reuse a prior session bound to this contextId when the binding is
      // still fresh; otherwise mint a new uuid and pre-assign it via
      // --session-id so we can record it before the run produces any output.
      const tNow = now();
      if (sessionTtlMs > 0) evictExpired(tNow - sessionTtlMs);
      const existing = sessionTtlMs > 0 ? sessions.get(task.contextId) : undefined;
      const sessionId = existing?.sessionId ?? randomUUID();
      const isResume = existing !== undefined;
      let writeId = 0;
      if (sessionTtlMs > 0) {
        // Refresh lastUsedAt eagerly: a concurrent second task on the same
        // contextId arriving before this one finishes also resumes the same
        // session id (rather than racing to mint a new one).
        writeId = ++writeCounter;
        sessions.set(task.contextId, { sessionId, lastUsedAt: tNow, writeId });
      }

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
      }

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
        ...(mcpServerForTask
          ? [
              '--mcp-config',
              JSON.stringify({
                mcpServers: {
                  'vicoop-bridge': { type: 'http', url: mcpServerForTask.url },
                },
              }),
            ]
          : []),
        ...extraArgs,
      ];

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

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
      const rollbackFreshSession = (): void => {
        if (isResume || sessionTtlMs <= 0) return;
        const cur = sessions.get(task.contextId);
        if (cur?.sessionId === sessionId && cur.writeId === writeId) {
          sessions.delete(task.contextId);
        }
      };

      let child: ClaudeChildHandle;
      try {
        child = spawnFn(command, args, { cwd });
      } catch (err) {
        rollbackFreshSession();
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
        child.stdin.end(envelope + '\n');
      } catch (err) {
        stdinError = err;
      }

      let emittedAnyArtifact = false;
      let finalText: string | null = null;
      let stderrTail = '';
      let aborted = false;
      let settled = false;
      const emitTraceArtifacts = traceabilityRequested(task);

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
          // A single assistant turn can interleave plain text and tool_use
          // blocks. Emit the text (if any) first so observers see "what the
          // model said" before "what tools it then called", matching the
          // visible CLI ordering inside that turn.
          emitAssistantArtifact(extractAssistantText(evt.message.content));
          if (!emitTraceArtifacts) return;
          for (const tu of extractAssistantToolUses(evt.message.content)) {
            emitToolCallArtifact(tu);
          }
          return;
        }
        if (evt.type === 'user') {
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
          if (typeof evt.result === 'string') finalText = evt.result;
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
        stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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

      signal.removeEventListener('abort', onAbort);
      settled = true;
      sendFileRelease?.();
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

      if (exit.code !== 0) {
        rollbackFreshSession();
        const detail = stderrTail.trim();
        const sigPart = exit.signal ? ` (signal ${exit.signal})` : '';
        const detailPart = detail ? `: ${detail.slice(-500)}` : '';
        // If stdin write blew up and the process exited non-zero, surface
        // both: the stdin error is usually the proximate cause.
        const stdinPart = stdinError ? ` [stdin: ${errorMessage(stdinError)}]` : '';
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'claude_exit_nonzero',
            message: `claude exited with code ${exit.code}${sigPart}${detailPart}${stdinPart}`,
          },
        });
        return;
      }

      const completeText = finalText ?? '';
      const parts: Part[] = completeText ? [{ kind: 'text', text: completeText }] : [];

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

      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          ...(completeText
            ? {
                message: {
                  role: 'agent' as const,
                  messageId: randomUUID(),
                  parts,
                },
              }
            : {}),
        },
      });
    },
  };
}
