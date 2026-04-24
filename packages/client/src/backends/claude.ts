import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Part } from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';

// Slim subset of ChildProcess that the backend actually uses. Tests inject a
// fake that satisfies this without wiring up a real OS process.
export interface ClaudeChildHandle {
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
}

interface SessionEntry {
  sessionId: string;
  lastUsedAt: number;
}

// claude --output-format stream-json writes one JSON object per line. Message
// events have `type:"assistant"` with a content block array we surface as
// artifacts; the run ends with `type:"result"` carrying the final text string.
interface StreamEvent {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
  result?: unknown;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: ClaudeSpawnOptions,
): ClaudeChildHandle {
  return nodeSpawn(command, Array.from(args), {
    stdio: ['ignore', 'pipe', 'pipe'],
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

function collectTextPrompt(parts: readonly Part[]): { ok: true; prompt: string } | { ok: false; code: string; message: string } {
  let prompt = '';
  for (const p of parts) {
    if (p.kind !== 'text') {
      return {
        ok: false,
        code: 'unsupported_part_kind',
        message: `claude backend only accepts text parts (got ${p.kind})`,
      };
    }
    prompt += p.text;
  }
  if (!prompt) {
    return { ok: false, code: 'empty_prompt', message: 'no text content in message' };
  }
  return { ok: true, prompt };
}

export function createClaudeBackend(opts: ClaudeBackendOptions = {}): Backend {
  const command = opts.command ?? 'claude';
  const cwd = opts.cwd;
  const extraArgs = opts.extraArgs ?? [];
  const spawnFn = opts.spawn ?? defaultSpawn;
  const stderrCap = opts.stderrCaptureBytes ?? 8192;
  const sessionTtlMs = opts.sessionTtlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;

  // contextId → claude session_id. A follow-up task on the same A2A
  // contextId resumes the same claude conversation via --resume so the model
  // sees prior turns; without this every task would be a fresh chat with no
  // memory. The map is in-memory only — restarts lose the binding (next task
  // on a stale contextId starts a new session).
  const sessions = new Map<string, SessionEntry>();

  function evictExpired(cutoff: number): void {
    for (const [key, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) sessions.delete(key);
    }
  }

  return {
    name: 'claude',

    async handle(task, emit, signal) {
      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      const mapped = collectTextPrompt(task.message.parts);
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
      if (sessionTtlMs > 0) {
        // Refresh lastUsedAt eagerly: a concurrent second task on the same
        // contextId arriving before this one finishes also resumes the same
        // session id (rather than racing to mint a new one).
        sessions.set(task.contextId, { sessionId, lastUsedAt: tNow });
      }

      const args: string[] = [
        '-p',
        mapped.prompt,
        ...(isResume ? ['--resume', sessionId] : ['--session-id', sessionId]),
        '--output-format',
        'stream-json',
        // Required alongside --output-format stream-json; without it claude
        // prints a banner and exits instead of streaming.
        '--verbose',
        ...extraArgs,
      ];

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      let child: ClaudeChildHandle;
      try {
        child = spawnFn(command, args, { cwd });
      } catch (err) {
        // Roll back the freshly-minted entry so a retry doesn't try to
        // --resume a session that was never actually created on disk.
        if (!isResume && sessionTtlMs > 0) {
          const cur = sessions.get(task.contextId);
          if (cur?.sessionId === sessionId) sessions.delete(task.contextId);
        }
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: 'spawn_failed', message: (err as Error).message },
        });
        return;
      }

      let emittedAnyArtifact = false;
      let finalText: string | null = null;
      let stderrTail = '';
      let aborted = false;
      let settled = false;

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

      const handleEvent = (evt: StreamEvent): void => {
        if (settled) return;
        if (evt.type === 'assistant') {
          if (evt.message?.role !== 'assistant') return;
          emitAssistantArtifact(extractAssistantText(evt.message.content));
        } else if (evt.type === 'result') {
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

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        child.on('error', (err) => resolve({ code: null, signal: null, error: err }));
        child.on('close', (code, sig) => resolve({ code, signal: sig }));
      });

      signal.removeEventListener('abort', onAbort);
      settled = true;

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
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: 'spawn_failed', message: exit.error.message },
        });
        return;
      }

      if (exit.code !== 0) {
        const detail = stderrTail.trim();
        const sigPart = exit.signal ? ` (signal ${exit.signal})` : '';
        const detailPart = detail ? `: ${detail.slice(-500)}` : '';
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'claude_exit_nonzero',
            message: `claude exited with code ${exit.code}${sigPart}${detailPart}`,
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
