import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CallerScopedBackend,
  type CallerWorker,
} from './caller-scoped-backend.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import type { CallerRuntimeLifecycle } from './caller-runtime-store.js';
import { setImmediate as flush } from 'node:timers/promises';
import { CallerEnvironmentPendingError, CallerAllocationIncompleteError, CallerOrphanedResourcesError, CallerStorageMissingError, CallerStorageLimitError, type DockerCallerRuntimePool } from './caller-runtime-docker.js';
import type { Backend } from './backend.js';
import { formatFederatedPrincipal, TRACEABILITY_EXTENSION_URI, type TaskAssignFrame, type UpFrame } from '@vicoop-bridge/protocol';

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
  const workerInstances: CallerWorker[] = [];
  const lifecycle: Array<{ id: string; update: CallerRuntimeLifecycle }> = [];
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
    recordLifecycle: async (id: string, update: CallerRuntimeLifecycle) => { lifecycle.push({ id, update }); },
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
    workerInstances.push(worker);
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
    workerInstances,
    lifecycle,
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

test('canceled waiters retain queue slots until the active predecessor settles', async () => {
  let finish!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const f = fixture(async (request, emit) => {
    if (request.taskId === 'active') { enter(); await gate; }
    emit({ type: 'task.complete', taskId: request.taskId, status: { state: 'completed', timestamp: '' } });
  }, { maxScopes: 1, queueLimit: 1 });
  const active = f.run(task('alice', 'active', 'active'));
  await ready;
  const controller = new AbortController();
  const canceled = f.run(task('alice', 'queued', 'queued'), controller.signal);
  controller.abort();
  assert.match(JSON.stringify(await canceled), /runtime_canceled/);
  for (let i = 0; i < 100; i++) {
    const attempt = new AbortController();
    const work = f.run(task('alice', `attempt-${i}`, `attempt-${i}`), attempt.signal);
    attempt.abort();
    assert.match(JSON.stringify(await work), /runtime_capacity/);
  }
  assert.equal(f.contexts.length, 1);
  assert.equal(f.stops.length, 0);
  finish();
  await active;
  assert.equal((await f.run(task('alice', 'after', 'after'))).at(-1)?.type, 'task.complete');
});

test('same-name running replacement rebuilds worker and resets the conversation', async () => {
  const f = fixture();
  const acquire = f.pool.acquire.bind(f.pool);
  let generation = 'original-container-id';
  f.pool.acquire = async (...args) => ({ ...await acquire(...args), dockerId: generation });
  await f.run();
  generation = 'replacement-container-id';
  const frames = await f.run();
  assert.equal(frames.at(-1)?.type, 'task.complete');
  assert.match(JSON.stringify(frames), /conversationReset/);
  assert.equal(f.workers.length, 2);
  assert.doesNotMatch(JSON.stringify(await f.run()), /conversationReset/);
  assert.equal(f.workers.length, 2);
});

test('incomplete allocation quarantines only its caller', async () => {
  const f = fixture();
  const acquire = f.pool.acquire.bind(f.pool);
  f.pool.acquire = async (...args) => {
    if (args[0] === scopeDigest('agent', 'alice')) { args[3]?.(); throw new CallerAllocationIncompleteError(); }
    return acquire(...args);
  };
  assert.match(JSON.stringify(await f.run()), /runtime_allocation_incomplete/);
  assert.match(JSON.stringify(await f.run()), /runtime_quarantined/);
  assert.equal((await f.run(task('bob'))).at(-1)?.type, 'task.complete');
});

test('unconfirmed storage helper cleanup quarantines caller even if workload stop succeeds', async () => {
  const { CallerStorageHelperUnconfirmedError } = await import('./caller-storage.js');
  const f = fixture();
  let acquisitions = 0;
  f.pool.acquire = async (_id, _signal, _principal, onReserved, onMutation) => {
    acquisitions++;
    onReserved?.(); onMutation?.();
    throw new CallerStorageHelperUnconfirmedError();
  };
  assert.match(JSON.stringify(await f.run()), /runtime_quarantined/);
  assert.match(JSON.stringify(await f.run()), /runtime_quarantined/);
  assert.equal(acquisitions, 1);
  assert.equal(f.stops.length, 1);
  await f.backend.close();
});


test('pending setup reports an actionable error without creating a worker or quarantining the scope', async () => {
  const f = fixture();
  const acquire = f.pool.acquire.bind(f.pool);
  f.pool.acquire = async () => { throw new CallerEnvironmentPendingError(); };
  assert.match(JSON.stringify(await f.run()), /runtime_setup_pending/);
  assert.equal(f.workers.length, 0);
  assert.equal(f.stops.length, 0);
  f.pool.acquire = acquire;
  assert.equal((await f.run()).at(-1)?.type, 'task.complete');
  await f.backend.close();
});

