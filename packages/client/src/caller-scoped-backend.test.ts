import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CallerScopedBackend,
  type CallerWorker,
} from './caller-scoped-backend.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import type { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import type { Backend } from './backend.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

const options = CallerRuntimeConfig.parse({
  image: `sha256:${'a'.repeat(64)}`,
  stateDirectory: '/fixture',
});
function task(
  principal = 'alice',
  contextId = 'shared',
  taskId = 'task',
): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId,
    contextId,
    executionId: `exec-${taskId}`,
    caller: { version: 2, principal: { id: principal }, attestations: [] },
    executionScope: {
      policy: 'direct-principal-v1',
      agentId: 'agent',
      principalId: principal,
      id: scopeDigest('agent', principal),
    },
    message: {
      messageId: 'm',
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
    },
  } as TaskAssignFrame;
}
function fixture(handle?: Backend['handle'], opts = {}) {
  const allocations: string[] = [],
    stops: string[] = [],
    workers: string[] = [],
    contexts: string[] = [];
  const existing = new Set<string>();
  let storageFails = false,
    stopFails = false;
  const pool = {
    kind: 'claude',
    options: { ...options, ...opts },
    initialize: async () => [],
    acquire: async (
      id: string,
      _signal?: AbortSignal,
      principalId?: string,
    ) => {
      assert.ok(
        principalId,
        'validated identity must reach storage allocation',
      );
      assert.equal(scopeDigest('agent', principalId), id);
      if (!existing.has(id)) {
        allocations.push(id);
        existing.add(id);
      }
      return { id, name: id, recovered: false };
    },
    checkStorage: async () => {
      if (storageFails) throw Error('full');
    },
    stop: async (id: string) => {
      stops.push(id);
      if (stopFails) throw Error('Docker unavailable');
      existing.delete(id);
    },
    close: async () => {},
  } as unknown as DockerCallerRuntimePool;
  const backend = new CallerScopedBackend('agent', pool, async (c) => {
    workers.push(c.id);
    const worker: CallerWorker = {
      backend: {
        name: 'fixture',
        handle: async (t, e, s) => {
          contexts.push(t.contextId);
          if (handle) await handle(t, e, s);
          else
            e({
              type: 'task.complete',
              taskId: t.taskId,
              status: {
                state: 'completed',
                timestamp: new Date().toISOString(),
              },
            });
        },
      },
      healthy: () => true,
      settle: async () => {},
      close: () => {},
    };
    return worker;
  });
  const run = async (t = task(), signal = new AbortController().signal) => {
    const frames: UpFrame[] = [];
    await backend.handle(t, (f) => frames.push(f), signal);
    return frames;
  };
  return {
    backend,
    run,
    pool,
    allocations,
    stops,
    workers,
    contexts,
    failStorage: () => {
      storageFails = true;
    },
    failStop: () => {
      stopFails = true;
    },
  };
}

