import type { UpFrame, TaskAssignFrame } from '@vicoop-bridge/protocol';

export type TaskAssign = TaskAssignFrame;

export type Emit = (frame: UpFrame) => void;

export interface DetectedCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
}

export interface Backend {
  name: string;
  // `signal` is aborted when the task is canceled (A2A `tasks/cancel` or
  // client shutdown). Backends observe it to propagate cancellation to their
  // upstream (abort RPC, kill subprocess, cancel fetch, etc.) and to settle
  // `handle()` promptly instead of waiting for an upstream terminal event
  // that may never arrive.
  handle(task: TaskAssign, emit: Emit, signal: AbortSignal): Promise<void>;
  // Optional capability probe. Called once at startup, before the bridge-server
  // hello frame is sent, so the backend can override advertised card
  // capabilities based on the actual state of its upstream (e.g. gateway
  // version support). Returning `{}` — or throwing — leaves the card's
  // declared capabilities unchanged.
  resolveCapabilities?(): Promise<DetectedCapabilities>;
  // Optional process-wide cleanup invoked from `Client.stop()` before the
  // daemon exits. Per-task cancellation already flows through `signal` in
  // `handle()`, but long-lived upstream resources held across tasks (e.g.
  // codex's `app-server` subprocess) would otherwise leak as orphaned
  // children when the daemon receives SIGINT/SIGTERM. Must be synchronous
  // and best-effort — callers do not await it before `process.exit`, so
  // implementations should send a kill signal / close a socket and return
  // immediately rather than wait for graceful shutdown.
  stop?(): void;
}
