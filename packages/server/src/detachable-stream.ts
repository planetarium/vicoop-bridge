import { AsyncLocalStorage } from 'node:async_hooks';
import { logEvent } from './log.js';

// SSE body for a `message/stream` response whose lifetime is owned by the
// bridge rather than by the HTTP connection.
//
// Both the SDK's createSSEStream and a plain `for await` over the handler's
// generator end the execution when the client goes away: cancel/abort calls
// `return()` on the generator, whose `finally` unbinds the task and
// invalidates any pending tool approval — even though the approval (ten-minute
// deadline) can still be decided, and the result recovered through tasks/get.
// A connector that times out (e.g. a 300s serverless limit) must not cancel
// the native execution.
//
// While attached, events are pulled as the downstream reads them (one event
// buffered ahead, which also starts the execution without waiting for the
// first read), so the response respects backpressure and stays bounded. On cancel the stream detaches:
// the upstream generator is never returned; the remaining events are drained
// and discarded, which keeps the SDK and executor persisting state and output
// until the native terminal, approval expiry or inactivity watchdog ends it.
// Every upstream step runs in the request's async context (the
// execution-writer and task-access scopes), whichever code reads the body.
export function detachableSseStream(
  events: AsyncIterator<unknown>,
  opts: { label: Record<string, unknown>; errorEvent?: (err: unknown) => unknown },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const inRequestContext = AsyncLocalStorage.snapshot();
  const next = () => inRequestContext(() => events.next());
  let inflight: Promise<unknown> = Promise.resolve();
  let done = false;

  async function drain(): Promise<void> {
    try {
      await inflight;
      while (!done) {
        if ((await next()).done) done = true;
      }
      logEvent('stream_detached_drained', opts.label);
    } catch (err) {
      done = true;
      logEvent('stream_detached_error', { ...opts.label, error: String(err) });
    }
  }

  let detached = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const step = next();
      inflight = step.catch(() => undefined);
      let result: IteratorResult<unknown>;
      try {
        result = await step;
      } catch (err) {
        done = true;
        logEvent('stream_error', { ...opts.label, error: String(err) });
        if (detached) return;
        if (opts.errorEvent) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(opts.errorEvent(err))}\n\n`));
        }
        controller.close();
        return;
      }
      if (result.done) done = true;
      // Cancelled while this step was in flight: the drain continues from here.
      if (detached) return;
      if (result.done) controller.close();
      else controller.enqueue(encoder.encode(`data: ${JSON.stringify(result.value)}\n\n`));
    },
    cancel() {
      detached = true;
      if (done) return;
      logEvent('stream_detached', opts.label);
      void drain();
    },
  }, { highWaterMark: 1 });
}
