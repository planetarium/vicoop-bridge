import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncEventQueue } from './event-queue.js';

const macrotaskGap = () => new Promise<void>((r) => setTimeout(r, 1));

test('iterate yields pushed values FIFO and ends on end()', async () => {
  const q = new AsyncEventQueue<number>();
  const seen: number[] = [];
  const consumer = (async () => {
    for await (const v of q.iterate()) seen.push(v);
  })();
  q.push(1);
  q.push(2);
  q.push(3);
  q.end();
  await consumer;
  assert.deepEqual(seen, [1, 2, 3]);
});

test('iterate does not leak an abort listener per buffered frame (regression)', async () => {
  // Each blocking read attaches an `abort` listener to the signal; the
  // normal (push/close) resolution path must remove it. `{ once: true }`
  // only self-removes when abort actually fires, so before the cleanup
  // fix a task streaming N frames accumulated N+1 listeners on its
  // (task-lived) signal — the source of the "11 abort listeners added to
  // [AbortSignal]" MaxListenersExceededWarning and a listener storm that
  // fired synchronously on eventual abort.
  const ac = new AbortController();
  let net = 0;
  let peak = 0;
  const realAdd = ac.signal.addEventListener.bind(ac.signal);
  const realRemove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'abort') {
      net += 1;
      peak = Math.max(peak, net);
    }
    return (realAdd as (...a: unknown[]) => void)(type, ...rest);
  }) as typeof ac.signal.addEventListener;
  ac.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'abort') net -= 1;
    return (realRemove as (...a: unknown[]) => void)(type, ...rest);
  }) as typeof ac.signal.removeEventListener;

  const q = new AsyncEventQueue<number>();
  const seen: number[] = [];
  const consumer = (async () => {
    for await (const v of q.iterate(ac.signal)) seen.push(v);
  })();

  // Real macrotask gaps so the consumer fully parks (and attaches a
  // listener) between frames, faithfully mirroring WebSocket-driven
  // frames arriving milliseconds apart.
  for (let i = 0; i < 50; i += 1) {
    await macrotaskGap();
    q.push(i);
  }
  await macrotaskGap();
  q.end();
  await consumer;

  assert.equal(seen.length, 50, 'all frames consumed');
  assert.ok(peak <= 1, `at most one concurrent abort listener (saw peak=${peak})`);
  assert.equal(net, 0, 'no abort listeners left attached after drain');
});

test('iterate stops promptly when the signal aborts', async () => {
  const ac = new AbortController();
  const q = new AsyncEventQueue<number>();
  const seen: number[] = [];
  const consumer = (async () => {
    for await (const v of q.iterate(ac.signal)) seen.push(v);
  })();
  await macrotaskGap();
  q.push(1);
  await macrotaskGap();
  ac.abort();
  await consumer;
  assert.deepEqual(seen, [1]);
});
