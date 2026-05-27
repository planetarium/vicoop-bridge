import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  composeNativeDevInstructions,
  createCodexBackend,
  historyToInjectItems,
  openaiToolsToDynamicToolSpecs,
  parseCodexConfigTomlForModel,
} from './codex.js';
import type {
  AppServerChildHandle,
  AppServerSpawnFn,
  AppServerSpawnOptions,
  ModelListEntry,
} from './codex-rpc.js';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Fake stdio child — same shape as codex.test.ts so the test surface stays
// familiar. Tests script behaviour by registering an `onStdinLine` callback
// per child; whenever the backend writes a newline-terminated JSON-RPC frame
// to stdin the helper parses it, hands the parsed object to the scenario,
// and lets the scenario emit responses/notifications back on stdout.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeChild extends AppServerChildHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  killed: boolean;
  killSignal: NodeJS.Signals | null;
  /** All stdin chunks concatenated (newline-delimited JSON-RPC frames). */
  readonly stdinPayload: () => string;
  /** Parse every complete line written so far. */
  readonly stdinFrames: () => unknown[];
  /** Push one JSON-RPC line to the backend's stdout. */
  emitStdout(obj: unknown): void;
  /** Push raw text (non-JSON line, partial buffer, etc.). */
  emitStdoutRaw(text: string): void;
  /** Push stderr bytes — mostly for transport-failure tests. */
  emitStderr(text: string): void;
  /** Synthesise a process exit. */
  finish(code: number | null, sig?: NodeJS.Signals | null): void;
}

interface FakeSpawn {
  spawn: AppServerSpawnFn;
  children: FakeChild[];
  lastChild: () => FakeChild;
}

interface ChildScenario {
  /** Called per inbound JSON-RPC line from the backend. */
  onLine?: (line: Record<string, unknown>, child: FakeChild, index: number) => void;
}

function makeFakeSpawn(
  configure: (child: FakeChild, index: number) => ChildScenario | void,
): FakeSpawn {
  const children: FakeChild[] = [];
  const spawn: AppServerSpawnFn = (
    command,
    args,
    options: AppServerSpawnOptions,
  ) => {
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const closeListeners: Array<
      (code: number | null, sig: NodeJS.Signals | null) => void
    > = [];
    let closed = false;

    const mkReadable = (em: EventEmitter): NodeJS.ReadableStream =>
      ({
        on(event: string, cb: (...a: unknown[]) => void) {
          em.on(event, cb);
        },
      }) as unknown as NodeJS.ReadableStream;

    const stdinChunks: string[] = [];
    let stdinBuf = '';
    let onLine: ChildScenario['onLine'] | undefined;

    const handleLine = (line: string): void => {
      if (!onLine) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      onLine(parsed, child, children.length - 1);
    };

    const writeBytes = (chunk: unknown): void => {
      const s =
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk as Buffer).toString('utf8');
      stdinChunks.push(s);
      stdinBuf += s;
      let nl: number;
      while ((nl = stdinBuf.indexOf('\n')) !== -1) {
        const line = stdinBuf.slice(0, nl).trim();
        stdinBuf = stdinBuf.slice(nl + 1);
        if (line) handleLine(line);
      }
    };
    const stdin: NodeJS.WritableStream = {
      write(chunk: unknown): boolean {
        writeBytes(chunk);
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) writeBytes(chunk);
        return stdin;
      },
      on() {
        return stdin;
      },
      once() {
        return stdin;
      },
      emit() {
        return false;
      },
    } as unknown as NodeJS.WritableStream;

    const child: FakeChild = {
      command,
      args,
      cwd: options.cwd,
      stdin,
      stdout: mkReadable(stdoutEmitter),
      stderr: mkReadable(stderrEmitter),
      killed: false,
      killSignal: null,
      stdinPayload: () => stdinChunks.join(''),
      stdinFrames: () => {
        const out: unknown[] = [];
        for (const line of stdinChunks.join('').split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            out.push(JSON.parse(t));
          } catch {
            // ignore — tests assert on framed content
          }
        }
        return out;
      },
      emitStdout(obj) {
        stdoutEmitter.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
      },
      emitStdoutRaw(text) {
        stdoutEmitter.emit('data', Buffer.from(text, 'utf8'));
      },
      emitStderr(text) {
        stderrEmitter.emit('data', Buffer.from(text, 'utf8'));
      },
      kill(sig?: NodeJS.Signals) {
        this.killed = true;
        this.killSignal = sig ?? 'SIGTERM';
        queueMicrotask(() => {
          if (closed) return;
          closed = true;
          for (const l of closeListeners) l(null, this.killSignal);
        });
        return true;
      },
      on(
        event: 'close' | 'error',
        listener:
          | ((code: number | null, signal: NodeJS.Signals | null) => void)
          | ((err: Error) => void),
      ) {
        if (event === 'close') {
          closeListeners.push(
            listener as (c: number | null, s: NodeJS.Signals | null) => void,
          );
        }
      },
      finish(code, sig = null) {
        if (closed) return;
        closed = true;
        for (const l of closeListeners) l(code, sig);
      },
    };

    children.push(child);
    const scenario = configure(child, children.length - 1);
    if (scenario?.onLine) onLine = scenario.onLine;
    return child;
  };
  return {
    spawn,
    children,
    lastChild: () => {
      const c = children.at(-1);
      if (!c) throw new Error('no spawned child yet');
      return c;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario helpers — encode the canonical app-server happy-path response
// pattern (initialize → thread/start|resume → turn/start → notifications →
// turn/completed) once so the per-test code stays focused on the bit under
// test.
// ─────────────────────────────────────────────────────────────────────────────

interface HappyPathOptions {
  agentMessageText?: string;
  threadId?: string;
  turnId?: string;
  tokenUsage?: unknown;
  /**
   * After how many `turn/start` requests we should pretend the agent
   * emitted a `commandExecution` item before completing. Default 0.
   */
  emitCommandExecutionTurns?: number[];
  /** Optional override of the initialize result payload. */
  initializeResult?: Record<string, unknown>;
}

function happyPath(opts: HappyPathOptions = {}): ChildScenario {
  const agentMessageText = opts.agentMessageText ?? 'OK';
  const threadId = opts.threadId ?? 'thr-1';
  const turnId = opts.turnId ?? 'turn-1';
  const commandTurns = new Set(opts.emitCommandExecutionTurns ?? []);
  let turnCounter = 0;
  let activeThreadId = threadId;
  return {
    onLine(frame, child) {
      const id = (frame as { id?: number | string }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({
          id,
          result:
            opts.initializeResult ?? {
              userAgent: 'fake-codex/0.130.0',
              codexHome: '/tmp',
              platformFamily: 'unix',
              platformOs: 'macos',
            },
        });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        activeThreadId = threadId;
        child.emitStdout({ id, result: { thread: { id: activeThreadId } } });
        return;
      }
      if (method === 'thread/resume' && id !== undefined) {
        const p = (frame as { params?: { threadId?: string } }).params;
        activeThreadId = p?.threadId ?? threadId;
        child.emitStdout({ id, result: { thread: { id: activeThreadId } } });
        return;
      }
      if (method === 'thread/inject_items' && id !== undefined) {
        // Empty-object result mirrors the real server's response shape;
        // the backend treats it as fire-and-confirm.
        child.emitStdout({ id, result: {} });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        turnCounter += 1;
        const localTurnId = `${turnId}-${turnCounter}`;
        child.emitStdout({
          id,
          result: { turn: { id: localTurnId, status: 'inProgress' } },
        });
        // Schedule the notifications on a microtask so the backend's
        // turn/start promise resolves and `activeTurnId` is recorded
        // before the first notification arrives.
        queueMicrotask(() => {
          child.emitStdout({
            method: 'item/agentMessage/delta',
            params: { itemId: 'item-1', delta: agentMessageText, turnId: localTurnId },
          });
          if (commandTurns.has(turnCounter)) {
            child.emitStdout({
              method: 'item/completed',
              params: {
                turnId: localTurnId,
                threadId: activeThreadId,
                item: {
                  type: 'commandExecution',
                  id: 'cmd-1',
                  command: 'ls -la',
                  status: 'success',
                  exitCode: 0,
                  aggregatedOutput: 'foo\nbar\n',
                },
              },
            });
          }
          if (opts.tokenUsage) {
            child.emitStdout({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: activeThreadId,
                turnId: localTurnId,
                tokenUsage: opts.tokenUsage,
              },
            });
          }
          child.emitStdout({
            method: 'item/completed',
            params: {
              turnId: localTurnId,
              threadId: activeThreadId,
              item: { type: 'agentMessage', id: 'item-1', text: agentMessageText },
            },
          });
          child.emitStdout({
            method: 'turn/completed',
            params: {
              turn: { id: localTurnId, status: 'completed', items: [], error: null },
            },
          });
        });
        return;
      }
    },
  };
}

function assign(
  text: string,
  contextId = 'ctx-1',
  overrides: Partial<TaskAssignFrame> = {},
): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId: `task-${Math.random().toString(36).slice(2, 10)}`,
    contextId,
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'text', text }],
    },
    ...overrides,
  };
}

