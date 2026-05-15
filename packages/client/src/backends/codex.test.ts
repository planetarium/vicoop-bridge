import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexBackend } from './codex.js';
import type {
  AppServerChildHandle,
  AppServerSpawnFn,
  AppServerSpawnOptions,
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

test('openai-compat tool_call_history is injected as native Responses API items, NOT folded into user text', async () => {
  // Codex absorbs `function_call` / `function_call_output` items as proper
  // prior tool dispatch — the model sees them as its own past actions and
  // does not re-emit the same envelope (#176). The text input must NOT
  // carry a `<tool_call_history>` blob anymore: the native channel is the
  // single source of truth.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assign('next', 'ctx-hist', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'next' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            tool_call_history: [
              {
                role: 'assistant',
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

  // thread/inject_items must be sent between thread/start and turn/start,
  // with one function_call + one function_call_output item paired by call_id.
  const inject = findRequest(fake.lastChild().stdinFrames(), 'thread/inject_items');
  assert.ok(inject, 'thread/inject_items observed');
  const injectParams = (inject as {
    params?: { items?: Array<Record<string, unknown>> };
  }).params;
  assert.deepEqual(injectParams?.items, [
    { type: 'function_call', call_id: 'tc1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'tc1', output: 'OK' },
  ]);

  // The user text part of turn/start carries ONLY the user's text — no
  // history blob is folded in.
  const turnStart = findRequest(fake.lastChild().stdinFrames(), 'turn/start');
  const params = (turnStart as {
    params?: { input?: Array<{ type: string; text?: string }> };
  }).params;
  const textItem = params?.input?.find((it) => it.type === 'text');
  assert.equal(textItem?.text, 'next');
  assert.equal(frames.at(-1)?.type, 'task.complete');
});

test('absent tool_call_history skips thread/inject_items entirely', async () => {
  // First-turn tasks (no prior round-trips) must NOT send a dangling
  // empty-items inject.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('hi', 'ctx-no-hist'), collect().emit, NEVER);
  const inject = findRequest(fake.lastChild().stdinFrames(), 'thread/inject_items');
  assert.equal(inject, null);
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
            tool_call_history: [
              {
                role: 'assistant',
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

test('openai-compat envelope agent message is emitted as a data part', async () => {
  const envelope = JSON.stringify({
    tool_calls: [{ id: '1', function: { name: 'fetch', arguments: '{}' } }],
  });
  const fake = makeFakeSpawn(() => happyPath({ agentMessageText: envelope }));
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assign('what tools?', 'ctx-oai', {
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'what tools?' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            system: 'be terse',
            tools: [{ type: 'function', function: { name: 'fetch', parameters: {} } }],
          },
        },
      },
    }),
    emit,
    NEVER,
  );

  // The envelope-shaped agent message must be a `data` part.
  const artifact = frames.find((f) => f.type === 'task.artifact');
  assert.ok(artifact);
  if (artifact?.type === 'task.artifact') {
    const p = artifact.artifact.parts[0];
    assert.equal(p.kind, 'data');
    assert.ok(artifact.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI));
  }

  // developerInstructions must have been included in thread/start.
  const tsFrame = findRequest(fake.lastChild().stdinFrames(), 'thread/start');
  const params = (tsFrame as { params?: { developerInstructions?: string } }).params;
  assert.ok(
    typeof params?.developerInstructions === 'string' &&
      params.developerInstructions.length > 0,
    'developerInstructions sent on thread/start',
  );
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
  // start.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  const meta = {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
    },
  };
  await backend.handle(
    assign('one', 'ctx-env-resume', {
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
    assign('two', 'ctx-env-resume', {
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

test('history-only openai-compat payload (no `tools`) does not disable codex built-ins', async () => {
  // Mirror of the codex (exec) backend test. With tools absent there is no
  // caller-side dispatch contract to protect; do not handicap codex's
  // built-ins for this turn.
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
            tool_call_history: [
              { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'x', arguments: '{}' } }] },
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
  const params = (tsFrame as { params?: { config?: unknown } }).params;
  assert.equal(params?.config, undefined);
});

test('thread/resume re-passes `config.features` because feature flags do not persist across resume (#175)', async () => {
  // Two turns on the same contextId: first thread/start, second
  // thread/resume. Both must carry the disable flags — feature settings
  // are scoped to a single resume span server-side, so a missing config on
  // resume would silently re-enable shell_tool.
  const fake = makeFakeSpawn(() => happyPath());
  const backend = createCodexBackend({ spawn: fake.spawn });
  const meta = {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
    },
  };
  await backend.handle(
    assign('one', 'ctx-feat-resume', {
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
    assign('two', 'ctx-feat-resume', {
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
  const start = findRequest(frames, 'thread/start');
  const resume = findRequest(frames, 'thread/resume');
  assert.ok(start, 'thread/start observed');
  assert.ok(resume, 'thread/resume observed');
  const startFeatures = (start as { params?: { config?: { features?: Record<string, boolean> } } })
    .params?.config?.features;
  const resumeFeatures = (resume as { params?: { config?: { features?: Record<string, boolean> } } })
    .params?.config?.features;
  assert.deepEqual(startFeatures, EXPECTED_OPENAI_COMPAT_DISABLES);
  assert.deepEqual(resumeFeatures, EXPECTED_OPENAI_COMPAT_DISABLES);
});
