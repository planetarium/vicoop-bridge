/**
 * Single-consumer async queue used to bridge WebSocket-frame-driven
 * task progress into the AsyncGenerator that A2A streaming expects.
 *
 * `push()` enqueues a value; the iterator yields enqueued values FIFO
 * and blocks when the buffer is empty. `end()` closes the iterator;
 * pending iterations resolve with `done: true`. `fail()` causes the
 * iterator to throw on its next read.
 */
export class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: ((result: IteratorResult<T> | { error: unknown }) => void) | null = null;
  private closed = false;
  private failure: { error: unknown } | null = null;

  push(item: T): void {
    if (this.closed || this.failure) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
      return;
    }
    this.buffer.push(item);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure) return;
    this.failure = { error };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ error });
    }
  }

  async *iterate(signal?: AbortSignal): AsyncGenerator<T> {
    while (true) {
      if (signal?.aborted) return;
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.failure) throw this.failure.error;
      if (this.closed) return;
      // Cleared once the awaited promise settles so the per-iteration
      // abort listener is removed on the normal (push/close) path too —
      // `{ once: true }` only self-removes when abort actually fires, so
      // without this every buffered event would leave a dangling listener
      // on the (task-lived) signal, leaking closures and accumulating a
      // listener storm that all fires synchronously on eventual abort.
      let cleanupAbort: (() => void) | undefined;
      const result = await new Promise<IteratorResult<T> | { error: unknown }>((resolve) => {
        this.waiter = resolve;
        if (signal) {
          const onAbort = () => {
            if (this.waiter === resolve) {
              this.waiter = null;
              resolve({ value: undefined as never, done: true });
            }
          };
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener('abort', onAbort, { once: true });
            cleanupAbort = () => signal.removeEventListener('abort', onAbort);
          }
        }
      });
      cleanupAbort?.();
      if ('error' in result) throw result.error;
      if (result.done) return;
      yield result.value;
    }
  }
}