function collect(): { emit: (f: UpFrame) => void; frames: UpFrame[] } {
  const frames: UpFrame[] = [];
  return { emit: (f) => frames.push(f), frames };
}

function artifactText(frame: Extract<UpFrame, { type: 'task.artifact' }>): string {
  const part = frame.artifact.parts[0];
  return part?.kind === 'text' ? part.text : '';
}

function findRequest(frames: unknown[], method: string): Record<string, unknown> | null {
  for (const f of frames) {
    if (f === null || typeof f !== 'object') continue;
    const o = f as { method?: unknown; id?: unknown };
    if (o.method === method && 'id' in o && o.id !== undefined) {
      return f as Record<string, unknown>;
    }
  }
  return null;
}

const NEVER: AbortSignal = new AbortController().signal;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('first task runs initialize + thread/start + turn/start and emits agent artifact', async () => {
  const fake = makeFakeSpawn(() => happyPath({ agentMessageText: 'OK' }));
  const backend = createCodexBackend({ spawn: fake.spawn, cwd: '/repo' });

  const { emit, frames } = collect();
  await backend.handle(assign('hello'), emit, NEVER);

  // Only ONE child should have been spawned (singleton app-server).
  assert.equal(fake.children.length, 1);
  const child = fake.lastChild();
  assert.equal(child.command, 'codex');
  assert.deepEqual(child.args, ['app-server']);
  assert.equal(child.cwd, '/repo');

  // Sent frames must include initialize → initialized (notif) → thread/start → turn/start.
  const sent = child.stdinFrames();
  const initReq = findRequest(sent, 'initialize') as
    | { params?: { capabilities?: { experimentalApi?: boolean } } }
    | undefined;
  assert.ok(initReq, 'initialize sent');
  // experimentalApi opt-in is required for `thread/start.environments` (#183).
  // Send it unconditionally so the codex app-server accepts our env clamp.
  assert.equal(initReq.params?.capabilities?.experimentalApi, true);
  const init = sent.find((f) => (f as { method?: string }).method === 'initialized') as
    | Record<string, unknown>
    | undefined;
  assert.ok(init && !('id' in init), 'initialized is a notification (no id)');
  const threadStart = findRequest(sent, 'thread/start');
  assert.ok(threadStart, 'thread/start sent');
  const turnStart = findRequest(sent, 'turn/start');
  assert.ok(turnStart, 'turn/start sent');

  // thread/start carries sandbox=read-only and cwd.
  const tsParams = (threadStart as { params?: { sandbox?: string; cwd?: string } }).params;
  assert.equal(tsParams?.sandbox, 'read-only');
  assert.equal(tsParams?.cwd, '/repo');

  // turn/start carries the text input plus an empty `text_elements`.
  const tParams = (turnStart as {
    params?: { threadId?: string; input?: Array<{ type: string; text?: string; text_elements?: unknown[] }> };
  }).params;
  assert.equal(tParams?.threadId, 'thr-1');
  assert.deepEqual(tParams?.input, [
    { type: 'text', text: 'hello', text_elements: [] },
  ]);

  // The backend emits working → artifact → complete with completed state.
  assert.equal(frames[0]?.type, 'task.status');
  assert.equal(frames[1]?.type, 'task.artifact');
  const last = frames.at(-1);
  assert.equal(last?.type, 'task.complete');
  assert.equal(last?.type === 'task.complete' && last.status.state, 'completed');
});

test('agentMessage deltas stream as append artifact chunks without duplicating final text', async () => {
  const fake = makeFakeSpawn(() => {
    let localTurnId = '';
    return {
      onLine(frame, child) {
        const id = (frame as { id?: number | string }).id;
        const method = (frame as { method?: string }).method;
        if (method === 'initialize' && id !== undefined) {
          child.emitStdout({
            id,
            result: {
              userAgent: 'fake-codex/0.130.0',
              codexHome: '/tmp',
              platformFamily: 'unix',
              platformOs: 'macos',
            },
          });
          return;
        }
        if (method === 'thread/start' && id !== undefined) {
          child.emitStdout({ id, result: { thread: { id: 'thr-1' } } });
          return;
        }
        if (method === 'turn/start' && id !== undefined) {
          localTurnId = 'turn-1';
          child.emitStdout({ id, result: { turn: { id: localTurnId } } });
          queueMicrotask(() => {
            child.emitStdout({
              method: 'item/agentMessage/delta',
              params: { itemId: 'item-1', delta: 'one', turnId: localTurnId },
            });
            child.emitStdout({
              method: 'item/agentMessage/delta',
              params: { itemId: 'item-1', delta: ' two', turnId: localTurnId },
            });
            child.emitStdout({
              method: 'item/completed',
              params: {
                turnId: localTurnId,
                item: { type: 'agentMessage', id: 'item-1', text: 'one two' },
              },
            });
            child.emitStdout({
              method: 'turn/completed',
              params: { turn: { id: localTurnId, status: 'completed' } },
            });
          });
        }
      },
    };
  });
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();

  await backend.handle(assign('hello'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map(artifactText), ['one', ' two']);
  assert.equal(new Set(artifacts.map((a) => a.artifact.artifactId)).size, 1);
  assert.deepEqual(artifacts.map((a) => a.append), [true, true]);
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('backend.stop() sends SIGTERM to the long-lived app-server child (#186)', async () => {
  // Daemon shutdown path: Client.stop() forwards to Backend.stop(), which
  // the codex backend uses to tear down the singleton `codex app-server`
  // process. Without this signal the child is re-parented to init after
  // the daemon exits and leaks (see issue #186, macOS report). Verify a
  // SIGTERM is dispatched to the active child, and that calling stop()
  // before any task has spawned a child is a safe no-op (the codex
  // backend lazily spawns on the first task).
  const fake = makeFakeSpawn(() => happyPath({ agentMessageText: 'OK' }));
  const backend = createCodexBackend({ spawn: fake.spawn });

  // No child yet — stop must not throw.
  assert.doesNotThrow(() => backend.stop?.());
  assert.equal(fake.children.length, 0);

  // Run one task to materialize the singleton child, then stop.
  const { emit } = collect();
  await backend.handle(assign('hello'), emit, NEVER);
  assert.equal(fake.children.length, 1);
  const child = fake.lastChild();
  assert.equal(child.killed, false, 'child must be alive before stop');

  backend.stop?.();
  assert.equal(child.killed, true, 'stop must kill the app-server child');
  assert.equal(child.killSignal, 'SIGTERM');

  // Idempotent: a second stop after the child has closed must not throw.
  assert.doesNotThrow(() => backend.stop?.());
});

test('follow-up task with same contextId uses thread/resume not thread/start', async () => {
  const fake = makeFakeSpawn(() => happyPath({ threadId: 'thr-1' }));
  const backend = createCodexBackend({ spawn: fake.spawn });

  const a = collect();
  await backend.handle(assign('first', 'ctx-A'), a.emit, NEVER);
  const b = collect();
  await backend.handle(assign('second', 'ctx-A'), b.emit, NEVER);

  // Still one child.
  assert.equal(fake.children.length, 1);
  const frames = fake.lastChild().stdinFrames();
  const startCount = frames.filter((f) => (f as { method?: string }).method === 'thread/start').length;
  const resumeCount = frames.filter((f) => (f as { method?: string }).method === 'thread/resume').length;
  const turnStarts = frames.filter((f) => (f as { method?: string }).method === 'turn/start').length;

  assert.equal(startCount, 1, 'only one thread/start over two tasks');
  assert.equal(resumeCount, 1, 'second task resumes the thread');
  assert.equal(turnStarts, 2, 'one turn per task');

  assert.equal(a.frames.at(-1)?.type, 'task.complete');
  assert.equal(b.frames.at(-1)?.type, 'task.complete');
});

test('distinct contextIds get distinct threads on a single app-server', async () => {
  const fake = makeFakeSpawn((_child, _idx) => {
    // Both contexts share the same fake server, so use a counter for threadId.
    let threadCounter = 0;
    let turnCounter = 0;
    return {
      onLine(frame, child) {
        const id = (frame as { id?: number | string }).id;
        const method = (frame as { method?: string }).method;
        if (method === 'initialize' && id !== undefined) {
          child.emitStdout({ id, result: { userAgent: 'fake' } });
          return;
        }
        if (method === 'thread/start' && id !== undefined) {
          threadCounter += 1;
          const tid = `thr-${threadCounter}`;
          child.emitStdout({ id, result: { thread: { id: tid } } });
          return;
        }
        if (method === 'thread/resume' && id !== undefined) {
          const p = (frame as { params?: { threadId?: string } }).params;
          child.emitStdout({ id, result: { thread: { id: p?.threadId ?? 'thr-?' } } });
          return;
        }
        if (method === 'turn/start' && id !== undefined) {
          turnCounter += 1;
          const localTurnId = `turn-${turnCounter}`;
          const params = (frame as { params?: { threadId?: string } }).params;
          const threadId = params?.threadId ?? 'thr-?';
          child.emitStdout({
            id,
            result: { turn: { id: localTurnId, status: 'inProgress' } },
          });
          queueMicrotask(() => {
            child.emitStdout({
              method: 'item/completed',
              params: {
                turnId: localTurnId,
                threadId,
                item: { type: 'agentMessage', id: 'i', text: `reply-${turnCounter}` },
              },
            });
            child.emitStdout({
              method: 'turn/completed',
              params: { turn: { id: localTurnId, status: 'completed' } },
            });
          });
        }
      },
    };
  });
  const backend = createCodexBackend({ spawn: fake.spawn });

  const a = collect();
  await backend.handle(assign('hi A', 'ctx-A'), a.emit, NEVER);
  const b = collect();
  await backend.handle(assign('hi B', 'ctx-B'), b.emit, NEVER);

  assert.equal(fake.children.length, 1);
  const frames = fake.lastChild().stdinFrames();
  const starts = frames.filter((f) => (f as { method?: string }).method === 'thread/start');
  assert.equal(starts.length, 2, 'one thread/start per context');
});

test('abort sends turn/interrupt and emits canceled', async () => {
  // Scenario: respond to initialize, thread/start, turn/start, but never
  // emit a turn/completed unless an interrupt arrives.
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: unknown }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({ id, result: { userAgent: 'fake' } });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        child.emitStdout({ id, result: { thread: { id: 'thr' } } });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        child.emitStdout({ id, result: { turn: { id: 'turn-x', status: 'inProgress' } } });
        return;
      }
      if (method === 'turn/interrupt' && id !== undefined) {
        child.emitStdout({ id, result: {} });
        // After ack, emit a turn/completed status=interrupted.
        queueMicrotask(() => {
          child.emitStdout({
            method: 'turn/completed',
            params: { turn: { id: 'turn-x', status: 'interrupted' } },
          });
        });
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });

  const ctrl = new AbortController();
  const { emit, frames } = collect();
  const handlePromise = backend.handle(assign('hang'), emit, ctrl.signal);
  // Give the backend time to send turn/start before aborting.
  await new Promise((r) => setTimeout(r, 20));
  ctrl.abort();
  await handlePromise;

  const sent = fake.lastChild().stdinFrames();
  const interrupt = findRequest(sent, 'turn/interrupt');
  assert.ok(interrupt, 'turn/interrupt sent on abort');
  const last = frames.at(-1);
  assert.equal(last?.type, 'task.complete');
  assert.equal(last?.type === 'task.complete' && last.status.state, 'canceled');
});

