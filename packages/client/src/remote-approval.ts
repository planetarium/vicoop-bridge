import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, DownFrame, TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

export type RequestApproval = (toolName: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<ApprovalDecision>;
const context = new AsyncLocalStorage<RequestApproval>();
// Backend adapters capture this within handle(), not in a process-global RPC callback.
export function currentApprovalRequester(): RequestApproval {
  return context.getStore() ?? (async () => 'deny');
}
export class RemoteApprovalBroker {
  private pending = new Map<string, { taskId: string; executionId: string; decide: (d: ApprovalDecision) => void }>();
  constructor(private timeoutMs = 10 * 60_000) {}
  resolve(frame: Extract<DownFrame, { type: 'approval.resolve' }>): void {
    const p = this.pending.get(frame.requestId);
    if (p?.taskId === frame.taskId && p.executionId === frame.executionId) p.decide(frame.decision);
  }
  async run<T>(task: TaskAssignFrame, signal: AbortSignal, enabled: boolean, emit: (f: UpFrame) => void, work: () => Promise<T>): Promise<T> {
    const lifecycle = new AbortController();
    const abort = () => lifecycle.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const request: RequestApproval = async (toolName, input, backendSignal) => {
      const executionId = task.executionId;
      if (!enabled || !executionId || lifecycle.signal.aborted || backendSignal?.aborted) return 'deny';
      // One pending approval per execution. Concurrent backend requests fail closed.
      if ([...this.pending.values()].some(p => p.executionId === executionId)) return 'deny';
      if (!toolName || toolName.length > 256) return 'deny';
      let frozen: Record<string, unknown>;
      try { frozen = JSON.parse(JSON.stringify(input)) as Record<string, unknown>; }
      catch { return 'deny'; }
      if (Buffer.byteLength(JSON.stringify(frozen)) > 64 * 1024) return 'deny';
      const request: ApprovalRequest = { requestId: randomUUID(), toolName, input: frozen,
        expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() };
      return new Promise<ApprovalDecision>(resolve => {
        let settled = false;
        const finish = (decision: ApprovalDecision) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          lifecycle.signal.removeEventListener('abort', deny);
          backendSignal?.removeEventListener('abort', deny);
          this.pending.delete(request.requestId);
          // Receipt is sequenced and replayed like the request. It acknowledges
          // consumption, not completion of the backend's eventual side effect.
          try { emit({ type: 'approval.received', taskId: task.taskId, executionId, requestId: request.requestId, decision }); }
          catch { decision = 'deny'; }
          resolve(decision);
        };
        const deny = () => finish('deny');
        const timer = setTimeout(deny, this.timeoutMs);
        timer.unref?.();
        this.pending.set(request.requestId, { taskId: task.taskId, executionId, decide: decision =>
          finish(Date.now() >= Date.parse(request.expiresAt) ? 'deny' : decision) });
        lifecycle.signal.addEventListener('abort', deny, { once: true });
        backendSignal?.addEventListener('abort', deny, { once: true });
        try { emit({ type: 'approval.request', taskId: task.taskId, executionId, request }); }
        catch { deny(); }
      });
    };
    try { return await context.run(request, work); }
    finally { lifecycle.abort(); signal.removeEventListener('abort', abort); }
  }
}
