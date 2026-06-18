import {
  OPENAI_COMPAT_EXTENSION_URI,
  type TaskStatusFrame,
} from '@vicoop-bridge/protocol';
import type { Emit } from '../backend.js';

// Shared liveness-heartbeat cadence for every backend's task loop.
//
// A backend that is alive but byte-silent (long reasoning, tool runs) must
// stay observably alive to the consuming gateway/router so it is not
// false-failed-over (planetarium/a2x-internal-router#95). While a task is
// in-flight and no other frame has gone out for `HEARTBEAT_INTERVAL_MS`, we
// emit a non-terminal `working` `task.status` tagged with the openai-compat/v1
// heartbeat marker. The server maps that frame's `metadata` onto the A2A
// `TaskStatusUpdateEvent.metadata` (top-level), where the oai2a2a codec reads
// `event.metadata[<URI>].heartbeat === true` and emits a `: a2a-heartbeat` SSE
// comment that re-arms the router's first-content / stall watchdog.
//
// 10s is chosen to sit comfortably below (≤ half) the router's eventual
// tightened 25–30s watchdog window, per the extension spec's "at most half the
// watchdog window" rule. The previous per-backend 30s idle beat was too slow
// for that window — this folds those beats into one tagged, faster beat.
export const HEARTBEAT_INTERVAL_MS = 10_000;

// Build the tagged liveness-heartbeat frame. A heartbeat is a NON-terminal
// `working` status with NO message parts and the marker on the frame's
// top-level `metadata`. It MUST NOT carry answer text, tool_calls, usage, or a
// chat_completion envelope — those travel on the terminal message only.
export function buildHeartbeatStatusFrame(taskId: string): TaskStatusFrame {
  return {
    type: 'task.status',
    taskId,
    status: { state: 'working', timestamp: new Date().toISOString() },
    metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true } },
  };
}

export interface LivenessHeartbeatOptions {
  taskId: string;
  // The backend's wrapped `emit`. MUST be the wrapper that refreshes the
  // backend's silence-window timestamp, so a heartbeat frame resets the window
  // exactly like real traffic and a follow-up tick at the same instant skips.
  emit: Emit;
  // Monotonic-enough clock; injectable for tests.
  now: () => number;
  // Timestamp of the last outbound frame (real traffic OR a prior heartbeat).
  // Read fresh on every tick so each delta resets the silence window.
  lastActivityAt: () => number;
  // True once a terminal frame (complete/fail/cancel) has been emitted — the
  // loop has ended and the heartbeat must stop.
  isSettled: () => boolean;
  // True once cancellation has been requested. A canceled task is heading to a
  // `canceled` terminal frame; emitting more `working` heartbeats in that
  // window would misrepresent its status.
  isAborted: () => boolean;
  // Injectable timer primitives (tests drive the scheduled fn manually).
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  intervalMs?: number;
}

export interface LivenessHeartbeat {
  stop(): void;
}

// Start the shared liveness heartbeat for an in-flight task. Returns a handle
// whose `stop()` clears the timer; callers MUST call it on every exit path
// (terminal frame, abort, error) — typically from a `finally {}`.
//
// Passing `intervalMs <= 0` disables the heartbeat entirely (used by tests and
// callers that opt out); `stop()` is then a no-op.
export function startLivenessHeartbeat(
  opts: LivenessHeartbeatOptions,
): LivenessHeartbeat {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  if (intervalMs <= 0) {
    return { stop: () => {} };
  }

  const setIntervalImpl =
    opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    opts.clearIntervalFn ??
    ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const handle = setIntervalImpl(() => {
    if (opts.isSettled()) return;
    if (opts.isAborted()) return;
    if (opts.now() - opts.lastActivityAt() < intervalMs) return;
    // Route through the wrapped `emit` so emitting the heartbeat refreshes the
    // silence window (a follow-up tick at the same instant then skips).
    opts.emit(buildHeartbeatStatusFrame(opts.taskId));
  }, intervalMs);

  return {
    stop: () => clearIntervalImpl(handle),
  };
}