function federatedTask(issuer = 'did:web:connector.example', subject = 'slack:T/U', method = 'urn:mentionable:auth:slack:workspace:v0.1') {
  const key = formatFederatedPrincipal({ issuer, subject, method })!;
  const input = task(key);
  input.caller = { principal: { id: subject }, actor: { id: issuer } };
  input.executionScope!.policy = 'federated-principal-v1';
  return input;
}
test('federated A/B/A reuses a user environment, separates issuers and methods, and never uses the actor workspace', async () => {
  const f = fixture();
  try {
    for (const input of [federatedTask(), federatedTask(undefined, 'slack:T/B'), federatedTask(), federatedTask('did:web:other.example'), federatedTask(undefined, undefined, 'another-method')]) {
      assert.ok((await f.run(input)).some(frame => frame.type === 'task.complete'));
    }
    assert.equal(f.workers.length, 4);
    assert.equal(new Set(f.workers).size, 4);
    assert.ok(!f.workers.includes(scopeDigest('agent', 'did:web:connector.example')));
  } finally { await f.backend.close(); }
});
test('federated caller mismatch or policy downgrade rejects before allocation', async () => {
  const f = fixture();
  try {
    for (const modify of [
      (t: TaskAssignFrame) => { t.caller = { principal: { id: 'slack:T/other' }, actor: { id: 'did:web:connector.example' } }; },
      (t: TaskAssignFrame) => { t.caller = { principal: { id: 'slack:T/U' }, actor: { id: 'did:web:other.example' } }; },
      (t: TaskAssignFrame) => { t.caller = { principal: { id: 'slack:T/U' } }; },
      (t: TaskAssignFrame) => { t.executionScope!.policy = 'direct-principal-v1'; },
    ]) {
      const input = federatedTask(); modify(input);
      assert.match(JSON.stringify(await f.run(input)), /caller_scope_required/);
    }
    assert.equal(f.allocations.length, 0);
  } finally { await f.backend.close(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('idle timeout defaults to disabled, accepts zero and rejects unsafe timer values', () => {
  assert.equal(options.idleTimeoutMs, 0);
  assert.equal(CallerRuntimeConfig.parse({ ...options, idleTimeoutMs: 0 }).idleTimeoutMs, 0);
  for (const idleTimeoutMs of [-1, 0.5, Infinity, 2147483648])
    assert.throws(() => CallerRuntimeConfig.parse({ ...options, idleTimeoutMs }));
});

test('disabled idle reclamation retains the live worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.run();
  t.mock.timers.tick(2147483647);
  await flush();
  await f.run();
  assert.equal(f.stops.length, 0);
  assert.equal(f.workers.length, 1);
  await f.backend.close();
});

test('idle stop releases the worker, resets conversation routing and retains scope capacity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100, maxScopes: 1 });
  for (let cycle = 0; cycle < 3; cycle++) {
    const frames = await f.run(task('alice', 'same-context', `task-${cycle}`));
    assert.equal(frames.at(-1)?.type, 'task.complete');
    assert.equal(JSON.stringify(frames).includes('conversationReset'), cycle > 0);
    assert.equal(f.workers.length, cycle + 1);
    let closed = 0, stopped = 0;
    const worker = f.workerInstances[cycle];
    // The production broker becomes unhealthy when intentionally closed.
    worker.healthy = () => closed === 0;
    worker.close = () => { closed++; };
    worker.backend.stop = () => { stopped++; };
    t.mock.timers.tick(99);
    await flush();
    assert.equal(f.stops.length, cycle);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.stops.length, cycle + 1);
    assert.equal(closed, 1);
    assert.equal(stopped, 1);
    assert.equal(f.lifecycle.at(-1)?.update.lastIdleStop?.outcome, 'stopped');
    assert.match(JSON.stringify(await f.run(task('bob'))), /runtime_capacity/);
  }
  assert.equal(new Set(f.contexts).size, 1);
  assert.equal(f.lifecycle.filter(e => e.update.lastResume?.outcome === 'conversation-reset').length, 2);
  await f.backend.close();
});

test('active approval waits, queued work, file settling and storage checks never become idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const approval = deferred(), entered = deferred(), files = deferred(), storage = deferred();
  const seen: string[] = [];
  const f = fixture(async (task, emit) => {
    seen.push(task.taskId);
    if (task.taskId === 'approval') { entered.resolve(); await approval.promise; }
    emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'completed', timestamp: '' } });
  }, { idleTimeoutMs: 100 });
  const first = f.run(task('alice', 'a', 'approval'));
  await entered.promise;
  f.workerInstances[0].settle = () => files.promise;
  f.pool.checkStorage = () => storage.promise;
  const queued = f.run(task('alice', 'b', 'queued'));
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.stops.length, 0);
  assert.deepEqual(seen, ['approval']);
  approval.resolve();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.stops.length, 0);
  files.resolve();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.stops.length, 0);
  storage.resolve();
  await Promise.all([first, queued]);
  assert.deepEqual(seen, ['approval', 'queued']);
  t.mock.timers.tick(99);
  await flush();
  assert.equal(f.stops.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.stops.length, 1);
  await f.backend.close();
});