test('approval server-request gets auto-decline by default', async () => {
  let lastApprovalResponse: unknown = null;
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: unknown }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({ id, result: { userAgent: 'fake' } });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        child.emitStdout({ id, result: { thread: { id: 'thr' } } });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        child.emitStdout({ id, result: { turn: { id: 't', status: 'inProgress' } } });
        // Send a server-initiated approval request to the client.
        queueMicrotask(() => {
          child.emitStdout({
            id: 9999,
            method: 'execCommandApproval',
            params: { command: 'rm -rf /' },
          });
        });
        return;
      }
      // The auto-decline response comes back from the client with `id: 9999`.
      if (id === 9999) {
        lastApprovalResponse = frame;
        // After approval is declined, conclude the turn.
        queueMicrotask(() => {
          child.emitStdout({
            method: 'item/completed',
            params: {
              turnId: 't',
              item: { type: 'agentMessage', id: 'a', text: 'declined' },
            },
          });
          child.emitStdout({
            method: 'turn/completed',
            params: { turn: { id: 't', status: 'completed' } },
          });
        });
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('do dangerous thing'), emit, NEVER);

  const approvalFrame = lastApprovalResponse as { id?: number; result?: { decision?: string } } | null;
  assert.equal(approvalFrame?.id, 9999);
  assert.equal(approvalFrame?.result?.decision, 'decline');
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('app-server spawn failure surfaces app_server_unavailable', async () => {
  const failingSpawn: AppServerSpawnFn = () => {
    throw new Error('ENOENT');
  };
  const backend = createCodexBackend({ spawn: failingSpawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const last = frames.at(-1);
  assert.equal(last?.type, 'task.fail');
  assert.equal(
    last?.type === 'task.fail' && last.error.code,
    'app_server_unavailable',
  );
});

test('transport closing mid-turn emits task.fail', async () => {
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: unknown }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({ id, result: { userAgent: 'fake' } });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        child.emitStdout({ id, result: { thread: { id: 'thr' } } });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        child.emitStdout({ id, result: { turn: { id: 't', status: 'inProgress' } } });
        // Kill the child mid-turn.
        queueMicrotask(() => child.finish(1));
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('crash me'), emit, NEVER);

  const last = frames.at(-1);
  assert.equal(last?.type, 'task.fail');
  assert.equal(last?.type === 'task.fail' && last.error.code, 'turn_failed');
});

