import {
  ExecutionScopeV1,
  OPENAI_COMPAT_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import type { ClaudeSpawnFn } from './backends/claude.js';
import { scopeDigest } from './caller-runtime-store.js';
import type {
  CallerRuntimePool,
  CallerTaskRuntime,
} from './caller-runtime-docker.js';

interface ScopeEntry {
  backend?: Backend;
  binding?: { runtime?: CallerTaskRuntime };
  tail: Promise<void>;
  quarantined: boolean;
  restored: boolean;
  checkpointed: boolean;
  contexts: Set<string>;
}

/** One execution per scope, including allocation and confirmed cleanup. */
export class CallerScopedBackend implements Backend {
  readonly name = 'caller-claude';
  readonly requiresCallerScope = true;
  private readonly entries = new Map<string, ScopeEntry>();
  private readonly controllers = new Set<AbortController>();
  private readonly active = new Set<Promise<void>>();
  private pending = 0;
  private stopped = false;
  constructor(
    private readonly agentId: string,
    private readonly pool: CallerRuntimePool,
    private readonly factory: (spawn: ClaudeSpawnFn) => Backend,
  ) {}
  async initialize(): Promise<void> {
    for (const id of await this.pool.initialize())
      this.entries.set(id, this.entry(true));
  }
  private entry(restored: boolean): ScopeEntry {
    return {
      tail: Promise.resolve(),
      quarantined: false,
      restored,
      checkpointed: restored,
      contexts: new Set(),
    };
  }
  handle(
    task: TaskAssignFrame,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    const promise = this.execute(task, emit, signal);
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }
  private async execute(
    task: TaskAssignFrame,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    let scopeId: string;
    try {
      scopeId = this.validate(task);
    } catch (error) {
      this.fail(task, emit, 'caller_scope_required', (error as Error).message);
      return;
    }
    if (this.stopped || signal.aborted) {
      this.fail(
        task,
        emit,
        'runtime_stopped',
        'execution was canceled or runtime is stopping',
      );
      return;
    }
    if (this.pending >= this.pool.maxScopes + this.pool.queueLimit) {
      this.fail(
        task,
        emit,
        'runtime_capacity',
        'caller execution queue is full',
      );
      return;
    }
    let entry = this.entries.get(scopeId);
    if (!entry) {
      if (this.entries.size >= this.pool.maxScopes) {
        this.fail(
          task,
          emit,
          'runtime_capacity',
          'retained caller scope capacity reached',
        );
        return;
      }
      entry = this.entry(false);
      this.entries.set(scopeId, entry);
    }
    if (entry.quarantined) {
      this.fail(
        task,
        emit,
        'runtime_quarantined',
        'previous runtime cleanup is unconfirmed; restart and reconcile before reuse',
      );
      return;
    }
    if (!entry.contexts.has(task.contextId) && entry.contexts.size >= 256) {
      this.fail(
        task,
        emit,
        'runtime_capacity',
        'caller conversation capacity reached (256)',
      );
      return;
    }
    this.pending++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const forwardAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    // Deadline includes queue wait, allocation, and execution. Cleanup uses
    // independent bounded calls so cancellation cannot skip the safety barrier.
    const timer = setTimeout(
      () => controller.abort(new Error('caller task deadline exceeded')),
      this.pool.taskTimeoutMs,
    );
    const waiting = entry.tail;
    let release!: () => void;
    const lease = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.tail = waiting.then(() => lease);
    const heartbeat = setInterval(() => {
      if (!signal.aborted)
        emit({
          type: 'task.status',
          taskId: task.taskId,
          status: { state: 'working', timestamp: new Date().toISOString() },
        });
    }, 5000);
    let acquired = false;
    let allocationAttempted = false;
    let runtime: CallerTaskRuntime | undefined;
    let terminal: UpFrame | undefined;
    let backendOpen = false;
    try {
      await abortable(waiting, controller.signal);
      acquired = true;
      if (entry.quarantined || this.stopped)
        throw new Error('caller runtime is quarantined or stopping');
      if (!entry.contexts.has(task.contextId) && entry.contexts.size >= 256)
        throw new Error('caller conversation capacity reached');
      allocationAttempted = true;
      runtime = await this.pool.start(scopeId, controller.signal);
      if (!entry.backend) {
        const selected = { runtime } as { runtime?: CallerTaskRuntime };
        entry.binding = selected;
        entry.backend = this.factory((command, args, options) => {
          if (!selected.runtime)
            throw new Error('no active caller execution lease');
          return selected.runtime.spawn(command, args, options);
        });
      }
      entry.binding!.runtime = runtime;
      if (entry.restored && !entry.contexts.has(task.contextId))
        emit({
          type: 'task.status',
          taskId: task.taskId,
          status: { state: 'working', timestamp: new Date().toISOString() },
          metadata: {
            'vicoop.runtime': {
              workspaceRestored: entry.checkpointed,
              conversationReset: true,
            },
          },
        });
      entry.contexts.add(task.contextId);
      backendOpen = true;
      const work = entry.backend.handle(
        task,
        (frame) => {
          if (!backendOpen || controller.signal.aborted) return;
          if (frame.type === 'task.complete' || frame.type === 'task.fail')
            terminal = frame;
          else emit(frame);
        },
        controller.signal,
      );
      await abortable(work, controller.signal);
      backendOpen = false;
      // Terminal success is held until state is committed and all processes
      // are removed; failure here cannot publish a misleading completed task.
      const commit =
        terminal?.type === 'task.complete' &&
        terminal.status.state === 'completed';
      await runtime.finish(commit);
      entry.checkpointed ||= runtime.committed ?? commit;
      controller.signal.throwIfAborted();
      if (!commit) {
        entry.backend.stop?.();
        entry.backend = undefined;
        entry.restored = true;
        entry.contexts.clear();
      }
      if (terminal) emit(terminal);
      else throw new Error('backend ended without a terminal result');
    } catch (error) {
      backendOpen = false;
      if (acquired) {
        if (entry.binding) entry.binding.runtime = undefined;
        try {
          entry.backend?.stop?.();
        } catch {
          /* Still complete the container cleanup barrier. */
        }
        entry.backend = undefined;
        entry.restored = true;
        entry.contexts.clear();
        try {
          await runtime?.finish(false);
        } catch {
          entry.quarantined = true;
        }
        // Failed allocation can also mean Docker accepted an unconfirmed
        // create/remove. Conservatively quarantine until startup reconciliation.
        if (allocationAttempted && !runtime) entry.quarantined = true;
      }
      this.fail(
        task,
        emit,
        entry.quarantined
          ? 'runtime_quarantined'
          : controller.signal.aborted
            ? 'runtime_canceled'
            : 'runtime_failed',
        controller.signal.aborted
          ? runtime?.committed
            ? 'caller execution canceled after checkpoint commit; saved state is retained'
            : 'caller execution canceled or deadline exceeded; uncommitted changes discarded'
          : (error as Error).message,
      );
    } finally {
      backendOpen = false;
      if (acquired && entry.binding) entry.binding.runtime = undefined;
      release();
      clearTimeout(timer);
      clearInterval(heartbeat);
      signal.removeEventListener('abort', forwardAbort);
      this.controllers.delete(controller);
      this.pending--;
    }
  }
  private validate(task: TaskAssignFrame): string {
    const scope = ExecutionScopeV1.parse(task.executionScope);
    const caller = task.caller;
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
        'execution scope does not match authenticated caller/agent/generation',
      );
    if (
      (task.requestedExtensions ?? []).includes(OPENAI_COMPAT_EXTENSION_URI) ||
      (task.message.extensions ?? []).includes(OPENAI_COMPAT_EXTENSION_URI) ||
      task.message.metadata?.[OPENAI_COMPAT_EXTENSION_URI] !== undefined ||
      task.message.parts.some((part) => part.kind === 'data')
    )
      throw new Error(
        'caller-container supports plain A2A text/file inputs only; caller tools are unsupported',
      );
    return scope.id;
  }
  private fail(
    task: TaskAssignFrame,
    emit: Emit,
    code: string,
    message: string,
  ): void {
    emit({ type: 'task.fail', taskId: task.taskId, error: { code, message } });
  }
  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers)
      controller.abort(new Error('runtime stopping'));
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.active]);
    for (const entry of this.entries.values()) entry.backend?.stop?.();
    await this.pool.close();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('execution aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
