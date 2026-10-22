import { AsyncLocalStorage } from 'node:async_hooks';
import { APPROVAL_EXTENSION_URI } from '@vicoop-bridge/protocol';
import type { Artifact } from '@a2x/sdk';

// Server-written dispatch marker (docs/tool-approval-v1.md): the public
// Task.metadata entry keyed by the approval extension URI carries the
// executionId of the latest dispatch for that task ID. A client that lost its
// stream recovers an approval's original result through tasks/get by matching
// the approval's executionId against this marker; a reused task ID gets a new
// marker on every dispatch. The marker has no authorization meaning.
//
// The task store owns the value: caller-supplied entries are discarded and
// only markExecution() changes it.
export const EXECUTION_MARKER_KEY = APPROVAL_EXTENSION_URI;

export function executionMarker(metadata: Record<string, unknown> | undefined): string | undefined {
  const entry = metadata?.[EXECUTION_MARKER_KEY];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const id = (entry as Record<string, unknown>).executionId;
  return typeof id === 'string' ? id : undefined;
}

// Replace whatever the metadata carries under the marker key with the given
// executionId (or remove it), preserving every other key.
export function withExecutionMarker(
  metadata: Record<string, unknown> | undefined,
  executionId: string | undefined,
): Record<string, unknown> | undefined {
  const { [EXECUTION_MARKER_KEY]: _previous, ...rest } = metadata ?? {};
  void _previous;
  if (executionId !== undefined) return { ...rest, [EXECUTION_MARKER_KEY]: { executionId } };
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// Request-scoped dispatch state. Each agent A2A request runs inside its own
// holder (http.tsx). Requests without a holder (admin, maintenance) and
// non-message requests (tasks/cancel, tasks/get) are not guarded.
//
// For a message request the task store enforces, per write:
// - before/without its own dispatch (`marked` false) it may not write a task
//   row that has ever been dispatched: pre-dispatch rejections, payment halts
//   and marker-persistence failures must not relabel another execution's
//   state. A fresh, never-dispatched task is still writable.
// - after markExecution (`marked` true) it may write only while its
//   `dispatchId` is still the row's latest dispatch, so a superseded
//   execution (replay-capable or not) cannot overwrite the newer one.
// - its writes persist `artifacts` — the executor's own per-execution
//   accumulation — instead of whatever the SDK merged from earlier turns.
// A skipped write returns the request's own view of the update without
// persisting it, so a superseded caller still sees its own outcome.
export interface ExecutionWriter {
  message?: boolean;
  marked?: boolean;
  dispatchId?: string;
  executionId?: string;
  artifacts?: Artifact[];
}
export const executionWriter = new AsyncLocalStorage<ExecutionWriter>();

export function markMessageRequest(): void {
  const writer = executionWriter.getStore();
  if (writer) writer.message = true;
}

export interface ExecutionMarkingStore {
  // Atomically record a new dispatch for `taskId`: replace the public marker
  // (or clear it when `executionId` is undefined), reset status to working and
  // drop prior artifacts (history is kept), and bind the current request's
  // writes to it with `artifacts` as the execution's output snapshot.
  markExecution(taskId: string, executionId: string | undefined, artifacts: Artifact[]): Promise<void>;
}

export function supportsExecutionMarking(store: unknown): store is ExecutionMarkingStore {
  return typeof (store as Partial<ExecutionMarkingStore> | null)?.markExecution === 'function';
}