test('traceability extension surfaces commandExecution item as a trace artifact', async () => {
  const fake = makeFakeSpawn(() =>
    happyPath({ agentMessageText: 'done', emitCommandExecutionTurns: [1] }),
  );
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assign('run ls', 'ctx-trace', {
      requestedExtensions: [TRACEABILITY_EXTENSION_URI],
    }),
    emit,
    NEVER,
  );

  const traceArtifact = frames.find(
    (f) =>
      f.type === 'task.artifact' && f.artifact.extensions?.includes(TRACEABILITY_EXTENSION_URI),
  );
  assert.ok(traceArtifact, 'trace artifact emitted');
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('image FilePart is materialised under a temp dir and passed as localImage UserInput', async () => {
  const fake = makeFakeSpawn(() => happyPath());
  const written: Array<{ file: string; size: number }> = [];
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/test-codex-as',
    writeFile: async (file, data) => {
      written.push({ file, size: data.length });
    },
    rm: async () => undefined,
  });

  const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const { emit, frames } = collect();
  await backend.handle(
    {
      type: 'task.assign',
      taskId: 'task-img',
      contextId: 'ctx-img',
      message: {
        role: 'user',
        messageId: 'm',
        parts: [
          { kind: 'text', text: 'what is this' },
          { kind: 'file', file: { mimeType: 'image/png', bytes: tiny } },
        ],
      },
    },
    emit,
    NEVER,
  );

  assert.equal(written.length, 1);
  assert.match(written[0].file, /^\/tmp\/test-codex-as\/image-1\.png$/);

  const turnStart = findRequest(fake.lastChild().stdinFrames(), 'turn/start');
  const params = (turnStart as {
    params?: { input?: Array<{ type: string; path?: string }> };
  }).params;
  const imageItem = params?.input?.find((it) => it.type === 'localImage');
  assert.ok(imageItem, 'localImage UserInput present');
  assert.equal(imageItem?.path, '/tmp/test-codex-as/image-1.png');
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('openai-compat chat_history injects prior turns as Responses API items; trailing user rides turn/start.input', async () => {
  // Codex absorbs `function_call` / `function_call_output` items as proper
  // prior tool dispatch — the model sees them as its own past actions and
  // does not re-emit the same envelope (#176). Per the new chat_history
  // spec (planetarium/oai2a2a#74), chat_history carries every prior turn
  // EXCEPT the trailing user — so the originating user message is in
  // chat_history as a `message` item, the tool round-trip follows, and
  // the trailing user (the new question on this turn) rides
  // `turn/start.input` normally. No synthetic anchor needed.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assign('follow up', 'ctx-hist', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'follow up' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            chat_history: [
              { role: 'user', content: 'kick off' },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'tc1', function: { name: 'lookup', arguments: '{}' } },
                ],
              },
              { role: 'tool', tool_call_id: 'tc1', content: 'OK' },
            ],
          },
        },
      },
    }),
    emit,
    NEVER,
  );

  // thread/inject_items carries every chat_history entry in order. The
  // originating user turn comes through as a message item (no separate
  // anchor), the tool round-trip as the function_call + output pair.
  const inject = findRequest(fake.lastChild().stdinFrames(), 'thread/inject_items');
  assert.ok(inject, 'thread/inject_items observed');
  const injectParams = (inject as {
    params?: { items?: Array<Record<string, unknown>> };
  }).params;
  assert.deepEqual(injectParams?.items, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'kick off' }],
    },
    { type: 'function_call', call_id: 'tc1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'tc1', output: 'OK' },
  ]);

  // turn/start.input carries the trailing user (the new question) — same
  // path a non-extension task takes.
  const turnStart = findRequest(fake.lastChild().stdinFrames(), 'turn/start');
  const params = (turnStart as {
    params?: { input?: Array<{ type: string; text?: string }> };
  }).params;
  assert.deepEqual(params?.input, [
    { type: 'text', text: 'follow up', text_elements: [] },
  ]);
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('openai-compat chat_history with empty parts (tool-continuation) sends empty-text turn/start.input', async () => {
  // Spec edge case: the inbound OpenAI request ends with `assistant.tool_calls`
  // + `tool` (no trailing user), so the gateway emits A2A `parts` as the
  // placeholder `[{text:""}]` and packs the full sequence into chat_history.
  // The bridge must still wake the model — `input: []` makes codex go silent —
  // so we synthesise a single empty-text item.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assign('', 'ctx-tool-cont', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: '' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            chat_history: [
              { role: 'user', content: 'kick off' },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'tc1', function: { name: 'lookup', arguments: '{}' } },
                ],
              },
              { role: 'tool', tool_call_id: 'tc1', content: 'OK' },
            ],
          },
        },
      },
    }),
    emit,
    NEVER,
  );

  const turnStart = findRequest(fake.lastChild().stdinFrames(), 'turn/start');
  const params = (turnStart as {
    params?: { input?: Array<{ type: string; text?: string }> };
  }).params;
  assert.deepEqual(params?.input, [
    { type: 'text', text: '', text_elements: [] },
  ]);
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('openai-compat thread/start sets include_environment_context: false to suppress codex auto user-msg tail (#233)', async () => {
  // Without this, codex re-emits `<environment_context>` as a user-role
  // message at the head of every `turn/start`, which lands AT THE TAIL of
  // the model's conversation when `turn/start.input: []` drives a
  // continuation off injected history — and the synthetic user turn is
  // exactly what makes the model re-interpret the prompt as fresh.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(
    assign('ask', 'ctx-no-envctx', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'ask' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
          },
        },
      },
    }),
    collect().emit,
    NEVER,
  );
  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as {
    params?: { config?: { include_environment_context?: boolean } };
  }).params;
  assert.equal(params?.config?.include_environment_context, false);
});

test('non-openai-compat thread/start omits include_environment_context (default codex behaviour preserved)', async () => {
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('hi', 'ctx-default-envctx'), collect().emit, NEVER);
  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as {
    params?: { config?: { include_environment_context?: boolean } };
  }).params;
  assert.equal(params?.config?.include_environment_context, undefined);
});

test('absent chat_history skips thread/inject_items entirely', async () => {
  // First-turn tasks (no prior round-trips) must NOT send a dangling
  // empty-items inject.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('hi', 'ctx-no-hist'), collect().emit, NEVER);
  const inject = findRequest(fake.lastChild().stdinFrames(), 'thread/inject_items');
  assert.equal(inject, null);
});

test('historyToInjectItems maps prior user/assistant text turns to message items', () => {
  // Per the new chat_history spec, plain user/assistant turns map 1:1 to
  // OpenAI Responses API message items (`input_text` for user,
  // `output_text` for assistant). The tool round-trip slice still fans
  // out into function_call / function_call_output items.
  const items = historyToInjectItems([
    { role: 'user', content: 'kick off' },
    { role: 'assistant', content: 'sure, on it' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
  ]);
  assert.deepEqual(items, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kick off' }] },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'sure, on it' }],
    },
    { type: 'function_call', call_id: 't1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 't1', output: 'ok' },
  ]);
});

test('historyToInjectItems: tool-only slice emits only function_call/function_call_output items', () => {
  // A history slice that's only tool round-trips (no plain text) still
  // produces the matching codex items — same shape the pre-spec wire used
  // to carry.
  const items = historyToInjectItems([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
  ]);
  assert.deepEqual(items, [
    { type: 'function_call', call_id: 't1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 't1', output: 'ok' },
  ]);
});

test('chat_history + image FilePart: trailing user (text+image) rides turn/start.input', async () => {
  // Per the new chat_history spec, chat_history holds the prior tool
  // round-trip only; the trailing user (this turn's text + image) goes
  // through `turn/start.input` normally — no synthetic anchor, no
  // empty-text placeholder.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/test-codex-hist-image',
    writeFile: async () => undefined,
    rm: async () => undefined,
  });
  await backend.handle(
    assign('caption please', 'ctx-hist-img', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [
          { kind: 'text', text: 'caption please' },
          {
            kind: 'file',
            file: {
              mimeType: 'image/png',
              bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            },
          },
        ],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            chat_history: [
              {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'tc1', function: { name: 'f', arguments: '{}' } }],
              },
              { role: 'tool', tool_call_id: 'tc1', content: 'r' },
            ],
          },
        },
      },
    }),
    collect().emit,
    NEVER,
  );
  const frames = fake.lastChild().stdinFrames();
  const inject = findRequest(frames, 'thread/inject_items');
  const injectItems = (inject as {
    params?: { items?: Array<Record<string, unknown>> };
  }).params?.items;
  // Inject carries only the tool round-trip slice — no user-message
  // anchor (the trailing user goes via turn/start.input).
  assert.deepEqual(injectItems, [
    { type: 'function_call', call_id: 'tc1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'tc1', output: 'r' },
  ]);
  const turnStart = findRequest(frames, 'turn/start');
  const input = (turnStart as {
    params?: { input?: Array<{ type: string; text?: string; path?: string }> };
  }).params?.input;
  // The user's text + the image both ride turn/start.input normally.
  assert.equal(input?.length, 2);
  assert.equal(input?.[0]?.type, 'text');
  assert.equal(input?.[0]?.text, 'caption please');
  assert.equal(input?.[1]?.type, 'localImage');
});

test('parallel tool_calls in one assistant entry fan out into one function_call item each', async () => {
  // OpenAI permits multiple tool_calls per assistant message (parallel
  // tool use). Each becomes its own native function_call item so codex's
  // session sees each call as a discrete event.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(
    assign('next', 'ctx-parallel', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'next' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            chat_history: [
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'tc1', function: { name: 'a', arguments: '{"x":1}' } },
                  { id: 'tc2', function: { name: 'b', arguments: '{"y":2}' } },
                ],
              },
              { role: 'tool', tool_call_id: 'tc1', content: 'A' },
              { role: 'tool', tool_call_id: 'tc2', content: 'B' },
            ],
          },
        },
      },
    }),
    collect().emit,
    NEVER,
  );
  const inject = findRequest(fake.lastChild().stdinFrames(), 'thread/inject_items');
  const items = (inject as { params?: { items?: Array<Record<string, unknown>> } })
    .params?.items;
  assert.deepEqual(items, [
    { type: 'function_call', call_id: 'tc1', name: 'a', arguments: '{"x":1}' },
    { type: 'function_call', call_id: 'tc2', name: 'b', arguments: '{"y":2}' },
    { type: 'function_call_output', call_id: 'tc1', output: 'A' },
    { type: 'function_call_output', call_id: 'tc2', output: 'B' },
  ]);
});

