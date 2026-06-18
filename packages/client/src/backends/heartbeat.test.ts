import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_COMPAT_EXTENSION_URI, type UpFrame } from '@vicoop-bridge/protocol';
import {
  HEARTBEAT_INTERVAL_MS,
  buildHeartbeatStatusFrame,
  startLivenessHeartbeat,
} from './heartbeat.js';

// Shared fixture: a wrapped emit that mirrors the backends' silence-window
// machinery — every emitted frame refreshes `lastEmitAt`, exactly what makes a
// heartbeat tick reset the window and a follow-up same-instant tick skip.
function harness() {
  const frames: UpFrame[] = [];
  let nowMs = 1_000_000;
  let lastEmitAt = nowMs;
  let settled = false;
  let aborted = false;
  let scheduledFn: () => void = () => {};
  let cleared = false;

  const emit = (frame: UpFrame): void => {
    lastEmitAt = nowMs;
    frames.push(frame);
  };

  const hb = startLivenessHeartbeat({
    taskId: 'task-1',
    emit,
    now: () => nowMs,
    lastActivityAt: () => lastEmitAt,
    isSettled: () => settled,
    isAborted: () => aborted,
    setIntervalFn: (fn) => {
      scheduledFn = fn;
      return { tag: 'fake' };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    intervalMs: 100,
  });

  return {
    frames,
    hb,
    tick: () => scheduledFn(),
    advance: (ms: number) => {
      nowMs += ms;
    },
    realTraffic: () => emit({ type: 'pong' }),
    settle: () => {
      settled = true;
    },
    abort: () => {
      aborted = true;
    },
    isCleared: () => cleared,
    countStatus: () => frames.filter((f) => f.type === 'task.status').length,
  };
}

test('buildHeartbeatStatusFrame: non-terminal working tagged with the heartbeat marker and no parts', () => {
  const frame = buildHeartbeatStatusFrame('t-9');
  assert.equal(frame.type, 'task.status');
  assert.equal(frame.taskId, 't-9');
  assert.equal(frame.status.state, 'working');
  assert.equal(frame.status.message, undefined);
  assert.deepEqual(frame.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true },
  });
});

test('HEARTBEAT_INTERVAL_MS is 10s (<= half the router 25-30s watchdog)', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 10_000);
});

test('heartbeat emits a tagged working on the interval after silence', () => {
  const h = harness();
  assert.equal(h.countStatus(), 0);

  // Tick with no elapsed time → silence < interval → skip.
  h.tick();
  assert.equal(h.countStatus(), 0);

  // Advance past the interval → one tagged heartbeat.
  h.advance(150);
  h.tick();
  assert.equal(h.countStatus(), 1);
  const hbFrame = h.frames.find((f) => f.type === 'task.status');
  assert.ok(hbFrame && hbFrame.type === 'task.status');
  assert.deepEqual(hbFrame.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true },
  });
  assert.equal(hbFrame.status.state, 'working');

  // A follow-up tick at the same instant must NOT double-fire — the prior
  // heartbeat refreshed the silence window through the wrapped emit.
  h.tick();
  assert.equal(h.countStatus(), 1);
});

test('heartbeat silence window resets on every backend delta', () => {
  const h = harness();
  // Real traffic arrives, then time advances less than a full interval after
  // it: no heartbeat, because the delta reset the window.
  h.advance(80);
  h.realTraffic();
  h.advance(80);
  h.tick();
  assert.equal(h.countStatus(), 0, 'delta within the interval suppresses the beat');

  // Now go quiet past the interval → the beat fires.
  h.advance(150);
  h.tick();
  assert.equal(h.countStatus(), 1);
});

test('heartbeat stops at terminal state and clears its timer', () => {
  const h = harness();
  h.advance(150);
  h.tick();
  assert.equal(h.countStatus(), 1);

  h.settle();
  h.hb.stop();
  assert.ok(h.isCleared(), 'timer must be cleared on stop()');

  // A stale tick after settle must not add more heartbeats.
  h.advance(150);
  h.tick();
  assert.equal(h.countStatus(), 1, 'no heartbeat after terminal state');
});

test('heartbeat is suppressed after abort (canceled task must not look like working)', () => {
  const h = harness();
  h.abort();
  h.advance(150);
  h.tick();
  assert.equal(h.countStatus(), 0, 'aborted task emits no working heartbeat');
});

test('startLivenessHeartbeat with intervalMs <= 0 is a disabled no-op', () => {
  let scheduled = false;
  const hb = startLivenessHeartbeat({
    taskId: 't',
    emit: () => {},
    now: () => 0,
    lastActivityAt: () => 0,
    isSettled: () => false,
    isAborted: () => false,
    setIntervalFn: () => {
      scheduled = true;
      return null;
    },
    clearIntervalFn: () => {},
    intervalMs: 0,
  });
  assert.equal(scheduled, false, 'disabled heartbeat must not schedule a timer');
  // stop() must be safe to call.
  hb.stop();
});
