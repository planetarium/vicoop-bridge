import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';
import { CallerScopedBackend } from './caller-scoped-backend.js';
import { scopeDigest } from './caller-runtime-store.js';
import type {
  CallerRuntimePool,
  CallerTaskRuntime,
} from './caller-runtime-docker.js';
import type { Backend } from './backend.js';

function task(
  principal = 'apikey:a',
  id = Math.random().toString(),
): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId: id,
    executionId: `exec-${id}`,
    contextId: 'same-context',
    message: {
      role: 'user',
      messageId: 'm',
      parts: [{ kind: 'text', text: 'hello' }],
    },
    caller: { principal: { id: principal } },
    executionScope: {
      policy: 'direct-principal-v1',
      id: scopeDigest('agent', principal),
      agentId: 'agent',
      principalId: principal,
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    restored?: string[];
    cleanup?: () => Promise<void>;
    handle?: Backend['handle'];
    maxScopes?: number;
    queueLimit?: number;
  } = {},
) {
  let starts = 0;
  let finishes = 0;
  let factories = 0;
  let active = 0;
  let peak = 0;
  const pool: CallerRuntimePool = {
    maxScopes: options.maxScopes ?? 2,
    queueLimit: options.queueLimit ?? 2,
    taskTimeoutMs: 10_000,
    initialize: async () => options.restored ?? [],
    close: async () => {},
    start: async (): Promise<CallerTaskRuntime> => {
      starts++;
      active++;
      peak = Math.max(peak, active);
      let done = false;
      return {
        spawn: () => {
          throw new Error('unused');
        },
        cancel: async () => {},
        finish: async () => {
          await options.cleanup?.();
          if (!done) {
            finishes++;
            active--;
            done = true;
          }
        },
      };
    },
  };
  const backend = new CallerScopedBackend('agent', pool, () => {
    const instance = ++factories;
    return {
      name: 'test',
      handle:
        options.handle ??
        (async (task, emit) => {
          emit({
            type: 'task.status',
            taskId: task.taskId,
            status: { state: 'working' },
            metadata: { instance },
          });
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'completed' },
          });
        }),
    };
  });
  const run = async (
    assignment = task(),
    signal = new AbortController().signal,
  ) => {
    const frames: UpFrame[] = [];
    await backend.handle(assignment, (f) => frames.push(f), signal);
    return frames;
  };
  return {
    backend,
    run,
    stats: () => ({ starts, finishes, factories, active, peak }),
  };
}

test('rejects forged/missing scopes, legacy identity, delegation, and tool requests before allocation', async () => {
  const f = fixture();
  await f.backend.initialize();
  const invalid = [
    { ...task(), executionScope: undefined },
    { ...task(), executionId: undefined },
    { ...task(), caller: undefined },
    {
      ...task(),
      executionScope: {
        ...task().executionScope!,
        id: scopeDigest('agent', 'victim'),
      },
    },
    {
      ...task(),
      caller: { principal: { id: 'apikey:a' }, actor: { id: 'actor' } },
    },
    {
      ...task(),
      message: {
        ...task().message,
        parts: [{ kind: 'data' as const, data: { tools: [] } }],
      },
    },
  ];
  for (const assignment of invalid)
    assert.equal((await f.run(assignment))[0]?.type, 'task.fail');
  assert.equal(f.stats().starts, 0);
  await f.backend.close();
});

test('A/B/A with identical context IDs reuses only each caller backend', async () => {
  const f = fixture();
  await f.backend.initialize();
  const frames = await Promise.all(
    ['apikey:a', 'apikey:b', 'apikey:a'].map((id) => f.run(task(id))),
  );
  const instance = (fs: UpFrame[]) =>
    fs.find((x) => x.type === 'task.status')?.metadata?.instance;
  assert.equal(instance(frames[0]!), instance(frames[2]!));
  assert.notEqual(instance(frames[0]!), instance(frames[1]!));
  assert.equal(f.stats().factories, 2);
  assert.equal(f.stats().finishes, 3);
  await f.backend.close();
});