test('expired session falls back to thread/start instead of thread/resume', async () => {
  const fake = makeFakeSpawn(() => happyPath());
  let clock = 1_000_000;
  const backend = createCodexBackend({
    spawn: fake.spawn,
    sessionTtlMs: 1_000,
    now: () => clock,
  });

  await backend.handle(assign('first', 'ctx-ttl'), collect().emit, NEVER);
  clock += 60_000; // jump well past the TTL
  await backend.handle(assign('second', 'ctx-ttl'), collect().emit, NEVER);

  const frames = fake.lastChild().stdinFrames();
  const starts = frames.filter((f) => (f as { method?: string }).method === 'thread/start').length;
  const resumes = frames.filter((f) => (f as { method?: string }).method === 'thread/resume').length;
  assert.equal(starts, 2, 'expired session re-runs thread/start');
  assert.equal(resumes, 0, 'no thread/resume across the TTL boundary');
});

test('two concurrent tasks on the same contextId run sequentially through the mutex', async () => {
  // Make the fake server delay turn/completed so we can observe the ordering.
  const fake = makeFakeSpawn(() => {
    let turnCounter = 0;
    const pendingTurns: Array<{ id: number | string; localId: string }> = [];
    return {
      onLine(frame, child) {
        const id = (frame as { id?: number | string }).id;
        const method = (frame as { method?: string }).method;
        if (method === 'initialize' && id !== undefined) {
          child.emitStdout({ id, result: { userAgent: 'fake' } });
          return;
        }
        if ((method === 'thread/start' || method === 'thread/resume') && id !== undefined) {
          child.emitStdout({ id, result: { thread: { id: 'thr' } } });
          return;
        }
        if (method === 'turn/start' && id !== undefined) {
          turnCounter += 1;
          const localTurnId = `turn-${turnCounter}`;
          child.emitStdout({ id, result: { turn: { id: localTurnId, status: 'inProgress' } } });
          pendingTurns.push({ id, localId: localTurnId });
          // Drive turns to completion on the next macrotask; the second
          // turn must not race the first.
          setTimeout(() => {
            const t = pendingTurns.shift();
            if (!t) return;
            child.emitStdout({
              method: 'item/completed',
              params: {
                turnId: t.localId,
                item: { type: 'agentMessage', id: 'a', text: `r-${t.localId}` },
              },
            });
            child.emitStdout({
              method: 'turn/completed',
              params: { turn: { id: t.localId, status: 'completed' } },
            });
          }, 10);
        }
      },
    };
  });
  const backend = createCodexBackend({ spawn: fake.spawn });

  const a = collect();
  const b = collect();
  const t0 = Date.now();
  const promiseA = backend.handle(assign('first', 'ctx-conc'), a.emit, NEVER);
  const promiseB = backend.handle(assign('second', 'ctx-conc'), b.emit, NEVER);
  await Promise.all([promiseA, promiseB]);
  const elapsed = Date.now() - t0;

  // Both tasks completed.
  assert.equal(a.frames.at(-1)?.type, 'task.complete');
  assert.equal(b.frames.at(-1)?.type, 'task.complete');
  // Each fake turn carries a 10ms delay; serial execution should land
  // around 20ms+ rather than ~10ms parallel.
  assert.ok(elapsed >= 18, `concurrent same-context should serialise (elapsed=${elapsed}ms)`);

  // Sanity: only ONE turn was on the wire at any moment — the second
  // turn/start would have been queued, so they arrived in order.
  const frames = fake.lastChild().stdinFrames();
  const turnStarts = frames.filter((f) => (f as { method?: string }).method === 'turn/start');
  assert.equal(turnStarts.length, 2);
});

test('backend tolerates a malformed (non-JSON) stdout line without breaking the turn', async () => {
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: unknown }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        // Garbage line first — must NOT crash the dispatcher.
        child.emitStdoutRaw('this is not json\n');
        child.emitStdout({ id, result: { userAgent: 'fake' } });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        child.emitStdout({ id, result: { thread: { id: 'thr' } } });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        child.emitStdout({ id, result: { turn: { id: 't', status: 'inProgress' } } });
        queueMicrotask(() => {
          child.emitStdout({
            method: 'item/completed',
            params: { turnId: 't', item: { type: 'agentMessage', id: 'a', text: 'ok' } },
          });
          child.emitStdout({
            method: 'turn/completed',
            params: { turn: { id: 't', status: 'completed' } },
          });
        });
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('turn/start RPC error surfaces task.fail with turn_failed', async () => {
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: unknown }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({ id, result: { userAgent: 'fake' } });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        child.emitStdout({ id, result: { thread: { id: 'thr' } } });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        child.emitStdout({
          id,
          error: { code: -32001, message: 'overloaded' },
        });
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);
  const last = frames.at(-1);
  assert.equal(last?.type, 'task.fail');
  assert.equal(last?.type === 'task.fail' && last.error.code, 'turn_failed');
});

// Native function-call surface (#209): codex sends `item/tool/call` as a
// server request when the model invokes a caller-supplied dynamicTool. The
// bridge captures it, emits an OpenAI-shaped `tool_calls` artifact, and
// interrupts the turn so codex unwinds — the caller delivers the result on
// the next A2A turn via `chat_history` (existing path). A2A surfaces
// the task as `completed` (not `canceled`) so OpenAI Chat Completions
// callers see `finish_reason: "tool_calls"` semantics.
test('openai-compat dynamicTools: item/tool/call → tool_calls artifact + completed task (#209)', async () => {
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: number | string }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({ id, result: { userAgent: 'fake/0.130.0' } });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        child.emitStdout({ id, result: { thread: { id: 'thr-1' } } });
        return;
      }
      if (method === 'thread/inject_items' && id !== undefined) {
        child.emitStdout({ id, result: {} });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        child.emitStdout({
          id,
          result: { turn: { id: 'turn-1', status: 'inProgress' } },
        });
        // Codex fires `item/tool/call` as a server-initiated request once
        // the model emits a function_call. The bridge must respond with a
        // DynamicToolCallResponse to unblock codex.
        queueMicrotask(() => {
          child.emitStdout({
            id: 'srv-1',
            method: 'item/tool/call',
            params: {
              threadId: 'thr-1',
              turnId: 'turn-1',
              callId: 'call_xyz',
              namespace: null,
              tool: 'fetch',
              arguments: { url: 'https://example.com' },
            },
          });
        });
        return;
      }
      if (method === 'turn/interrupt' && id !== undefined) {
        child.emitStdout({ id, result: {} });
        // After receiving turn/interrupt, codex emits the terminal
        // notification with status:'interrupted'.
        queueMicrotask(() => {
          child.emitStdout({
            method: 'turn/completed',
            params: {
              turn: {
                id: 'turn-1',
                status: 'interrupted',
                items: [],
                error: null,
              },
            },
          });
        });
        return;
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assign('fetch example.com', 'ctx-oai', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'fetch example.com' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            system: 'be terse',
            tools: [
              {
                type: 'function',
                function: {
                  name: 'fetch',
                  description: 'Fetch a URL',
                  parameters: {
                    type: 'object',
                    properties: { url: { type: 'string' } },
                    required: ['url'],
                  },
                },
              },
            ],
          },
        },
      },
    }),
    emit,
    NEVER,
  );

  // The artifact must carry the OpenAI `tool_calls` envelope as a `data`
  // part — same wire shape PR #208 already emitted on the legacy envelope
  // path, so downstream gateways see no difference.
  const artifact = frames.find((f) => f.type === 'task.artifact');
  assert.ok(artifact, 'tool_calls artifact emitted');
  if (artifact?.type === 'task.artifact') {
    const p = artifact.artifact.parts[0];
    assert.equal(p.kind, 'data');
    assert.ok(
      artifact.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI),
    );
    if (p.kind === 'data') {
      const data = p.data as {
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
      };
      assert.equal(data.tool_calls?.length, 1);
      assert.equal(data.tool_calls?.[0]?.id, 'call_xyz');
      assert.equal(data.tool_calls?.[0]?.function?.name, 'fetch');
      assert.deepEqual(data.tool_calls?.[0]?.function?.arguments, {
        url: 'https://example.com',
      });
    }
  }

  // Despite the underlying turn ending in `interrupted`, the A2A task must
  // surface as `completed` because the model invoked a tool (caller asked
  // for cancelation is the only other path).
  const complete = frames.find((f) => f.type === 'task.complete');
  assert.ok(complete && complete.type === 'task.complete');
  assert.equal(complete.status.state, 'completed');

  // Bridge must have sent `turn/interrupt` for our turn — that, plus
  // codex's terminal `turn/completed` notification, is what unwinds the
  // turn. (The bridge also sends back a `DynamicToolCallResponse` for the
  // server-initiated `item/tool/call`, but the async handler's promise
  // unwrap may schedule that write one microtask after `handle()` returns;
  // we drain the queue below before asserting it was eventually sent.)
  const sent = fake.lastChild().stdinFrames();
  const interrupt = findRequest(sent, 'turn/interrupt');
  assert.ok(interrupt, 'turn/interrupt was sent');

  // Drain pending microtasks, then confirm the bridge eventually replied
  // to the server-initiated `item/tool/call`. codex would block the turn
  // indefinitely waiting for that response, so it must always be sent —
  // even though the turn/interrupt path means codex won't act on its
  // contents. A few macrotask cycles flush any chained promise resolutions
  // that emit() and `respond()` queue independently of the await graph.
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  const drained = fake.lastChild().stdinFrames();
  const toolResp = drained.find(
    (f) =>
      f !== null &&
      typeof f === 'object' &&
      (f as { id?: unknown }).id === 'srv-1' &&
      'result' in (f as object),
  ) as { result?: { contentItems?: unknown[]; success?: boolean } } | undefined;
  assert.ok(toolResp, 'bridge responded to item/tool/call');
  assert.equal(typeof toolResp?.result?.success, 'boolean');

  // dynamicTools must have been included on thread/start.
  const tsFrame = findRequest(sent, 'thread/start') as
    | { params?: { dynamicTools?: Array<{ name?: string }> } }
    | undefined;
  const dynTools = tsFrame?.params?.dynamicTools;
  assert.ok(Array.isArray(dynTools) && dynTools.length === 1);
  assert.equal(dynTools?.[0]?.name, 'fetch');

  // developerInstructions must contain only the user's system text (no
  // envelope-teaching block, no JSON contract block, no `tool_calls` literal).
  const params = (tsFrame as { params?: { developerInstructions?: string } })
    .params;
  assert.ok(
    typeof params?.developerInstructions === 'string' &&
      params.developerInstructions.length > 0,
    'developerInstructions sent on thread/start',
  );
  assert.equal(
    params.developerInstructions?.includes('tool_calls'),
    false,
    'native path must not teach the JSON envelope contract',
  );
});

