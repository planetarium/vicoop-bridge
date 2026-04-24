import type { UpFrame, TaskAssignFrame } from '@vicoop-bridge/protocol';

export type TaskAssign = TaskAssignFrame;

export type Emit = (frame: UpFrame) => void;

export interface Backend {
  name: string;
  // `signal` is aborted when the task is canceled (A2A `tasks/cancel` or
  // client shutdown). Backends observe it to propagate cancellation to their
  // upstream (abort RPC, kill subprocess, cancel fetch, etc.) and to settle
  // `handle()` promptly instead of waiting for an upstream terminal event
  // that may never arrive.
  handle(task: TaskAssign, emit: Emit, signal: AbortSignal): Promise<void>;
}
