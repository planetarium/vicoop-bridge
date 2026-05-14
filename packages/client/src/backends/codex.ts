import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
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
import {
  buildOpenAICompatSystemPrompt,
  formatToolCallHistory,
  parseOpenAICompatMetadata,
  tryParseToolCallsEnvelope,
} from './claude.js';
import { createLogger, escapeLineSeparators, safeToken, type Logger } from '../logger.js';
import { INPUT_FILE_MAX_BYTES, INPUT_IMAGE_MIME } from './fetch-uri-file.js';
import { createTimingRecorder } from './timing.js';

export interface CodexChildHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface CodexSpawnOptions {
  cwd?: string;
}

export type CodexSpawnFn = (
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => CodexChildHandle;

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexBackendOptions {
  command?: string;
  cwd?: string;
  sandboxMode?: CodexSandboxMode;
  extraArgs?: readonly string[];
  spawn?: CodexSpawnFn;
  stderrCaptureBytes?: number;
  sessionTtlMs?: number;
  now?: () => number;
  heartbeatMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  mkdtemp?: (prefix: string) => Promise<string>;
  writeFile?: (file: string, data: Buffer) => Promise<void>;
  rm?: (file: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  // Local-only sink for exec-failure diagnostics (nonzero exit / signal)
  // that must NOT travel over the wire — argv, cwd, --image temp paths
  // are host-local. Defaults to a fresh logger driven by the same env
  // var as the rest of the client, so operators see the line in the
  // foreground log without explicit wiring. Tests inject a capturing
  // stub. Note: real spawn(2) failures use error code `spawn_failed`
  // and are a separate branch above this one — "exec-failure" here
  // means codex started but exited non-zero.
  logger?: Logger;
}

const SKIP_GIT_REPO_CHECK_FLAG = '--skip-git-repo-check';

interface SessionEntry {
  threadId: string;
  lastUsedAt: number;
  writeId: number;
}

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: {
    type?: unknown;
    text?: unknown;
    command?: unknown;
    aggregated_output?: unknown;
    exit_code?: unknown;
    status?: unknown;
  };
}

type MappedInput =
  | { ok: true; prompt: string; imageFiles: string[]; tempDir: string | null }
  | { ok: false; code: string; message: string };

const DEFAULT_HEARTBEAT_MS = 30_000;
const COMMAND_TRACE_MAX_CHARS = 2_000;

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
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
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

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions,
): CodexChildHandle {
  return nodeSpawn(command, Array.from(args), {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }) as ChildProcess;
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

function clipTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function commandSummary(item: NonNullable<CodexEvent['item']>): string {
  const command = typeof item.command === 'string' ? item.command : '<unknown command>';
  const status = typeof item.status === 'string' ? item.status : 'unknown';
  const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
  const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : '';
  const head = exit === null ? `${command} (${status})` : `${command} (${status}, exit ${exit})`;
  return clipTo(output ? `${head}\n${output}` : head, COMMAND_TRACE_MAX_CHARS);
}

async function mapPartsToCodexInput(
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
      // Auxiliary structured metadata sent alongside the user text. The codex
      // CLI has no first-class data-part channel, so fold it into the prompt
      // as a tagged JSON block — deterministic, visible, and grep-friendly.
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

function serializeDataPart(data: Record<string, unknown>): string {
  let body: string;
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    return '';
  }
  return `<context kind="application/json">\n${body}\n</context>`;
}

export function createCodexBackend(opts: CodexBackendOptions = {}): Backend {
  const command = opts.command ?? 'codex';
  const cwd = opts.cwd;
  // Sandbox-on by default. `read-only` is also Codex CLI's own default for
  // `codex exec` today, but pass it explicitly so the security posture is
  // visible in `ps`/audit logs and survives any future change to that
  // upstream default. Operators that want a wider scope pass `workspace-write`
  // or `danger-full-access` via `CODEX_SANDBOX_MODE` / `backends.codex.sandbox_mode`.
  const sandboxMode: CodexSandboxMode = opts.sandboxMode ?? 'read-only';
  const extraArgs = opts.extraArgs ?? [];
  const spawnFn = opts.spawn ?? defaultSpawn;
  const stderrCap = opts.stderrCaptureBytes ?? 8192;
  const sessionTtlMs = opts.sessionTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setIntervalImpl = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const mkdtemp = opts.mkdtemp ?? fs.mkdtemp;
  const writeFile = opts.writeFile ?? fs.writeFile;
  const rm = opts.rm ?? fs.rm;
  const logger = opts.logger ?? createLogger();

  const sessions = new Map<string, SessionEntry>();
  let writeCounter = 0;

  function evictExpired(cutoff: number): void {
    for (const [key, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) sessions.delete(key);
    }
  }

  return {
    name: 'codex',

    async handle(task, rawEmit, signal) {
      let lastEmitAt = now();
      const recorder = createTimingRecorder({
        logger,
        backend: 'codex',
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

      const mapped = await mapPartsToCodexInput(task.message.parts, { mkdtemp, writeFile, rm });
      recorder.mark('map');
      if (!mapped.ok) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: mapped.code, message: mapped.message },
        });
        return;
      }

      // Detect the openai-compat extension payload once per task so the
      // result feeds three places: (a) the instructions file we materialise
      // for `-c model_instructions_file=...`, (b) the assistant artifact
      // path (envelope JSON → data part), and (c) the user prompt prefix
      // for multi-turn `tool_call_history`. Absent or malformed metadata
      // leaves the run on the original non-extension code path with no
      // envelope-detection cost.
      const openaiCompat = parseOpenAICompatMetadata(task.message.metadata);

      // A separately-rooted temp dir created only when openai-compat is
      // active AND no image temp dir already exists. Tracked here (outside
      // the try/finally) so the finally block can clean it independently
      // of `mapped.tempDir`.
      let instructionsTempDir: string | null = null;

      try {
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }

        // Materialise the openai-compat system prompt to a file we point
        // codex at via `-c model_instructions_file="..."`. codex 0.130+
        // exposes this as the seam for caller-supplied instructions;
        // `experimental_instructions_file` is deprecated and silently
        // ignored. Skip when the built prompt is empty (e.g. metadata only
        // carried `tool_call_history`, which is replayed in user content
        // instead — no system-level contract needed).
        let instructionsFile: string | null = null;
        if (openaiCompat) {
          const systemPromptText = buildOpenAICompatSystemPrompt(openaiCompat);
          if (systemPromptText) {
            try {
              let dir: string;
              if (mapped.tempDir) {
                dir = mapped.tempDir;
              } else {
                instructionsTempDir = await mkdtemp(path.join(os.tmpdir(), 'vicoop-codex-'));
                dir = instructionsTempDir;
              }
              const file = path.join(dir, 'instructions.md');
              await writeFile(file, Buffer.from(systemPromptText, 'utf8'));
              instructionsFile = file;
            } catch (err) {
              emit({
                type: 'task.fail',
                taskId: task.taskId,
                error: {
                  code: 'input_file_write_failed',
                  message: `failed to materialize codex instructions: ${errorMessage(err)}`,
                },
              });
              return;
            }
          }
        }

        const tNow = now();
        if (sessionTtlMs > 0) evictExpired(tNow - sessionTtlMs);
        const existing = sessionTtlMs > 0 ? sessions.get(task.contextId) : undefined;
        const isResume = existing !== undefined;
        let writeId = 0;
        if (existing && sessionTtlMs > 0) {
          writeId = ++writeCounter;
          sessions.set(task.contextId, {
            threadId: existing.threadId,
            lastUsedAt: tNow,
            writeId,
          });
        }

        // Always pass `--skip-git-repo-check`. vicoop-bridge agents work in
        // an operator-chosen `cwd` (often not a git repo); without this
        // flag, codex exec exits 1 with "Not inside a trusted directory"
        // in ~200 ms (#147). Skip the auto-add if the operator already
        // listed the flag in extra_args so the argv stays clean.
        const skipGitRepoCheck = extraArgs.includes(SKIP_GIT_REPO_CHECK_FLAG)
          ? []
          : [SKIP_GIT_REPO_CHECK_FLAG];
        // `-c key=val` expects val to parse as TOML; for a string value
        // that means wrapped in TOML's basic-string double quotes. Lean on
        // JSON.stringify since TOML's basic-string escape set matches
        // JSON's (\", \\, \n, \t, etc.) so the value survives spaces /
        // unicode / quotes in the path verbatim.
        const instructionsArgs = instructionsFile
          ? ['-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`]
          : [];
        const optionArgs = [
          '--json',
          '-c',
          `sandbox_mode=${JSON.stringify(sandboxMode)}`,
          ...skipGitRepoCheck,
          ...instructionsArgs,
          ...mapped.imageFiles.flatMap((filePath) => ['--image', filePath]),
          ...extraArgs,
        ];
        const args: string[] = [
          'exec',
          ...(isResume ? ['resume', ...optionArgs, existing.threadId] : optionArgs),
          '-',
        ];

        let observedThreadId: string | null = null;

        const maybeStoreThread = (threadId: string): void => {
          if (isResume || sessionTtlMs <= 0) return;
          observedThreadId = threadId;
          writeId = ++writeCounter;
          sessions.set(task.contextId, { threadId, lastUsedAt: now(), writeId });
        };

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

        let child: CodexChildHandle;
        try {
          child = spawnFn(command, args, { cwd });
          recorder.mark('spawn');
        } catch (err) {
          rollbackResumeRefresh();
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: { code: 'spawn_failed', message: errorMessage(err) },
          });
          return;
        }

        let stdinError: unknown = null;
        if (!child.stdin) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* best effort */
          }
          rollbackResumeRefresh();
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'spawn_no_stdin',
              message: 'spawned codex has no stdin pipe; cannot deliver user prompt',
            },
          });
          return;
        }

        child.stdin.on('error', (err: unknown) => {
          if (!stdinError) stdinError = err;
        });
        // Spec contract: bridges MUST replay the entire `tool_call_history`
        // in order on every follow-up turn. Render it as a `<tool_call_history>`
        // JSON block and prepend it to the user prompt so the model reads
        // the prior round BEFORE the current user turn. Any internal session
        // reuse (codex `exec resume`) is invisible to the wire and does not
        // change replay semantics — the redundancy is the price of
        // cross-bridge interop.
        const promptToWrite = openaiCompat?.tool_call_history
          ? (mapped.prompt
              ? `${formatToolCallHistory(openaiCompat.tool_call_history)}\n\n${mapped.prompt}`
              : formatToolCallHistory(openaiCompat.tool_call_history))
          : mapped.prompt;
        try {
          child.stdin.end(promptToWrite);
          recorder.mark('stdin');
        } catch (err) {
          stdinError = err;
        }

        let emittedAnyArtifact = false;
        let finalText: string | null = null;
        let stderrTail = '';
        let aborted = false;
        let settled = false;
        const emitTraceArtifacts = traceabilityRequested(task);

        const emitAgentArtifact = (text: string): void => {
          if (!text) return;
          // When the openai-compat extension is active for this task, the
          // model was instructed to emit `{"tool_calls":[...]}` JSON for
          // tool turns. Detect that shape and surface it as an A2A `data`
          // part so the upstream gateway can forward it as `tool_calls` on
          // the OpenAI response without re-parsing model prose. Non-envelope
          // text (natural-language answers, or any turn from a task that
          // didn't request the extension) falls through to the text artifact
          // path unchanged.
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

        const emitCommandTrace = (item: NonNullable<CodexEvent['item']>): void => {
          if (!emitTraceArtifacts) return;
          emit({
            type: 'task.artifact',
            taskId: task.taskId,
            artifact: {
              artifactId: randomUUID(),
              name: 'codex-command-execution',
              parts: [
                { kind: 'text', text: commandSummary(item) },
                {
                  kind: 'data',
                  data: {
                    command: typeof item.command === 'string' ? item.command : undefined,
                    status: typeof item.status === 'string' ? item.status : undefined,
                    exitCode: typeof item.exit_code === 'number' ? item.exit_code : undefined,
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

        const handleEvent = (evt: CodexEvent): void => {
          if (settled) return;
          if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
            maybeStoreThread(evt.thread_id);
            return;
          }
          if (evt.type !== 'item.completed' || !evt.item) return;
          if (evt.item.type === 'agent_message' && typeof evt.item.text === 'string') {
            recorder.mark('firstFinal');
            finalText = evt.item.text;
            emitAgentArtifact(evt.item.text);
            return;
          }
          if (evt.item.type === 'command_execution') {
            emitCommandTrace(evt.item);
          }
        };

        const onAbort = (): void => {
          if (aborted) return;
          aborted = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* best effort */
          }
        };
        signal.addEventListener('abort', onAbort);

        let stdoutBuf = '';
        child.stdout?.on('data', (chunk: Buffer | string) => {
          recorder.mark('firstOut');
          stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          let nl: number;
          while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line) continue;
            try {
              handleEvent(JSON.parse(line) as CodexEvent);
            } catch {
              // Ignore non-JSON chatter defensively.
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderrTail += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (stderrTail.length > stderrCap) stderrTail = stderrTail.slice(-stderrCap);
        });

        let heartbeatHandle: unknown = null;
        if (heartbeatMs > 0) {
          heartbeatHandle = setIntervalImpl(() => {
            if (settled || aborted) return;
            if (now() - lastEmitAt < heartbeatMs) return;
            emit({
              type: 'task.status',
              taskId: task.taskId,
              status: { state: 'working', timestamp: new Date().toISOString() },
            });
          }, heartbeatMs);
        }

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: unknown }>((resolve) => {
          child.on('error', (err) => resolve({ code: null, signal: null, error: err }));
          child.on('close', (code, sig) => resolve({ code, signal: sig }));
        });
        recorder.mark('closed');

        signal.removeEventListener('abort', onAbort);
        if (heartbeatHandle !== null) clearIntervalImpl(heartbeatHandle);

        const trailing = stdoutBuf.trim();
        if (trailing) {
          try {
            handleEvent(JSON.parse(trailing) as CodexEvent);
          } catch {
            // ignore
          }
        }
        settled = true;

        if (aborted) {
          rollbackFreshThread();
          rollbackResumeRefresh();
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }

        if (exit.error) {
          rollbackFreshThread();
          rollbackResumeRefresh();
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: { code: 'spawn_failed', message: errorMessage(exit.error) },
          });
          return;
        }

        if (exit.code !== 0) {
          rollbackFreshThread();
          rollbackResumeRefresh();
          const detail = stderrTail.trim();
          const detailPart = detail ? `: ${detail.slice(-500)}` : '';
          const stdinPart = stdinError ? ` [stdin: ${errorMessage(stdinError)}]` : '';
          const exitMessage =
            exit.code === null && exit.signal
              ? `codex terminated by signal ${exit.signal}${detailPart}${stdinPart}`
              : `codex exited with code ${exit.code}${exit.signal ? ` (signal ${exit.signal})` : ''}${detailPart}${stdinPart}`;
          // The repro details (argv with --image temp paths, cwd) are
          // host-local: they should help the local operator but must not
          // travel over the wire to the bridge server in `error.message`,
          // which is plaintext-forwarded to the caller. Emit them as a
          // separate local log line keyed by taskId so operators can
          // line it up with the `task.fail` lifecycle log.
          //
          // taskId is wire-derived and could carry control chars; we run
          // it through safeToken to match the lifecycle log's single-line
          // invariant. JSON.stringify leaves U+2028 / U+2029 raw, which
          // some log sinks render as line breaks — escape them on the
          // argv / cwd JSON payloads so the warn line stays one line.
          const argvSummary = escapeLineSeparators(
            clipTo(JSON.stringify([command, ...args]), 400),
          );
          const cwdSummary = cwd
            ? ` cwd=${escapeLineSeparators(JSON.stringify(cwd))}`
            : '';
          logger.warn(
            `codex exec-failure repro taskId=${safeToken(task.taskId)} argv=${argvSummary}${cwdSummary}`,
          );
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'codex_exit_nonzero',
              message: exitMessage,
            },
          });
          return;
        }

        const completeText = finalText ?? '';
        const parts: Part[] = completeText ? [{ kind: 'text', text: completeText }] : [];
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

        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: {
            state: 'completed',
            timestamp: new Date().toISOString(),
            ...(parts.length
              ? {
                  message: {
                    role: 'agent',
                    messageId: randomUUID(),
                    parts,
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
            // Best-effort cleanup; task result should not fail after the child settled.
          }
        }
        // Separately clean the openai-compat instructions dir when it was
        // not co-located with `mapped.tempDir` (i.e. there were no images).
        if (instructionsTempDir && instructionsTempDir !== mapped.tempDir) {
          try {
            await rm(instructionsTempDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup; see above.
          }
        }
      }
    },
  };
}
