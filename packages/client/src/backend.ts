import type { UpFrame, TaskAssignFrame } from '@vicoop-bridge/protocol';

export type TaskAssign = TaskAssignFrame;

export type Emit = (frame: UpFrame) => void;

export interface Backend {
  name: string;
  handle(task: TaskAssign, emit: Emit): Promise<void>;
  cancel(taskId: string): Promise<void>;
}
