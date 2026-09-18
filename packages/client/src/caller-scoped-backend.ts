import {
  ExecutionScopeV1,
  OPENAI_COMPAT_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import type {
  DockerCallerRuntimePool,
  CallerContainer,
} from './caller-runtime-docker.js';
import { scopeDigest } from './caller-runtime-store.js';
import { createHash } from 'node:crypto';
export interface CallerWorker {
  backend: Backend;
  settle(): Promise<void>;
  close(): void;
  healthy(): boolean;
}
interface Entry {
  tail: Promise<void>;
  worker?: CallerWorker;
  contexts: Set<string>;
  recovered: boolean;
  quarantined: boolean;
}
export class CallerScopedBackend implements Backend {
  readonly requiresCallerScope = true;
  readonly name: string;
  private entries = new Map<string, Entry>();
  private active = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private pending = 0;
  private stopped = false;
  constructor(
    private agentId: string,
    readonly pool: DockerCallerRuntimePool,
    private factory: (container: CallerContainer) => Promise<CallerWorker>,
  ) {
    this.name = pool.kind;
  }
  async initialize(): Promise<void> {
    for (const id of await this.pool.initialize())
      this.entries.set(id, this.entry(true));
  }
  private entry(recovered = false): Entry {
    return {
      tail: Promise.resolve(),
      contexts: new Set(),
      recovered,
      quarantined: false,
    };
  }
  async resolveCapabilities() {
    return { streaming: true };
  }
  handle(
    task: TaskAssignFrame,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    const work = this.execute(task, emit, signal);
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => {});
    return work;
  }
  private validate(task: TaskAssignFrame): string {
    const scope = ExecutionScopeV1.parse(task.executionScope),
      caller = task.caller;
    if (
      !task.executionId ||
      !caller ||
      !('principal' in caller) ||
      caller.actor ||
      caller.principal?.id !== scope.principalId ||
      scope.agentId !== this.agentId ||
      scope.id !== scopeDigest(this.agentId, scope.principalId)
    )
      throw new Error(
        'scope does not match directly authenticated caller, agent and execution',
      );
    if (
      (task.requestedExtensions ?? []).includes(OPENAI_COMPAT_EXTENSION_URI) ||
      (task.message.extensions ?? []).includes(OPENAI_COMPAT_EXTENSION_URI) ||
      task.message.metadata?.[OPENAI_COMPAT_EXTENSION_URI] !== undefined ||
      task.message.parts.some(
        (p) => p.kind === 'data' || (p.kind === 'file' && !p.file.bytes),
      )
    )
      throw new Error(
        'container requires plain A2A text or inline files; caller tools and URI inputs are unsupported',
      );
    return scope.id;
  }
  private fail(
    task: TaskAssignFrame,
    emit: Emit,
    code: string,
    message: string,
  ) {
    emit({ type: 'task.fail', taskId: task.taskId, error: { code, message } });
  }
  private async execute(
    task: TaskAssignFrame,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    let id: string;
    try {
      id = this.validate(task);
    } catch {
      this.fail(
        task,
        emit,
        'caller_scope_required',
        'Invalid scope or unsupported container request',
      );
      return;
    }
    if (this.stopped || signal.aborted) {
      this.fail(task, emit, 'runtime_stopped', 'Caller runtime stopped');
      return;
    }
    const opts = this.pool.options;
    if (this.pending >= opts.maxScopes + opts.queueLimit) {
      this.fail(task, emit, 'runtime_capacity', 'Caller queue full');
      return;
    }
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= opts.maxScopes) {
        this.fail(
          task,
          emit,
          'runtime_capacity',
          'Retained caller capacity reached',
        );
        return;
      }
      entry = this.entry();
      this.entries.set(id, entry);
    }
    if (entry.quarantined) {
      this.fail(
        task,
        emit,
        'runtime_quarantined',
        'Caller runtime requires offline recovery',
      );
      return;
    }
    // Scope+context is never a filesystem path or a caller-controlled backend identifier.
    const context = createHash('sha256')
      .update(JSON.stringify([id, task.contextId]))
      .digest('hex');
    const controller = new AbortController();
    this.controllers.add(controller);
    this.pending++;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, opts.taskTimeoutMs);
    const previous = entry.tail;
    let release!: () => void;
    const lease = new Promise<void>((r) => {
      release = r;
    });
    entry.tail = previous.then(() => lease);
    let acquired = false,
      forwarding = true;
    let phase = 'queue';
    let monitor: NodeJS.Timeout | undefined;
    let storageCheck: Promise<void> | undefined;
    let storageFailure = false;
    const heartbeat = setInterval(() => {
      if (!controller.signal.aborted)
        emit({
          type: 'task.status',
          taskId: task.taskId,
          status: { state: 'working', timestamp: new Date().toISOString() },
        });
    }, 5000);
    try {
      await abortable(previous, controller.signal);
      if (this.stopped || entry.quarantined)
        throw new Error('scope unavailable');
      if (
        !entry.contexts.has(context) &&
        entry.contexts.size >= opts.maxContexts
      ) {
        this.fail(
          task,
          emit,
          'runtime_capacity',
          'Caller conversation capacity reached',
        );
        return;
      }
      acquired = true;
      phase = 'allocation';
      const container = await this.pool.acquire(
        id,
        controller.signal,
        task.executionScope!.principalId,
      );
      controller.signal.throwIfAborted();
      phase = 'backend-initialization';
      if (!entry.worker) entry.worker = await this.factory(container);
      controller.signal.throwIfAborted();
      if (entry.recovered && !entry.contexts.has(context))
        emit({
          type: 'task.status',
          taskId: task.taskId,
          status: { state: 'working', timestamp: new Date().toISOString() },
          metadata: {
            'vicoop.runtime': {
              workspaceRestored: true,
              conversationReset: true,
            },
          },
        });
      entry.contexts.add(context);
      let terminal: UpFrame | undefined;
      monitor = setInterval(() => {
        if (storageCheck) return;
        storageCheck = this.pool
          .checkStorage(id)
          .catch(() => {
            storageFailure = true;
            abort();
          })
          .finally(() => {
            storageCheck = undefined;
          });
      }, 1000);
      phase = 'execution';
      const worker = entry.worker;
      const work = worker.backend.handle(
        { ...task, contextId: context },
        (frame) => {
          if (!forwarding || controller.signal.aborted) return;
          if (frame.type === 'task.complete' || frame.type === 'task.fail')
            terminal = frame;
          else emit(frame);
        },
        controller.signal,
      );
      // handle() may ignore cancellation; execution cleanup remains the authority.
      void work.catch(() => {});
      await abortable(work, controller.signal);
      forwarding = false;
      phase = 'cleanup';
      await within(worker.settle(), 15000);
      if (!worker.healthy()) throw new Error('execution cleanup uncertain');
      clearInterval(monitor);
      await storageCheck;
      await this.pool.checkStorage(id);
      controller.signal.throwIfAborted();
      if (!terminal) throw new Error('backend missing terminal');
      emit(terminal);
    } catch (error) {
      clearInterval(monitor);
      if (
        error instanceof Error &&
        error.message === 'caller storage limit exceeded'
      )
        storageFailure = true;
      console.error(
        'Caller runtime failure phase:',
        phase,
        error instanceof Error ? error.name : 'unknown',
      );
      forwarding = false;
      if (acquired) {
        entry.worker?.backend.stop?.();
        entry.worker?.close();
        try {
          await within(entry.worker?.settle() ?? Promise.resolve(), 15000);
        } catch {
          /* Independent container stop remains mandatory. */
        }
        try {
          // Confirm the entire affected container is stopped before emitting a
          // terminal failure, even when backend/supervisor cleanup is uncertain.
          await storageCheck;
          await this.pool.stop(id);
        } catch {
          entry.quarantined = true;
        }
        entry.worker = undefined;
        entry.contexts.clear();
        entry.recovered = true;
      }
      this.fail(
        task,
        emit,
        entry.quarantined
          ? 'runtime_quarantined'
          : storageFailure
            ? 'runtime_storage_limit'
            : controller.signal.aborted
              ? 'runtime_canceled'
              : 'runtime_failed',
        entry.quarantined
          ? 'Caller cleanup could not be confirmed; scope quarantined'
          : acquired
            ? 'Caller execution ended; persistent files, including partial writes, are retained. Conversation will reset after recovery.'
            : 'Queued caller request canceled or rejected; running work and existing conversations are unchanged.',
      );
    } finally {
      forwarding = false;
      clearInterval(monitor);
      clearInterval(heartbeat);
      clearTimeout(timer);
      await storageCheck;
      // A canceled waiter must retain the predecessor's barrier until it settles.
      release();
      signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
      this.pending--;
    }
  }
  stop() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.active]);
    for (const entry of this.entries.values()) {
      entry.worker?.backend.stop?.();
      entry.worker?.close();
    }
    await this.pool.close();
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('execution aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('execution cleanup timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
