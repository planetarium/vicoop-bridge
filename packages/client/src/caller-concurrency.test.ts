import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerScopedBackend, type CallerWorker } from './caller-scoped-backend.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import type { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function task(taskId: string, contextId = taskId, principalId = 'alice'): TaskAssignFrame {
  return { type: 'task.assign', taskId, contextId, executionId: `exec-${taskId}`,
    executionScope: { policy: 'direct-principal-v1', agentId: 'agent', principalId, id: scopeDigest('agent', principalId) },
    caller: { version: 2, principal: { id: principalId }, attestations: [] },
    message: { role: 'user', messageId: taskId, parts: [{ kind: 'text', text: taskId }] } } as TaskAssignFrame;
}
function fixture(kind: 'claude' | 'codex', overrides = {}) {
  const started: string[] = [], stopped: string[] = [], closed: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  const cleanup = new Map<string, ReturnType<typeof gate>>();
  const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/fixture',
    fixedImageStorage: { image: `sha256:${'b'.repeat(64)}`, poolVolume: 'pool', capacityMiB: 4096, reserveMiB: 64, reservationBoundary: 'docker-filesystem' },
    concurrency: { perCaller: 2, global: 2 }, ...overrides });
  const pool = { kind, options, initialize: async () => [], close: async () => {},
    acquireContext: async (id: string, context: string, _signal: AbortSignal, _principal: string, retained: () => void) => {
      retained(); return { id, context, name: context, recovered: false };
    },
    stopContext: async (_id: string, context: string) => { stopped.push(context); },
  } as unknown as DockerCallerRuntimePool;
  const backend = new CallerScopedBackend('agent', pool, async container => {
    let current: string | undefined;
    const worker: CallerWorker = { backend: { name: kind, async handle(t, emit) {
      current = t.taskId;
      started.push(t.taskId);
      await gates.get(t.taskId)?.promise;
      emit({ type: 'task.complete', taskId: t.taskId, status: { state: 'completed', timestamp: '' } });
    } }, close: () => { closed.push(container.context!); }, healthy: () => true,
    settle: async () => { if (current) await cleanup.get(current)?.promise; } };
    return worker;
  });
  const run = (t: TaskAssignFrame, signal = new AbortController().signal) => {
    const frames: UpFrame[] = [];
    return { frames, done: backend.handle(t, frame => frames.push(frame), signal) };
  };
  const hold = (id: string) => { const g = gate(); gates.set(id, g); return g; };
  return { backend, pool, started, stopped, closed, cleanup, run, hold };
}
for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: independent contexts overlap, same-context ordering and cleanup own the lease`, async () => {
    const f = fixture(kind);
    const a = f.hold('A1'), b = f.hold('B1'), cleanup = gate();
    f.cleanup.set('A1', cleanup);
    const a1 = f.run(task('A1', 'A')), a2 = f.run(task('A2', 'A')), b1 = f.run(task('B1', 'B'));
    await tick();
    assert.deepEqual(f.started, ['A1', 'B1']);
    a.resolve();
    await tick();
    assert.deepEqual(f.started, ['A1', 'B1']);
    assert.equal(a1.frames.some(frame => frame.type === 'task.complete'), false);
    cleanup.resolve();
    await a1.done;
    await a2.done;
    assert.deepEqual(f.started, ['A1', 'B1', 'A2']);
    b.resolve(); await b1.done;
    assert.equal(f.closed.length, 0);
    await f.backend.close();
  });
  test(`${kind}: canceling a running context leaves its sibling running and suppresses late frames`, async () => {
    const f = fixture(kind), controller = new AbortController();
    const a = f.hold('A'), b = f.hold('B');
    const a1 = f.run(task('A'), controller.signal), b1 = f.run(task('B'));
    await tick();
    controller.abort(); await a1.done;
    assert.equal(f.closed.length, 1);
    assert.equal(f.stopped.length, 1);
    assert.equal(b1.frames.some(frame => frame.type === 'task.fail'), false);
    b.resolve(); await b1.done;
    a.resolve(); await tick();
    assert.equal(a1.frames.filter(frame => frame.type === 'task.complete').length, 0);
    assert.equal(b1.frames.at(-1)?.type, 'task.complete');
    await f.backend.close();
  });
  test(`${kind}: queue timeout does not run or cancel either active context`, async () => {
    const f = fixture(kind);
    // Shorten only the test clock after schema validation.
    f.pool.options.concurrency!.queueTimeoutMs = 10;
    const a = f.hold('A'), b = f.hold('B');
    const runs = [f.run(task('A')), f.run(task('B'))];
    const queued = f.run(task('C'));
    await queued.done;
    assert.equal((queued.frames.at(-1) as any).error.code, 'runtime_queue_timeout');
    assert.deepEqual(f.started, ['A', 'B']);
    assert.equal(f.stopped.length, 0);
    a.resolve(); b.resolve(); await Promise.all(runs.map(run => run.done));
    await f.backend.close();
  });
}

test('concurrency requires enforced storage and sizes file replay retention by global slots', () => {
  const config = { image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/fixture', concurrency: {} };
  assert.throws(() => CallerRuntimeConfig.parse(config), /requires fixedImageStorage/);
  const f = fixture('claude', { maxScopes: 32, concurrency: { global: 2 }, fileDelivery: { allowedRoots: ['/workspace/output'] } });
  assert.equal(f.pool.options.concurrency!.global, 2);
});

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: unconfirmed cleanup quarantines the context and keeps its global slot charged`, async () => {
    const f = fixture(kind), a = f.hold('A'), b = f.hold('B');
    let first: string | undefined;
    f.pool.stopContext = async (_id, context) => {
      first ??= context;
      if (context === first) throw Error('Docker unavailable');
      f.stopped.push(context);
    };
    const runs = [f.run(task('A')), f.run(task('B'))];
    await tick();
    a.resolve(); await runs[0].done;
    assert.equal((runs[0].frames.at(-1) as any).error.code, 'runtime_quarantined');
    const same = f.run(task('retry', 'A')); await same.done;
    assert.equal((same.frames.at(-1) as any).error.code, 'runtime_quarantined');
    const controller = new AbortController();
    const queued = f.run(task('C'), controller.signal);
    await tick();
    assert.deepEqual(f.started, ['A', 'B']);
    b.resolve(); await runs[1].done;
    await queued.done;
    assert.deepEqual(f.started, ['A', 'B', 'C']);
    assert.equal(runs[1].frames.at(-1)?.type, 'task.complete');
    await f.backend.close();
  });
}

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: an execution timeout resets only that context`, async () => {
    const f = fixture(kind);
    f.pool.options.taskTimeoutMs = 15;
    const held = f.hold('A');
    const a = f.run(task('A')), b = f.run(task('B'));
    await b.done;
    assert.equal(b.frames.at(-1)?.type, 'task.complete');
    await a.done;
    assert.equal((a.frames.at(-1) as any).error.code, 'runtime_timeout');
    assert.equal(f.closed.length, 1);
    held.resolve(); await tick();
    const next = f.run(task('next', 'B')); await next.done;
    assert.equal(next.frames.at(-1)?.type, 'task.complete');
    await f.backend.close();
  });
}

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: legacy idle timeout cannot reclaim running, queued or settling context work`, async () => {
    const f = fixture(kind, { idleTimeoutMs: 1 });
    const a = f.hold('A'), b = f.hold('B'), cleanup = gate();
    f.cleanup.set('A', cleanup);
    const runs = [f.run(task('A')), f.run(task('B')), f.run(task('C'))];
    await tick();
    a.resolve();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(f.started, ['A', 'B']);
    assert.equal(f.stopped.length, 0);
    assert.equal(f.closed.length, 0);
    cleanup.resolve();
    await runs[0].done;
    await runs[2].done;
    assert.deepEqual(f.started, ['A', 'B', 'C']);
    assert.equal(f.closed.length, 0);
    b.resolve(); await runs[1].done;
    await f.backend.close();
  });
}
