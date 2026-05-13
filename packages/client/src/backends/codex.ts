import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TRACEABILITY_EXTENSION_URI, type Part } from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import { createLogger, type Logger } from '../logger.js';
import { INPUT_FILE_MAX_BYTES, INPUT_IMAGE_MIME } from './fetch-uri-file.js';

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
  const pendingImages: Array<{ mime: string; bytes: string }> = [];

  for (const p of parts) {
    if (p.kind === 'text') {
      if (p.text) textParts.push(p.text);
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
    return {
      ok: false,
      code: 'unsupported_part_kind',
      message: `codex backend does not accept ${p.kind} parts`,
    };
  }

  if (textParts.length === 0 && pendingImages.length === 0) {
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

  return { ok: true, prompt: textParts.join('\n\n'), imageFiles, tempDir };
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

      const mapped = await mapPartsToCodexInput(task.message.parts, { mkdtemp, writeFile, rm });
      if (!mapped.ok) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: mapped.code, message: mapped.message },
        });
        return;
      }

      try {
        if (signal.aborted) {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
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
        const optionArgs = [
          '--json',
          '-c',
          `sandbox_mode=${JSON.stringify(sandboxMode)}`,
          ...skipGitRepoCheck,
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
        try {
          child.stdin.end(mapped.prompt);
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
          const argvSummary = clipTo(JSON.stringify([command, ...args]), 400);
          const cwdSummary = cwd ? ` cwd=${JSON.stringify(cwd)}` : '';
          logger.warn(
            `codex exec-failure repro taskId=${task.taskId} argv=${argvSummary}${cwdSummary}`,
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
      }
    },
  };
}