// Unit cover for the OpenAI → DynamicToolSpec mapping. Critical because the
// gateway only validates the OpenAI shape; the bridge is the last filter
// before codex's stricter `validate_dynamic_tools` rejects a malformed spec.
test('openaiToolsToDynamicToolSpecs maps OpenAI tools and drops malformed entries (#209)', () => {
  const out = openaiToolsToDynamicToolSpecs([
    {
      type: 'function',
      function: {
        name: 'fetch',
        description: 'Fetch a URL',
        parameters: { type: 'object', properties: { url: { type: 'string' } } },
      },
    },
    // Entries below must be dropped:
    { type: 'function' }, // no function body
    { type: 'function', function: { description: 'no name' } }, // no name
    { type: 'function', function: { name: '' } }, // empty name
    null,
    'oops',
    { function: { name: 'no-type-wrapper' } }, // missing type:"function"
  ] as unknown[]);
  assert.ok(Array.isArray(out));
  assert.equal(out?.length, 1);
  assert.deepEqual(out?.[0], {
    name: 'fetch',
    description: 'Fetch a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  });

  // Empty input ⇒ null so callers can branch without inspecting `.length`.
  assert.equal(openaiToolsToDynamicToolSpecs([]), null);
  assert.equal(openaiToolsToDynamicToolSpecs([null, undefined]), null);

  // A tool with no `parameters` becomes the canonical empty-object schema —
  // codex requires `inputSchema` to be present.
  const noParams = openaiToolsToDynamicToolSpecs([
    { type: 'function', function: { name: 'ping' } },
  ]);
  assert.deepEqual(noParams?.[0]?.inputSchema, {
    type: 'object',
    properties: {},
  });
});

// Unit cover for the native-path developer-instructions composer. The
// invariant matters because the envelope-teaching block in the legacy
// helper is the very thing we are removing on #209 — accidentally
// re-introducing it would put the model back into the parse-from-text
// failure modes #208 catalogued.
test('composeNativeDevInstructions includes system text, omits JSON envelope contract (#209)', () => {
  assert.equal(
    composeNativeDevInstructions({ system: 'be terse' }),
    'be terse',
  );
  // tool_choice="required" gets a steering line.
  const requiredOut = composeNativeDevInstructions({
    system: 'sys',
    tools: [],
    tool_choice: 'required',
  });
  assert.ok(requiredOut.startsWith('sys'));
  assert.ok(requiredOut.includes('tool_choice="required"'));
  // Named function tool_choice gets a steering line naming the function.
  const namedOut = composeNativeDevInstructions({
    system: '',
    tools: [],
    tool_choice: { type: 'function', function: { name: 'fetch' } },
  });
  assert.ok(namedOut.includes('"fetch"'));
  // Crucially: no envelope contract anywhere in the output, even when
  // `tools` is present in the metadata.
  const withTools = composeNativeDevInstructions({
    system: 'sys',
    tools: [{ type: 'function', function: { name: 'fetch' } }],
    tool_choice: 'auto',
  });
  assert.equal(withTools.includes('tool_calls'), false);
  assert.equal(withTools.includes('{"tool_calls"'), false);
});

// openai-compat tasks always do `thread/start` (never thread/resume — see
// the session-reuse guard for #233), but the second A2A turn still needs a
// working caller-tools handler. This guards against a regression where the
// handler is only registered on the *first* contextId encounter and a
// follow-up turn silently lands on the default "no handler" path.
test('dynamicTools handler is registered on every openai-compat turn (#209, #233)', async () => {
  let turnCount = 0;
  const fake = makeFakeSpawn(() => ({
    onLine(frame, child) {
      const id = (frame as { id?: number | string }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({ id, result: {} });
        return;
      }
      if (method === 'thread/start' && id !== undefined) {
        // Mint a fresh thread id per call so the handler-registration test
        // is meaningful — registration is keyed on threadId, so the second
        // turn must register on its OWN id.
        turnCount += 1;
        child.emitStdout({ id, result: { thread: { id: `thr-${turnCount}` } } });
        return;
      }
      if (method === 'thread/inject_items' && id !== undefined) {
        child.emitStdout({ id, result: {} });
        return;
      }
      if (method === 'turn/start' && id !== undefined) {
        const turnId = `turn-${turnCount}`;
        const threadId = `thr-${turnCount}`;
        child.emitStdout({
          id,
          result: { turn: { id: turnId, status: 'inProgress' } },
        });
        if (turnCount === 1) {
          // First turn completes plainly so we can drive a second one.
          queueMicrotask(() => {
            child.emitStdout({
              method: 'item/completed',
              params: {
                turnId,
                threadId,
                item: { type: 'agentMessage', id: 'a1', text: 'first' },
              },
            });
            child.emitStdout({
              method: 'turn/completed',
              params: {
                turn: { id: turnId, status: 'completed', items: [], error: null },
              },
            });
          });
        } else {
          // Second turn: fire item/tool/call against the fresh thread id to
          // prove the handler is registered on the new turn's thread.
          queueMicrotask(() => {
            child.emitStdout({
              id: 'srv-r',
              method: 'item/tool/call',
              params: {
                threadId,
                turnId,
                callId: 'call_second_turn',
                namespace: null,
                tool: 'fetch',
                arguments: { x: 1 },
              },
            });
          });
        }
        return;
      }
      if (method === 'turn/interrupt' && id !== undefined) {
        child.emitStdout({ id, result: {} });
        queueMicrotask(() => {
          child.emitStdout({
            method: 'turn/completed',
            params: {
              turn: { id: `turn-${turnCount}`, status: 'interrupted', items: [], error: null },
            },
          });
        });
        return;
      }
    },
  }));
  const backend = createCodexBackend({ spawn: fake.spawn });

  const oaiMeta = {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      system: 'sys',
      tools: [
        {
          type: 'function',
          function: { name: 'fetch', parameters: {} },
        },
      ],
    },
  };

  // Turn 1.
  await backend.handle(
    assign('first', 'ctx-no-resume', {
      message: {
        role: 'user',
        messageId: 'm1',
        parts: [{ kind: 'text', text: 'first' }],
        metadata: oaiMeta,
      },
    }),
    () => {},
    NEVER,
  );

  // Turn 2: same contextId still does thread/start (no reuse under
  // openai-compat). The handler must register on the new thread id so the
  // model's tool_call surfaces as a `tool_calls` artifact.
  const { emit, frames } = collect();
  await backend.handle(
    assign('second', 'ctx-no-resume', {
      message: {
        role: 'user',
        messageId: 'm2',
        parts: [{ kind: 'text', text: 'second' }],
        metadata: oaiMeta,
      },
    }),
    emit,
    NEVER,
  );

  const artifact = frames.find((f) => f.type === 'task.artifact');
  assert.ok(artifact, 'tool_calls artifact emitted on the second turn');
  if (artifact?.type === 'task.artifact') {
    assert.ok(
      artifact.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI),
    );
  }
  const complete = frames.find((f) => f.type === 'task.complete');
  assert.ok(complete && complete.type === 'task.complete');
  assert.equal(complete.status.state, 'completed');

  // Both turns went through thread/start; thread/resume is never used for
  // openai-compat tasks (#233 session-reuse guard).
  const sent = fake.lastChild().stdinFrames();
  const starts = sent.filter(
    (f) => (f as { method?: string }).method === 'thread/start',
  );
  const resumes = sent.filter(
    (f) => (f as { method?: string }).method === 'thread/resume',
  );
  assert.equal(starts.length, 2);
  assert.equal(resumes.length, 0);
});