test('A/B/A reuses one container per principal including new context; identical contexts remain scoped', async () => {
  const f = fixture();
  await f.backend.initialize();
  for (const t of [task(), task('bob'), task(), task('alice', 'new')])
    assert.equal((await f.run(t)).at(-1)?.type, 'task.complete');
  assert.equal(f.allocations.length, 2);
  assert.equal(f.workers.length, 2);
  assert.equal(f.stops.length, 0);
  assert.equal(f.contexts[0], f.contexts[2]);
  assert.notEqual(f.contexts[0], f.contexts[1]);
  assert.notEqual(f.contexts[0], f.contexts[3]);
  await f.backend.close();
});
test('rejects forged/missing scope, generation, actor, data and URI inputs before allocation', async () => {
  const cases = [
    { executionScope: undefined },
    { executionId: undefined },
    { executionScope: { ...task().executionScope, id: 'b'.repeat(64) } },
    { caller: { ...task().caller, actor: { id: 'delegated' } } },
    { caller: { version: 2, principal: { id: 'mallory' } } },
    { message: { ...task().message, parts: [{ kind: 'data', data: {} }] } },
    {
      message: {
        ...task().message,
        parts: [{ kind: 'file', file: { uri: 'http://localhost/secret' } }],
      },
    },
    { requestedExtensions: ['https://vicoop.ai/extensions/openai-compat/v1'] },
  ];
  // Use the actual extension constant for the last case.
  const { OPENAI_COMPAT_EXTENSION_URI } = await import(
    '@vicoop-bridge/protocol'
  );
  cases.at(-1)!.requestedExtensions = [OPENAI_COMPAT_EXTENSION_URI];
  for (const changes of cases) {
    const f = fixture();
    const frames = await f.run({ ...task(), ...changes } as TaskAssignFrame);
    assert.equal(frames.at(-1)?.type, 'task.fail');
    assert.equal(f.allocations.length, 0);
  }
});
test('concurrent same-scope requests deduplicate allocation and serialize execution', async () => {
  let running = 0,
    max = 0;
  const f = fixture(async (t, e) => {
    running++;
    max = Math.max(max, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    e({
      type: 'task.complete',
      taskId: t.taskId,
      status: { state: 'completed', timestamp: '' },
    });
  });
  await Promise.all([f.run(task()), f.run(task('alice', 'new', 'two'))]);
  assert.equal(max, 1);
  assert.equal(f.allocations.length, 1);
});
test('canceling a waiter does not release active lease or interrupt another caller', async () => {
  let finish!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (finish = r));
  const observed: string[] = [];
  const f = fixture(async (t, e) => {
    observed.push(t.taskId);
    if (t.taskId === 'first') {
      entered();
      await gate;
    }
    e({
      type: 'task.complete',
      taskId: t.taskId,
      status: { state: 'completed', timestamp: '' },
    });
  });
  const first = f.run(task('alice', 'a', 'first'));
  await ready;
  const canceled = new AbortController();
  const second = f.run(task('alice', 'b', 'second'), canceled.signal);
  canceled.abort();
  await second;
  const third = f.run(task('alice', 'c', 'third'));
  await f.run(task('bob', 'a', 'bob'));
  assert.deepEqual(observed, ['first', 'bob']);
  assert.equal(f.stops.length, 0);
  finish();
  await Promise.all([first, third]);
  assert.deepEqual(observed, ['first', 'bob', 'third']);
});
test('active cancellation stops only that scope before terminal delivery and reports retained files', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const f = fixture(async (t, e, s) => {
    if (t.taskId === 'cancel') {
      entered();
      await new Promise<void>((r) =>
        s.addEventListener('abort', () => r(), { once: true }),
      );
    } else
      e({
        type: 'task.complete',
        taskId: t.taskId,
        status: { state: 'completed', timestamp: '' },
      });
  });
  const controller = new AbortController(),
    work = f.run(task('alice', 'a', 'cancel'), controller.signal);
  await ready;
  await f.run(task('bob'));
  controller.abort();
  const frames = await work;
  assert.deepEqual(f.stops, [scopeDigest('agent', 'alice')]);
  assert.equal(frames.at(-1)?.type, 'task.fail');
  assert.match(JSON.stringify(frames), /partial writes/);
  const next = await f.run(task('alice'));
  assert.match(JSON.stringify(next), /conversationReset/);
});
test('failed cleanup quarantines only the affected scope', async () => {
  const f = fixture(async (t, e) => {
    if (t.taskId === 'fail') throw Error('backend failure');
    e({
      type: 'task.complete',
      taskId: t.taskId,
      status: { state: 'completed', timestamp: '' },
    });
  });
  f.failStop();
  await f.run(task('alice', 'a', 'fail'));
  assert.match(JSON.stringify(await f.run(task())), /runtime_quarantined/);
  assert.equal((await f.run(task('bob'))).at(-1)?.type, 'task.complete');
});
test('retained scope and context limits reject without clearing existing conversations', async () => {
  const f = fixture(undefined, { maxScopes: 1, maxContexts: 1 });
  await f.run();
  assert.match(JSON.stringify(await f.run(task('bob'))), /runtime_capacity/);
  assert.match(
    JSON.stringify(await f.run(task('alice', 'new'))),
    /runtime_capacity/,
  );
  await f.run();
  assert.equal(f.workers.length, 1);
  assert.equal(f.stops.length, 0);
});
test('storage failure prevents successful completion and stops the affected container', async () => {
  const f = fixture();
  f.failStorage();
  const frames = await f.run();
  assert.equal(frames.at(-1)?.type, 'task.fail');
  assert.equal(f.stops.length, 1);
});
test('configuration rejects mutable images, unknown options and unbounded limits', () => {
  for (const change of [
    { image: 'latest' },
    { maxScopes: 0 },
    { storageMiB: Infinity },
    { pids: 100000 },
    { credential: 'secret' },
  ])
    assert.throws(() => CallerRuntimeConfig.parse({ ...options, ...change }));
});


test('canceling before allocation releases capacity for another principal', async () => {
  const f = fixture(undefined, { maxScopes: 1 });
  const controller = new AbortController();
  const work = f.run(task(), controller.signal);
  controller.abort();
  assert.match(JSON.stringify(await work), /runtime_canceled/);
  assert.equal(f.allocations.length, 0);
  assert.equal((await f.run(task('bob'))).at(-1)?.type, 'task.complete');
});

test('canceling a first request preserves the same-scope successor barrier and slot', async () => {
  const f = fixture(undefined, { maxScopes: 1 });
  const controller = new AbortController();
  const first = f.run(task(), controller.signal);
  const successor = f.run(task('alice', 'next'));
  controller.abort();
  await first;
  assert.match(JSON.stringify(await f.run(task('bob'))), /runtime_capacity/);
  assert.equal((await successor).at(-1)?.type, 'task.complete');
  assert.equal(f.allocations.length, 1);
});
