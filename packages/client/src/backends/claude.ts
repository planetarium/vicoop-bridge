import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Part } from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';
import {
  startSendFileMcpServer,
  type SendFileMcpOptions,
  type SendFileMcpServer,
} from './send-file-mcp.js';

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
}

interface SessionEntry {
  sessionId: string;
  lastUsedAt: number;
}

// claude --output-format stream-json writes one JSON object per line. We
// surface assistant `text` blocks (one A2A artifact per assistant message)
// and pass through `tool_result` content of type image/document so MCP
// screenshot-style tools land as A2A `FilePart`s alongside the text.
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

const INPUT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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

function mapPartsToContentBlocks(
  parts: readonly Part[],
):
  | { ok: true; blocks: InputContentBlock[] }
  | { ok: false; code: string; message: string } {
  const blocks: InputContentBlock[] = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      if (p.text) {
        blocks.push({ type: 'text', text: p.text });
      }
      continue;
    }
    if (p.kind === 'file') {
      // uri-only FilePart is not supported — fetching is the responsibility
      // of a different backend or the caller. Reject with a stable code.
      if (!p.file.bytes) {
        return {
          ok: false,
          code: 'unsupported_file_uri',
          message: 'claude backend requires inline FilePart bytes; uri-only is not supported',
        };
      }
      const mime = p.file.mimeType ?? '';
      if (INPUT_IMAGE_MIME.has(mime)) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mime, data: p.file.bytes },
        });
      } else if (mime === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: mime, data: p.file.bytes },
        });
      } else {
        return {
          ok: false,
          code: 'unsupported_file_mime',
          message: `claude backend accepts image/{png,jpeg,webp,gif} or application/pdf (got ${mime || 'unknown'})`,
        };
      }
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
  return { ok: true, blocks };
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

  function evictExpired(cutoff: number): void {
    for (const [key, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) sessions.delete(key);
    }
  }

  return {
    name: 'claude',

    getSendFileMcpServer: () => sendFileMcp,

    async handle(task, emit, signal) {
      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      const mapped = mapPartsToContentBlocks(task.message.parts);
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

      // Bring up the MCP server first (if enabled) so we know its URL before
      // building argv. A startup failure disables the tool path for this task
      // but the run continues — the caller still gets text/markers.
      let mcpServerForTask: SendFileMcpServer | null = null;
      if (sendFileMcpOpts) {
        try {
          mcpServerForTask = await ensureSendFileMcp();
        } catch (err) {
          console.warn(
            `[claude] send_file MCP server failed to start; tool path disabled for this task: ${(err as Error).message}`,
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

      // Write the user message envelope and close stdin so claude sees EOF
      // and proceeds. Errors here are recorded; the close listener still
      // drives the terminal frame so we don't double-emit.
      let stdinError: Error | null = null;
      try {
        const envelope = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: mapped.blocks },
        });
        child.stdin?.end(envelope + '\n');
      } catch (err) {
        stdinError = err as Error;
      }

      let emittedAnyArtifact = false;
      let finalText: string | null = null;
      let stderrTail = '';
      let aborted = false;
      let settled = false;

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
        if (parts.length === 0) return;
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'claude-tool-result',
            parts,
          },
          lastChunk: true,
        });
        emittedAnyArtifact = true;
      };

      const handleEvent = (evt: StreamEvent): void => {
        if (settled) return;
        if (evt.type === 'assistant') {
          if (evt.message?.role !== 'assistant') return;
          emitAssistantArtifact(extractAssistantText(evt.message.content));
          return;
        }
        if (evt.type === 'user') {
          // tool_result events come in as a synthetic user message in the
          // stream-json transcript; pull out any image/document blocks and
          // emit them as A2A FileParts. Text-only tool results are skipped.
          const parts = extractToolResultMediaParts(evt.message?.content);
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

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        child.on('error', (err) => resolve({ code: null, signal: null, error: err }));
        child.on('close', (code, sig) => resolve({ code, signal: sig }));
      });

      signal.removeEventListener('abort', onAbort);
      settled = true;
      sendFileRelease?.();

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
        // If stdin write blew up and the process exited non-zero, surface
        // both: the stdin error is usually the proximate cause.
        const stdinPart = stdinError ? ` [stdin: ${stdinError.message}]` : '';
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