// The full set of codex features the backend disables when caller-side
// tool dispatch is active. Pinning the list here so a regression that
// drops one of them (re-enabling, say, browser_use under openai-compat)
// fails loudly rather than silently widening the agent's surface back
// out to direct execution. If you update this list, also update the
// matching block in `codex.ts` and call out the addition in the PR.
// Features the openai-compat dispatch path zeroes out via `config.features`.
// This list is INTENTIONALLY narrower than the full set of codex built-ins
// because `environments: []` (asserted separately below) structurally removes
// every handler gated on `environment_mode.has_environment()` — shell /
// unified_exec / exec_command / write_stdin / shell_command / local_shell /
// container.exec / apply_patch / view_image — without needing a feature flag.
// What remains here is the set of surfaces NOT gated by environment: hosted
// modalities, plugin/MCP discovery, multi-agent orchestration, etc.
// If you update this list, also update the matching block in `codex.ts` and
// call out the addition in the PR.
const EXPECTED_OPENAI_COMPAT_DISABLES: Record<string, boolean> = {
  image_generation: false,
  web_search_request: false,
  web_search_cached: false,
  tool_search: false,
  tool_suggest: false,
  tool_call_mcp_elicitation: false,
  builtin_mcp: false,
  plugins: false,
  apps: false,
  enable_mcp_apps: false,
  multi_agent: false,
  multi_agent_v2: false,
  enable_fanout: false,
  request_permissions_tool: false,
  code_mode: false,
  goals: false,
  memories: false,
  workspace_dependencies: false,
};

test('thread/start disables every codex direct-execution feature when caller tools are active (#175, PR #180, #183)', async () => {
  // Without this, codex would execute the caller's "bash" call itself in
  // its sandbox and emit a plain-text result instead of the openai-compat
  // envelope the caller is waiting for. Defense is on two seams:
  // `environments: []` (asserted in a separate test) drops every handler
  // gated on `environment_mode.has_environment()` — shell / unified_exec /
  // exec_command / write_stdin / shell_command / local_shell / container.exec
  // / apply_patch / view_image. This test covers the surfaces NOT covered by
  // that: hosted modalities (image gen, web search), plugin/MCP discovery,
  // multi-agent / fan-out, request_permissions, experimental code surfaces,
  // and workspace introspection.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(
    assign('list files', 'ctx-features', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'list files' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
          },
        },
      },
    }),
    collect().emit,
    NEVER,
  );

  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as {
    params?: { config?: { features?: Record<string, boolean> } };
  }).params;
  assert.deepEqual(params?.config?.features, EXPECTED_OPENAI_COMPAT_DISABLES);
});

test('thread/start sends `environments: []` when caller tools are active (#183)', async () => {
  // `environments: []` is the wholesale lever that drops every codex
  // handler whose registration is gated on `environment_mode.has_environment()`
  // — most importantly the entire exec/shell surface (`shell`,
  // `unified_exec`, `exec_command`, `write_stdin`, `shell_command`,
  // `local_shell`, `container.exec`) and `apply_patch` / `view_image`.
  // Without this, `features.shell_tool: false` alone leaves `exec_command`
  // callable (see #183: codex cli 0.130 actually executed `git clone` via
  // `exec_command` despite our feature disables).
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(
    assign('list files', 'ctx-env-empty', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'list files' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
          },
        },
      },
    }),
    collect().emit,
    NEVER,
  );

  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as { params?: { environments?: unknown[] } }).params;
  assert.deepEqual(params?.environments, []);
});

test('thread/start omits `environments` when no caller tools are supplied', async () => {
  // Non-openai-compat callers (or openai-compat without tools) still expect
  // codex to behave as a normal coding agent with its full environment, so
  // we must NOT clamp environments to []. Gate matches `callerToolDispatchActive`.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('hi', 'ctx-no-env-clamp'), collect().emit, NEVER);

  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as { params?: { environments?: unknown } }).params;
  assert.equal(params?.environments, undefined);
});

test('thread/resume does NOT send `environments` (sticky on start; ResumeParams does not accept it) (#183)', async () => {
  // `environments` is set once on `thread/start` and carries across resumes
  // via the server-side session record. `ThreadResumeParams` in codex
  // app-server-protocol has no `environments` field, so sending it on
  // resume would either be ignored or rejected. Verify we only send it on
  // start — uses a plain (non-openai-compat) flow because openai-compat
  // never resumes (see #233 session-reuse guard).
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('one', 'ctx-env-resume'), collect().emit, NEVER);
  await backend.handle(assign('two', 'ctx-env-resume'), collect().emit, NEVER);

  const frames = fake.lastChild().stdinFrames();
  const resume = findRequest(frames, 'thread/resume');
  assert.ok(resume, 'thread/resume observed');
  const resumeParams = (resume as { params?: { environments?: unknown } }).params;
  assert.equal(resumeParams?.environments, undefined);
});

test('thread/start omits `config` when no caller tools are supplied', async () => {
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  // Plain text task with no openai-compat metadata.
  await backend.handle(assign('hi', 'ctx-no-features'), collect().emit, NEVER);

  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as { params?: { config?: unknown } }).params;
  assert.equal(params?.config, undefined);
});

test('history-only openai-compat payload (no `tools`) does not disable codex built-ins via features (but still suppresses env_context)', async () => {
  // Mirror of the codex (exec) backend test. With tools absent there is no
  // caller-side dispatch contract to protect; do not handicap codex's
  // built-ins for this turn. `include_environment_context: false` still
  // applies — it's an openai-compat-wide invariant (#233), not gated on
  // caller-tool dispatch.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(
    assign('continue', 'ctx-hist-no-feat', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'continue' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            chat_history: [
              {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'tc1', function: { name: 'x', arguments: '{}' } }],
              },
              { role: 'tool', tool_call_id: 'tc1', content: 'OK' },
            ],
          },
        },
      },
    }),
    collect().emit,
    NEVER,
  );

  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as {
    params?: { config?: { features?: unknown; include_environment_context?: boolean } };
  }).params;
  assert.equal(params?.config?.features, undefined);
  assert.equal(params?.config?.include_environment_context, false);
});

test('openai-compat tasks always thread/start, never thread/resume — every turn re-sends config.features (#175, #233)', async () => {
  // The OpenAI Chat Completions request is stateless: gateway replays the
  // full message history every turn. Reusing a codex thread across turns
  // would double-feed the model (persisted thread items + injected
  // `chat_history`), which causes the model to drift onto stale
  // results. So openai-compat opts out of session reuse entirely, and
  // every turn does `thread/start` with the disable-flags `config.features`
  // (no `thread/resume` to forget them on).
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  const meta = {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
    },
  };
  await backend.handle(
    assign('one', 'ctx-feat-no-resume', {
      message: {
        role: 'user',
        messageId: 'm1',
        parts: [{ kind: 'text', text: 'one' }],
        metadata: meta,
      },
    }),
    collect().emit,
    NEVER,
  );
  await backend.handle(
    assign('two', 'ctx-feat-no-resume', {
      message: {
        role: 'user',
        messageId: 'm2',
        parts: [{ kind: 'text', text: 'two' }],
        metadata: meta,
      },
    }),
    collect().emit,
    NEVER,
  );

  const frames = fake.lastChild().stdinFrames();
  const starts = frames.filter((f) => (f as { method?: string }).method === 'thread/start');
  const resumes = frames.filter((f) => (f as { method?: string }).method === 'thread/resume');
  assert.equal(starts.length, 2, 'both openai-compat turns thread/start');
  assert.equal(resumes.length, 0, 'never thread/resume for openai-compat');
  for (const start of starts) {
    const features = (start as { params?: { config?: { features?: Record<string, boolean> } } })
      .params?.config?.features;
    assert.deepEqual(features, EXPECTED_OPENAI_COMPAT_DISABLES);
  }
});

