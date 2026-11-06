import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerExecutionScheduler, CallerQueueFullError } from './caller-execution-scheduler.js';
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('same-context waiters do not occupy the second slot; context FIFO survives queued cancellation', async () => {
  const scheduler = new CallerExecutionScheduler({ perCaller: 2, global: 2, queuePerCaller: 4, queueLimit: 4 });
  const a1 = await scheduler.acquire('alice', 'A', signal());
  const cancel = new AbortController();
  const a2 = scheduler.acquire('alice', 'A', cancel.signal);
  let a3Started = false;
  const a3 = scheduler.acquire('alice', 'A', signal()).then(release => { a3Started = true; return release; });
  const b1 = await scheduler.acquire('alice', 'B', signal());
  cancel.abort();
  await assert.rejects(a2, /aborted/);
  await tick();
  assert.equal(a3Started, false);
  b1();
  await tick();
  assert.equal(a3Started, false);
  a1();
  (await a3)();
});

test('global and per-caller queue bounds are independent; a canceled waiter frees queue capacity', async () => {
  const scheduler = new CallerExecutionScheduler({ perCaller: 1, global: 1, queuePerCaller: 1, queueLimit: 2 });
  const release = await scheduler.acquire('alice', 'A', signal());
  const controller = new AbortController();
  const a = scheduler.acquire('alice', 'B', controller.signal);
  await assert.rejects(scheduler.acquire('alice', 'C', signal()), CallerQueueFullError);
  const b = scheduler.acquire('bob', 'A', signal());
  await assert.rejects(scheduler.acquire('carol', 'A', signal()), CallerQueueFullError);
  controller.abort();
  await assert.rejects(a);
  const c = scheduler.acquire('carol', 'A', signal());
  release();
  (await b)();
  (await c)();
});

test('backlogged callers rotate fairly instead of draining one caller first', async () => {
  const scheduler = new CallerExecutionScheduler({ perCaller: 2, global: 1, queuePerCaller: 4, queueLimit: 8 });
  const release = await scheduler.acquire('initial', 'A', signal());
  const order: string[] = [];
  const request = (scope: string, context: string) => scheduler.acquire(scope, context, signal()).then(done => {
    order.push(scope + context); done();
  });
  const all = [request('alice', '1'), request('alice', '2'), request('bob', '1'), request('bob', '2')];
  release();
  await Promise.all(all);
  assert.deepEqual(order, ['alice1', 'bob1', 'alice2', 'bob2']);
});