test('same-scope waiter cancellation does not release the active lease; completion waits for cleanup', async () => {
  const gate = deferred();
  const entered = deferred();
  const cleanup = deferred();
  let runs = 0;
  const f = fixture({
    cleanup: () => cleanup.promise,
    handle: async (task, emit) => {
      runs++;
      entered.resolve();
      await gate.promise;
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: { state: 'completed' },
      });
    },
  });
  await f.backend.initialize();
  const output: UpFrame[] = [];
  const first = f.backend.handle(
    task(),
    (f) => output.push(f),
    new AbortController().signal,
  );
  await entered.promise;
  const controller = new AbortController();
  const second = f.run(task(), controller.signal);
  const third = f.run();
  controller.abort();
  assert.equal((await second).at(-1)?.type, 'task.fail');
  assert.equal(f.stats().starts, 1);
  gate.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(output.length, 0);
  assert.equal(f.stats().starts, 1);
  cleanup.resolve();
  await Promise.all([first, third]);
  assert.equal(runs, 2);
  assert.equal(f.stats().peak, 1);
  await f.backend.close();
});

test('unconfirmed cleanup suppresses success and quarantines the scope', async () => {
  const f = fixture({
    cleanup: async () => {
      throw new Error('Docker unavailable');
    },
  });
  await f.backend.initialize();
  const output = await f.run();
  assert.equal(output.at(-1)?.type, 'task.fail');
  assert.equal(
    output.some((f) => f.type === 'task.complete'),
    false,
  );
  const again = await f.run();
  assert.equal(again[0]?.type, 'task.fail');
  assert.equal(f.stats().starts, 1);
  await f.backend.close();
});

test('active cancellation fences late output and discards the old backend binding', async () => {
  const late = deferred();
  const entered = deferred();
  let calls = 0;
  const f = fixture({
    handle: async (task, emit) => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await late.promise;
      }
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: { state: 'completed' },
      });
    },
  });
  await f.backend.initialize();
  const controller = new AbortController();
  const first = f.run(task(), controller.signal);
  await entered.promise;
  controller.abort();
  const frames = await first;
  assert.equal(frames.at(-1)?.type, 'task.fail');
  assert.equal((await f.run()).at(-1)?.type, 'task.complete');
  late.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    frames.some((f) => f.type === 'task.complete'),
    false,
  );
  assert.equal(f.stats().factories, 2);
  await f.backend.close();
});

test('restored workspace reports conversation reset and retained capacity is bounded', async () => {
  const f = fixture({
    restored: [scopeDigest('agent', 'apikey:a')],
    maxScopes: 1,
  });
  await f.backend.initialize();
  const output = await f.run();
  assert.deepEqual(
    output.find((f) => f.type === 'task.status')?.metadata?.['vicoop.runtime'],
    { workspaceRestored: true, conversationReset: true },
  );
  assert.equal((await f.run(task('apikey:b')))[0]?.type, 'task.fail');
  assert.equal(f.stats().starts, 1);
  await f.backend.close();
});

test('cancellation after checkpoint commit reports retained state instead of rollback', async () => {
  const controller = new AbortController();
  let committed = false;
  const pool: CallerRuntimePool = {
    maxScopes: 1,
    queueLimit: 1,
    taskTimeoutMs: 10_000,
    initialize: async () => [],
    close: async () => {},
    start: async () => ({
      get committed() {
        return committed;
      },
      spawn: () => {
        throw new Error('unused');
      },
      cancel: async () => {},
      finish: async (commit) => {
        if (commit) {
          committed = true;
          controller.abort();
        }
      },
    }),
  };
  const backend = new CallerScopedBackend('agent', pool, () => ({
    name: 'test',
    handle: async (t, emit) => {
      emit({
        type: 'task.complete',
        taskId: t.taskId,
        status: { state: 'completed' },
      });
    },
  }));
  await backend.initialize();
  const frames: UpFrame[] = [];
  await backend.handle(task(), (f) => frames.push(f), controller.signal);
  const last = frames.at(-1);
  assert.equal(last?.type, 'task.fail');
  if (last?.type === 'task.fail')
    assert.match(
      last.error.message ?? '',
      /after checkpoint commit; saved state is retained/,
    );
  assert.equal(committed, true);
  await backend.close();
});
