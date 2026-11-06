/** Bounded round-robin admission across callers, FIFO within each context.
 * An ineligible same-context waiter never consumes an execution slot.
 * Leases include allocation, approval waits, file delivery and confirmed cleanup.
 */
export class CallerExecutionScheduler {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly busy = new Map<string, Set<string>>();
  private running = 0;
  private queued = 0;
  constructor(private readonly limits: { perCaller: number; global: number; queuePerCaller: number; queueLimit: number }) {}

  acquire(scope: string, context: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('execution aborted'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { context, resolve, reject, signal, abort: () => {
        if (!this.remove(scope, waiter)) return;
        reject(new Error('execution aborted'));
        this.drain();
      } };
      const queue = this.queues.get(scope) ?? [];
      queue.push(waiter);
      this.queues.set(scope, queue);
      this.queued++;
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.drain();
      if ((this.queues.get(scope)?.includes(waiter)) &&
          (this.queued > this.limits.queueLimit || this.queues.get(scope)!.length > this.limits.queuePerCaller)) {
        this.remove(scope, waiter);
        reject(new CallerQueueFullError());
      }
    });
  }
  private remove(scope: string, waiter: Waiter): boolean {
    const queue = this.queues.get(scope);
    const index = queue?.indexOf(waiter) ?? -1;
    if (index < 0) return false;
    queue!.splice(index, 1);
    if (!queue!.length) this.queues.delete(scope);
    this.queued--;
    waiter.signal.removeEventListener('abort', waiter.abort);
    return true;
  }
  private drain() {
    while (this.running < this.limits.global) {
      let admitted = false;
      for (const [scope, queue] of this.queues) {
        const busy = this.busy.get(scope) ?? new Set<string>();
        if (busy.size >= this.limits.perCaller) continue;
        const waiter = queue.find(item => !busy.has(item.context));
        if (!waiter) continue;
        this.remove(scope, waiter);
        // Rotate caller priority after each admission, preserving its context FIFO.
        if (queue.length) { this.queues.delete(scope); this.queues.set(scope, queue); }
        busy.add(waiter.context);
        this.busy.set(scope, busy);
        this.running++;
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          busy.delete(waiter.context);
          if (!busy.size) this.busy.delete(scope);
          this.running--;
          this.drain();
        });
        admitted = true;
        break;
      }
      if (!admitted) break;
    }
  }
}
interface Waiter {
  context: string;
  signal: AbortSignal;
  abort(): void;
  resolve(release: () => void): void;
  reject(error: Error): void;
}
export class CallerQueueFullError extends Error {
  constructor() { super('Caller execution queue full'); }
}
