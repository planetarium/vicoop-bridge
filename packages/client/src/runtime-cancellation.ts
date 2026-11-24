import { diagnosticTaskId } from './logger.js';

// Keep the native AbortError seen by backends. Only host-owned labels can enter
// diagnostics, even when a caller supplies an arbitrary AbortSignal.reason.
type CancelSource = 'task_cancel_frame' | 'bridge_disconnect' | 'client_stop' |
  'delivery_failure' | 'reassigned' | 'runtime_stop' | 'storage_check' |
  'task_deadline' | 'queue_deadline' | 'upstream_signal';
const sources = new WeakMap<AbortSignal, CancelSource>();

export function cancelRuntime(controller: AbortController, source: CancelSource): void {
  if (controller.signal.aborted) return;
  sources.set(controller.signal, source);
  controller.abort();
}

export function cancellationSource(signal: AbortSignal): CancelSource {
  return sources.get(signal) ?? 'upstream_signal';
}

export function observeCancellation(signal: AbortSignal, taskId: string, state: () => { phase: string; deadlineMs: number }): void {
  const startedAt = performance.now();
  signal.addEventListener('abort', () => {
    const { phase, deadlineMs } = state();
    console.error('Caller runtime cancellation:', JSON.stringify({
      taskId: diagnosticTaskId(taskId), source: cancellationSource(signal), phase,
      deadlineMs, elapsedMs: Math.round(performance.now() - startedAt),
    }));
  }, { once: true });
}
