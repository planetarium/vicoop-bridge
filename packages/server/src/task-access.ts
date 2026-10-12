import { AsyncLocalStorage } from 'node:async_hooks';

// Null-owned legacy rows are not evidence that a task was intentionally public.
export const PUBLIC_TASK_PROFILE = 'vicoop:public-task:v1';

export interface TaskListAccess {
  agentId: string;
  principalId?: string;
}

// Cached SDK handlers are shared by concurrent callers. Never put the current
// caller on the handler/store itself; bind listing to the authenticated request.
export const taskListAccess = new AsyncLocalStorage<TaskListAccess>();