test('admission at the timer boundary invalidates a queued idle decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100 });
  await f.run();
  t.mock.timers.tick(100); // Callback installed its barrier; cleanup has not started.
  const frames = await f.run();
  assert.equal(frames.at(-1)?.type, 'task.complete');
  assert.equal(f.stops.length, 0);
  assert.equal(f.workers.length, 1);
  t.mock.timers.tick(100);
  await flush();
  assert.equal(f.stops.length, 1);
  await f.backend.close();
});

test('request arriving during idle stop waits for confirmation; canceled waiters cannot overtake it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100 });
  await f.run();
  const entered = deferred(), confirmed = deferred();
  const stop = f.pool.stop.bind(f.pool);
  f.pool.stop = async id => { entered.resolve(); await confirmed.promise; await stop(id); };
  t.mock.timers.tick(100);
  await entered.promise;
  const controller = new AbortController();
  const canceled = f.run(task('alice', 'b', 'canceled'), controller.signal);
  const next = f.run(task('alice', 'c', 'next'));
  controller.abort();
  assert.match(JSON.stringify(await canceled), /runtime_canceled/);
  await flush();
  assert.equal(f.workers.length, 1);
  assert.equal(f.lifecycle.length, 0);
  confirmed.resolve();
  const frames = await next;
  assert.match(JSON.stringify(frames), /conversationReset/);
  assert.equal(frames.at(-1)?.type, 'task.complete');
  assert.equal(f.workers.length, 2);
  assert.equal(f.stops.length, 1);
  await f.backend.close();
});

for (const failure of ['stop', 'settle', 'close'] as const) {
  test(`idle ${failure} failure quarantines that caller and still attempts container stop`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(undefined, { idleTimeoutMs: 100 });
    await f.run();
    if (failure === 'stop') f.failStop();
    if (failure === 'settle') f.workerInstances[0].settle = async () => { throw Error('unconfirmed'); };
    if (failure === 'close') f.workerInstances[0].close = () => { throw Error('unconfirmed'); };
    t.mock.timers.tick(100);
    await flush();
    assert.equal(f.stops.length, 1);
    assert.equal(f.lifecycle.at(-1)?.update.lastIdleStop?.outcome, 'quarantined');
    assert.match(JSON.stringify(await f.run()), /runtime_quarantined/);
    assert.equal((await f.run(task('bob'))).at(-1)?.type, 'task.complete');
    assert.equal(f.workers.length, 2);
    await f.backend.close();
  });
}

test('shutdown invalidates timer callbacks before releasing pool ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100 });
  await f.run();
  t.mock.timers.tick(100);
  await f.backend.close();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.stops.length, 0);
  assert.equal(f.lifecycle.length, 0);
});

test('shutdown waits for an idle stop already in progress before pool close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100 });
  await f.run();
  const entered = deferred(), confirmed = deferred();
  f.pool.stop = async () => { entered.resolve(); await confirmed.promise; };
  let poolClosed = false;
  f.pool.close = async () => { poolClosed = true; };
  t.mock.timers.tick(100);
  await entered.promise;
  const closing = f.backend.close();
  await flush();
  assert.equal(poolClosed, false);
  confirmed.resolve();
  await closing;
  assert.equal(poolClosed, true);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.lifecycle.length, 1);
});

test('failed reacquisition reports a failed resume without inventing conversation restoration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100 });
  await f.run();
  t.mock.timers.tick(100);
  await flush();
  f.pool.acquire = async () => { throw Error('boundary invalid'); };
  const frames = await f.run();
  assert.equal(frames.at(-1)?.type, 'task.fail');
  assert.doesNotMatch(JSON.stringify(frames), /conversationReset/);
  assert.equal(f.lifecycle.at(-1)?.update.lastResume?.outcome, 'failed');
  await f.backend.close();
});

test('idle cleanup timeout still stops the container and rejects a waiting request as quarantined', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(undefined, { idleTimeoutMs: 100 });
  await f.run();
  f.workerInstances[0].settle = () => new Promise(() => {});
  t.mock.timers.tick(100);
  await flush();
  const waiting = f.run();
  t.mock.timers.tick(14999);
  await flush();
  assert.equal(f.stops.length, 0);
  assert.equal(f.workers.length, 1);
  t.mock.timers.tick(1);
  assert.match(JSON.stringify(await waiting), /runtime_quarantined/);
  assert.equal(f.stops.length, 1);
  assert.equal(f.lifecycle.at(-1)?.update.lastIdleStop?.outcome, 'quarantined');
  await f.backend.close();
});