test('thread/tokenUsage/updated is forwarded as openai-compat usage metadata', async () => {
  const fake = makeFakeSpawn(() =>
    happyPath({
      agentMessageText: 'usage ok',
      tokenUsage: {
        total: {
          totalTokens: 200,
          inputTokens: 160,
          cachedInputTokens: 96,
          outputTokens: 40,
          reasoningOutputTokens: 12,
        },
        last: {
          totalTokens: 200,
          inputTokens: 160,
          cachedInputTokens: 96,
          outputTokens: 40,
          reasoningOutputTokens: 12,
        },
        modelContextWindow: 258400,
      },
    }),
  );
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();

  await backend.handle(assign('hi'), emit, NEVER);

  const complete = frames.find((f) => f.type === 'task.complete');
  assert.ok(complete && complete.type === 'task.complete');
  assert.deepEqual(complete.status.message?.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
  const payload = complete.status.message?.metadata?.[OPENAI_COMPAT_EXTENSION_URI] as {
    usage?: Record<string, unknown>;
  };
  assert.equal(payload?.usage?.prompt_tokens, 160);
  assert.equal(payload?.usage?.completion_tokens, 40);
  assert.equal(payload?.usage?.total_tokens, 200);
  assert.deepEqual(payload?.usage?.prompt_tokens_details, { cached_tokens: 96 });
  assert.deepEqual(payload?.usage?.completion_tokens_details, { reasoning_tokens: 12 });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCapabilities — reads codex's `config.toml` to advertise the
// underlying model on the openai-compat/v1 extension (planetarium/oai2a2a#63).
// ─────────────────────────────────────────────────────────────────────────────

test('parseCodexConfigTomlForModel extracts model + reasoning from real-shape config', () => {
  const text = [
    'model = "gpt-5.4"',
    'model_reasoning_effort = "medium"',
    '[projects."/home/op/repo"]',
    'trust_level = "trusted"',
  ].join('\n');
  const out = parseCodexConfigTomlForModel(text);
  assert.equal(out.model, 'gpt-5.4');
  assert.equal(out.hasReasoningEffort, true);
});

test('parseCodexConfigTomlForModel treats reasoning_effort="none" as not-reasoning', () => {
  const text = ['model = "gpt-4o"', 'model_reasoning_effort = "none"'].join('\n');
  const out = parseCodexConfigTomlForModel(text);
  assert.equal(out.model, 'gpt-4o');
  assert.equal(out.hasReasoningEffort, false);
});

test('parseCodexConfigTomlForModel ignores model = inside a [section]', () => {
  // codex permits per-profile overrides under sub-tables; those MUST NOT
  // be read as the agent's default model, because our spawn does not
  // select a profile.
  const text = [
    'model = "gpt-5.4"',
    '',
    '[profiles.qa]',
    'model = "gpt-3.5"',
  ].join('\n');
  const out = parseCodexConfigTomlForModel(text);
  assert.equal(out.model, 'gpt-5.4');
});

test('parseCodexConfigTomlForModel returns null model when key is absent', () => {
  const text = '[projects."/x"]\ntrust_level = "trusted"\n';
  const out = parseCodexConfigTomlForModel(text);
  assert.equal(out.model, null);
  assert.equal(out.hasReasoningEffort, false);
});

test('parseCodexConfigTomlForModel accepts literal-string values and ignores comments', () => {
  const text = [
    "model = 'gpt-5.4'  # default for the agent",
    '# model = "decoy"',
    'model_reasoning_effort = "high"',
  ].join('\n');
  const out = parseCodexConfigTomlForModel(text);
  assert.equal(out.model, 'gpt-5.4');
  assert.equal(out.hasReasoningEffort, true);
});

// Scenario helper: respond to `initialize` then to `model/list` with the
// supplied entries. Any other inbound RPC is ignored — the probe never
// issues a thread/start or turn/start, so we don't bother modelling
// those response paths here.
function modelListScenario(
  entries: ModelListEntry[],
  opts: { failModelList?: boolean } = {},
): ChildScenario {
  return {
    onLine(frame, child) {
      const id = (frame as { id?: number | string }).id;
      const method = (frame as { method?: string }).method;
      if (method === 'initialize' && id !== undefined) {
        child.emitStdout({
          id,
          result: {
            userAgent: 'fake-codex/0.133.0',
            codexHome: '/tmp',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        });
        return;
      }
      if (method === 'model/list' && id !== undefined) {
        if (opts.failModelList) {
          child.emitStdout({ id, error: { code: -32601, message: 'Method not found' } });
        } else {
          child.emitStdout({ id, result: { data: entries } });
        }
        return;
      }
    },
  };
}

test('codex backend resolveCapabilities advertises full model/list with default tag', async () => {
  const fake = makeFakeSpawn(() =>
    modelListScenario([
      {
        id: 'gpt-5.5',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      },
      {
        id: 'gpt-5.4',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      },
      { id: 'gpt-4o' },
    ]),
  );
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => null, // no operator override
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [
      { id: 'gpt-5.5', reasoning: true, default: true },
      { id: 'gpt-5.4', reasoning: true },
      { id: 'gpt-4o' },
    ],
  });
  backend.stop?.();
});

test('codex backend resolveCapabilities tags operator override as default, not model/list.isDefault', async () => {
  const fake = makeFakeSpawn(() =>
    modelListScenario([
      { id: 'gpt-5.5', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { id: 'gpt-5.4', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    ]),
  );
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => 'model = "gpt-5.4"\n',
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [
      { id: 'gpt-5.5', reasoning: true }, // codex's recommended default loses to operator override
      { id: 'gpt-5.4', reasoning: true, default: true },
    ],
  });
  backend.stop?.();
});

test('codex backend resolveCapabilities surfaces operator override that is absent from model/list', async () => {
  // Custom provider / beta access: the operator pinned a model codex's
  // own picker doesn't surface. We still advertise it (and tag default)
  // because that's what the spawn actually loads.
  const fake = makeFakeSpawn(() =>
    modelListScenario([{ id: 'gpt-5.5', isDefault: true }]),
  );
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => 'model = "claude-opus-via-litellm"\n',
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [
      { id: 'claude-opus-via-litellm', default: true },
      { id: 'gpt-5.5' },
    ],
  });
  backend.stop?.();
});

test('codex backend resolveCapabilities omits reasoning when supportedReasoningEfforts is empty', async () => {
  const fake = makeFakeSpawn(() =>
    modelListScenario([
      { id: 'gpt-4o', isDefault: true, supportedReasoningEfforts: [] },
    ]),
  );
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => null,
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [{ id: 'gpt-4o', default: true }],
  });
  backend.stop?.();
});

test('codex backend resolveCapabilities skips hidden entries', async () => {
  const fake = makeFakeSpawn(() =>
    modelListScenario([
      { id: 'gpt-5.5', isDefault: true },
      { id: 'gpt-3.5-legacy', hidden: true },
    ]),
  );
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => null,
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [{ id: 'gpt-5.5', default: true }],
  });
  backend.stop?.();
});

test('codex backend resolveCapabilities returns {} when model/list is unsupported', async () => {
  const fake = makeFakeSpawn(() => modelListScenario([], { failModelList: true }));
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => null,
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {});
  backend.stop?.();
});

test('codex backend resolveCapabilities returns {} when model/list response is empty', async () => {
  const fake = makeFakeSpawn(() => modelListScenario([]));
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => null,
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {});
  backend.stop?.();
});

test('codex backend resolveCapabilities tolerates a config.toml reader that throws', async () => {
  // The operator override is a soft signal — its absence shouldn't take
  // the whole probe down. model/list still drives the advertise.
  const fake = makeFakeSpawn(() =>
    modelListScenario([{ id: 'gpt-5.5', isDefault: true }]),
  );
  const backend = createCodexBackend({
    spawn: fake.spawn,
    readCodexConfigToml: async () => {
      throw new Error('boom');
    },
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [{ id: 'gpt-5.5', default: true }],
  });
  backend.stop?.();
});
