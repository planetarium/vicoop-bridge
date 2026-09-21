import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CallerScopedBackend,
  type CallerWorker,
} from './caller-scoped-backend.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import { CallerOrphanedResourcesError, CallerStorageMissingError, CallerStorageLimitError, type DockerCallerRuntimePool } from './caller-runtime-docker.js';
import type { Backend } from './backend.js';
import { TRACEABILITY_EXTENSION_URI, type TaskAssignFrame, type UpFrame } from '@vicoop-bridge/protocol';

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
      onReserved?: () => void,
      onMutation?: () => void,
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
      onReserved?.();
      onMutation?.();
      return { id, name: id, recovered: false };
    },
    checkStorage: async () => {
      if (storageFails) throw new CallerStorageLimitError();
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
  assert.match(JSON.stringify(await f.run(task('alice', 'fresh'))), /conversationReset/);
  assert.doesNotMatch(JSON.stringify(await f.run(task('alice', 'fresh'))), /conversationReset/);
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

test('caller state paths must be absolute regardless of launch directory', () => {
  for (const stateDirectory of ['state', './state', '../state', '~/state'])
    assert.throws(() => CallerRuntimeConfig.parse({ ...options, stateDirectory }), /absolute path/);
});


test('factory initialization receives cancellation and stops the container before failure', async () => {
  const f = fixture();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const backend = new CallerScopedBackend('agent', f.pool, async (_container, signal) => {
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    throw Error('unreachable');
  });
  const controller = new AbortController();
  const frames: UpFrame[] = [];
  const work = backend.handle(task(), (frame) => frames.push(frame), controller.signal);
  await ready;
  controller.abort();
  await work;
  assert.match(JSON.stringify(frames), /runtime_canceled/);
  assert.deepEqual(f.stops, [scopeDigest('agent', 'alice')]);
  assert.equal(f.workers.length, 0);
});

test('periodic Docker storage-check failure is not reported as quota or caller cancellation', async () => {
  const f = fixture(async () => new Promise<void>(() => {}));
  f.pool.checkStorage = async () => { throw Error('Docker unavailable'); };
  const frames = await f.run();
  assert.match(JSON.stringify(frames), /runtime_failed/);
  assert.doesNotMatch(JSON.stringify(frames), /runtime_storage_limit|runtime_canceled/);
  assert.equal(f.stops.length, 1);
});


test('task deadline also aborts worker initialization before any backend work', async () => {
  const f = fixture(undefined, { taskTimeoutMs: 20 });
  const backend = new CallerScopedBackend('agent', f.pool, async (_container, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    throw Error('unreachable');
  });
  const frames: UpFrame[] = [];
  await backend.handle(task(), (frame) => frames.push(frame), new AbortController().signal);
  assert.match(JSON.stringify(frames), /runtime_canceled/);
  assert.equal(f.stops.length, 1);
  assert.equal(f.workers.length, 0);
});


test('missing retained storage quarantines only its caller without starting a worker', async () => {
  const f = fixture();
  const acquire = f.pool.acquire.bind(f.pool);
  f.pool.acquire = async (...args) => {
    if (args[0] === scopeDigest('agent', 'alice')) { args[3]?.(); throw new CallerStorageMissingError(); }
    return acquire(...args);
  };
  assert.match(JSON.stringify(await f.run()), /runtime_storage_missing/);
  assert.equal(f.workers.length, 0);
  assert.match(JSON.stringify(await f.run()), /runtime_quarantined/);
  assert.match(JSON.stringify(await f.run(task('bob'))), /completed/);
  await f.backend.close();
});


test('cancellation at acquire entry frees unreserved capacity, but post-reservation failure retains it', async () => {
  for (const reserved of [false, true]) {
    const f = fixture(undefined, { maxScopes: 1 });
    const acquire = f.pool.acquire.bind(f.pool);
    const controller = new AbortController();
    f.pool.acquire = async (...args) => {
      if (args[0] !== scopeDigest('agent', 'alice')) return acquire(...args);
      if (reserved) args[3]?.();
      controller.abort();
      args[1]!.throwIfAborted();
      throw new Error('unreachable');
    };
    assert.match(JSON.stringify(await f.run(task(), controller.signal)), /runtime_canceled/);
    assert.match(JSON.stringify(await f.run(task('bob'))), reserved ? /runtime_capacity/ : /task.complete/);
    await f.backend.close();
  }
});


test('cancellation during read-only acquisition preserves the existing worker and conversation', async () => {
  const f = fixture();
  await f.run();
  const acquire = f.pool.acquire.bind(f.pool);
  const controller = new AbortController();
  f.pool.acquire = async (...args) => {
    args[3]?.(); // Retained SQLite reservation, but no Docker mutations yet.
    controller.abort();
    args[1]!.throwIfAborted();
    throw new Error('unreachable');
  };
  assert.match(JSON.stringify(await f.run(task(), controller.signal)), /runtime_canceled/);
  assert.equal(f.stops.length, 0);
  f.pool.acquire = acquire;
  assert.equal((await f.run()).at(-1)?.type, 'task.complete');
  assert.equal(f.workers.length, 1);
  assert.equal(f.contexts[0], f.contexts[1]);
  await f.backend.close();
});

test('canceling an in-flight periodic storage check aborts it without reporting an infrastructure failure', async () => {
  const f = fixture(async () => new Promise<void>(() => {}));
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let checkSignal: AbortSignal | undefined;
  f.pool.checkStorage = async (_id, signal) => {
    checkSignal = signal;
    ready();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = f.run(task(), controller.signal);
  await started;
  controller.abort();
  const frames = JSON.stringify(await pending);
  assert.equal(checkSignal?.aborted, true);
  assert.match(frames, /runtime_canceled/);
  assert.doesNotMatch(frames, /runtime_failed|runtime_storage_limit/);
  await f.backend.close();
});


test('backend-specific MIME and size admission rejects inline files before consuming caller capacity', async () => {
  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  const atLimit = Buffer.alloc(5 * 1024 * 1024).toString('base64');
  for (const kind of ['claude', 'codex']) {
    for (const [mimeType, bytes] of [
      [kind === 'claude' ? 'text/plain' : 'application/pdf', 'aGVsbG8='],
      ['', 'aGVsbG8='], ['image/png', tooLarge],
    ]) {
      const f = fixture(undefined, { maxScopes: 1 });
      Object.assign(f.pool, { kind });
      const input = task();
      input.message.parts = [{ kind: 'file', file: { mimeType, bytes } }];
      assert.match(JSON.stringify(await f.run(input)), /caller_scope_required/);
      assert.equal(f.allocations.length, 0);
      assert.equal(f.workers.length, 0);
      assert.equal((await f.run(task('bob'))).at(-1)?.type, 'task.complete');
      await f.backend.close();
    }
    const f = fixture();
    Object.assign(f.pool, { kind });
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', ...(kind === 'claude' ? ['application/pdf'] : [])]) {
      const input = task();
      input.message.parts = [{ kind: 'file', file: { mimeType, bytes: atLimit } }];
      assert.equal((await f.run(input)).at(-1)?.type, 'task.complete');
    }
    await f.backend.close();
  }
});


test('orphan resources quarantine their caller without stopping or adopting Docker resources', async () => {
  const f = fixture();
  f.pool.acquire = async () => { throw new CallerOrphanedResourcesError(); };
  assert.match(JSON.stringify(await f.run()), /runtime_orphaned_resources/);
  assert.match(JSON.stringify(await f.run()), /runtime_quarantined/);
  assert.equal(f.workers.length, 0);
  assert.equal(f.stops.length, 0);
  await f.backend.close();
});


test('externally stopped or removed retained containers get a fresh worker and explicit reset without affecting another caller', async () => {
  for (const recovery of ['restarted', 'recreated']) {
    const f = fixture();
    await f.run(task());
    await f.run(task('bob'));
    const acquire = f.pool.acquire.bind(f.pool);
    let restart = true;
    f.pool.acquire = async (...args) => {
      const container = await acquire(...args);
      const restarted = restart && args[0] === scopeDigest('agent', 'alice');
      if (restarted) restart = false;
      return { ...container, [recovery]: restarted };
    };
    const frames = await f.run();
    assert.equal(frames.at(-1)?.type, 'task.complete');
    assert.match(JSON.stringify(frames), /conversationReset/);
    assert.equal(f.workers.length, 3);
    assert.doesNotMatch(JSON.stringify(await f.run(task('bob'))), /conversationReset/);
    assert.equal(f.workers.length, 3);
    await f.backend.close();
  }
});

test('traceability requested through either negotiation surface is rejected before allocation', async () => {
  for (const surface of ['request', 'message']) {
    const f = fixture();
    const request = task();
    if (surface === 'request') request.requestedExtensions = [TRACEABILITY_EXTENSION_URI];
    else request.message.extensions = [TRACEABILITY_EXTENSION_URI];
    const frames = await f.run(request);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.type, 'task.fail');
    assert.equal(f.allocations.length, 0);
    assert.equal(f.workers.length, 0);
  }
});
