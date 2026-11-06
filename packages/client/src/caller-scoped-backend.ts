import { CallerExecutionScheduler, CallerQueueFullError } from './caller-execution-scheduler.js';
import { CallerStorageHelperUnconfirmedError } from './caller-storage.js';
import { INPUT_FILE_MAX_BYTES, INPUT_IMAGE_MIME, decodedBase64Size } from './backends/fetch-uri-file.js';
import {
  ExecutionScopeV1,
  parseFederatedPrincipal,
  executionScopePolicy,
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import type {
  DockerCallerRuntimePool,
  CallerContainer,
} from './caller-runtime-docker.js';
import { CallerScopeCleanupUnconfirmedError, CallerEnvironmentPendingError, CallerReservationUnconfirmedError, CallerAllocationIncompleteError, CallerOrphanedResourcesError, CallerStorageLimitError, CallerStorageMissingError } from './caller-runtime-docker.js';
import { scopeDigest, CallerContextCapacityError } from './caller-runtime-store.js';
import { createHash } from 'node:crypto';
export interface CallerWorker {
  backend: Backend;
  settle(): Promise<void>;
  close(): void;
  healthy(): boolean;
  bindContainer?(container: CallerContainer): void;
}
interface Entry {
  users: number;
  retained: boolean;
  tail: Promise<void>;
  worker?: CallerWorker;
  dockerId?: string;
  contexts: Set<string>;
  recovered: boolean;
  quarantined: boolean;
  idleTimer?: NodeJS.Timeout;
  idleGeneration: number;
  contextWorkers: Map<string, CallerWorker>;
  failedContexts: Set<string>;
}
export class CallerScopedBackend implements Backend {
  remoteApprovals?: boolean;
  readonly requiresCallerScope = true;
  readonly name: string;
  private entries = new Map<string, Entry>();
  private active = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private pending = 0;
  private stopped = false;
  private readonly scheduler?: CallerExecutionScheduler;
  constructor(
    private agentId: string,
    readonly pool: DockerCallerRuntimePool,
    private factory: (container: CallerContainer, signal: AbortSignal) => Promise<CallerWorker>,
  ) {
    this.name = pool.kind;
    if (pool.options.concurrency) this.scheduler = new CallerExecutionScheduler({
      ...pool.options.concurrency, queueLimit: pool.options.queueLimit,
    });
  }
  async initialize(): Promise<void> {
    for (const id of await this.pool.initialize())
      this.entries.set(id, this.entry(true));
  }
  private entry(recovered = false): Entry {
    return {
      users: 0,
      retained: recovered,
      tail: Promise.resolve(),
      contexts: new Set(),
      recovered,
      quarantined: false,
      idleGeneration: 0,
      contextWorkers: new Map(),
      failedContexts: new Set(),
    };
  }
  private cancelIdle(entry: Entry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.idleGeneration++;
  }
  private armIdle(id: string, entry: Entry): void {
    this.cancelIdle(entry);
    // Context containers are removed before their execution leases are released.
    // The legacy scope timer must never stop independent context executions.
    if (this.scheduler) return;
    const timeout = this.pool.options.idleTimeoutMs;
    if (!timeout || this.stopped || entry.users || entry.quarantined || !entry.worker) return;
    const generation = entry.idleGeneration;
    const eligible = () => !this.stopped && entry.idleGeneration === generation &&
      this.entries.get(id) === entry && entry.users === 0 && !entry.quarantined && !!entry.worker;
    entry.idleTimer = setTimeout(() => {
      if (!eligible()) return;
      entry.idleTimer = undefined;
      // Install the barrier synchronously. Admission either invalidates this
      // decision before cleanup starts, or waits for its confirmed completion.
      const work = entry.tail.then(async () => {
        if (!eligible()) return;
        await this.reclaimIdle(id, entry);
      });
      entry.tail = work;
      this.active.add(work);
      void work.finally(() => this.active.delete(work)).catch(() => {});
    }, timeout);
    entry.idleTimer.unref();
  }
  private async reclaimIdle(id: string, entry: Entry): Promise<void> {
    const worker = entry.worker!;
    let failed = false;
    // Attempt every cleanup step, even if a worker/helper fails to close.
    try { if (!worker.healthy()) failed = true; } catch { failed = true; }
    try { worker.backend.stop?.(); } catch { failed = true; }
    try { worker.close(); } catch { failed = true; }
    try {
      await within(worker.settle(), 15000);
    } catch { failed = true; }
    try { await this.pool.stop(id); } catch { failed = true; }
    entry.worker = undefined;
    entry.dockerId = undefined;
    entry.contexts.clear();
    entry.recovered = true;
    entry.quarantined = failed;
    try {
      await this.pool.recordLifecycle(id, { lastIdleStop: {
        at: new Date().toISOString(), reason: 'idle-timeout',
        outcome: failed ? 'quarantined' : 'stopped',
      } });
    } catch {
      entry.quarantined = true;
      console.error('Caller runtime idle lifecycle recording failed; scope quarantined');
    }
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
    const tuple = parseFederatedPrincipal(scope.principalId);
    const identityMatches = caller && 'principal' in caller && (
      tuple
        ? caller.actor?.id === tuple.issuer && caller.principal?.id === tuple.subject
        : !caller.actor && caller.principal?.id === scope.principalId
    );
    if (
      !task.executionId ||
      !identityMatches ||
      scope.policy !== executionScopePolicy(scope.principalId) ||
      scope.agentId !== this.agentId ||
      scope.id !== scopeDigest(this.agentId, scope.principalId)
    )
      throw new Error(
        'scope does not match authenticated caller, agent and execution',
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
    if (task.requestedExtensions?.includes(TRACEABILITY_EXTENSION_URI) ||
        task.message.extensions?.includes(TRACEABILITY_EXTENSION_URI))
      throw new Error('traceability output is unsupported in caller containers');
    for (const part of task.message.parts) {
      if (part.kind !== 'file') continue;
      const mime = part.file.mimeType ?? '';
      if ((!INPUT_IMAGE_MIME.has(mime) && !(this.pool.kind === 'claude' && mime === 'application/pdf')) ||
          decodedBase64Size(part.file.bytes!) > INPUT_FILE_MAX_BYTES)
        throw new Error('unsupported caller-runtime file MIME or size');
    }
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
    if (this.scheduler) return this.executeConcurrent(id, task, emit, signal);
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
    entry.users++;
    this.cancelIdle(entry);
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
    let storageCheckFailed = false;
    let resuming = false;
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
      phase = 'allocation';
      resuming = entry.recovered && !entry.worker;
      const container = await this.pool.acquire(
        id,
        controller.signal,
        task.executionScope!.principalId,
        () => { entry.retained = true; }, // Only a committed reservation consumes retained capacity.
        () => { acquired = true; }, // Mutations require cleanup even if acquisition fails.
      );
      acquired = true;
      controller.signal.throwIfAborted();
      phase = 'backend-initialization';
      if ((container.restarted || container.recreated || container.dockerId !== entry.dockerId) && entry.worker) {
        entry.worker.backend.stop?.();
        entry.worker.close();
        await within(entry.worker.settle(), 15000);
        entry.worker = undefined;
        entry.contexts.clear();
        entry.recovered = true;
        resuming = true;
      }
      if (!entry.worker) {
        entry.worker = await this.factory(container, controller.signal);
        entry.dockerId = container.dockerId;
      }
      controller.signal.throwIfAborted();
      if (resuming) {
        await this.pool.recordLifecycle(id, { lastResume: {
          at: new Date().toISOString(), outcome: 'conversation-reset',
        } });
        resuming = false;
      }
      if (entry.recovered && !entry.contexts.has(context)) {
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
      }
      entry.contexts.add(context);
      let terminal: UpFrame | undefined;
      monitor = setInterval(() => {
        if (storageCheck) return;
        storageCheck = this.pool
          .checkStorage(id, controller.signal)
          .catch((error) => {
            if (controller.signal.aborted) return;
            storageCheckFailed = true;
            storageFailure = error instanceof CallerStorageLimitError;
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
      await this.pool.checkStorage(id, controller.signal);
      controller.signal.throwIfAborted();
      if (!terminal) throw new Error('backend missing terminal');
      emit(terminal);
    } catch (error) {
      clearInterval(monitor);
      if (resuming) {
        try {
          await this.pool.recordLifecycle(id, { lastResume: {
            at: new Date().toISOString(), outcome: 'failed',
          } });
        } catch { entry.quarantined = true; }
      }
      if (error instanceof CallerStorageLimitError)
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
      if (error instanceof CallerEnvironmentPendingError) {
        this.fail(task, emit, 'runtime_setup_pending', 'Your environment is awaiting setup. Ask the operator to complete container setup before retrying.');
        return;
      }
      if (error instanceof CallerStorageHelperUnconfirmedError) {
        entry.quarantined = true;
        this.fail(task, emit, 'runtime_quarantined',
          'Storage helper cleanup could not be confirmed; scope quarantined until Docker reconciliation succeeds.');
        return;
      }
      if (error instanceof CallerOrphanedResourcesError) {
        entry.quarantined = true;
        this.fail(task, emit, 'runtime_orphaned_resources',
          'Unrecorded caller resources were not adopted. Stop the daemon and inspect the orphan Docker resources or restore their original state database.');
        return;
      }
      if (error instanceof CallerReservationUnconfirmedError) {
        entry.quarantined = true;
        this.fail(task, emit, 'runtime_reservation_unconfirmed',
          'Caller reservation rollback could not be confirmed; stop the daemon and inspect/remove the scope before retrying.');
        return;
      }
      if (error instanceof CallerAllocationIncompleteError) {
        entry.quarantined = true;
        this.fail(task, emit, 'runtime_allocation_incomplete',
          'Initial caller allocation was interrupted; restore the original state/resources or explicitly remove the scope before retrying.');
        return;
      }
      if (error instanceof CallerStorageMissingError) {
        entry.quarantined = true;
        this.fail(task, emit, 'runtime_storage_missing',
          'Retained caller storage is missing; no replacement was created. Stop the daemon and restore the original volumes, or explicitly remove the scope to start over.');
        return;
      }
      this.fail(
        task,
        emit,
        entry.quarantined
          ? 'runtime_quarantined'
          : storageFailure
            ? 'runtime_storage_limit'
            : storageCheckFailed
              ? 'runtime_failed'
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
      // Canceled tasks return promptly, but their chained barriers still consume
      // queue capacity until the predecessor settles. This bounds retained closures.
      const releaseSlot = () => {
        release();
        this.pending--;
        entry.users--;
        if (!entry.retained && !entry.quarantined && entry.users === 0) this.entries.delete(id);
        else if (entry.users === 0) this.armIdle(id, entry);
      };
      void previous.then(releaseSlot, releaseSlot);
      signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }
  private async executeConcurrent(id: string, task: TaskAssignFrame, emit: Emit, signal: AbortSignal): Promise<void> {
    const opts = this.pool.options;
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= opts.maxScopes) {
        this.fail(task, emit, 'runtime_capacity', 'Retained caller capacity reached');
        return;
      }
      entry = this.entry();
      this.entries.set(id, entry);
    }
    const context = createHash('sha256').update(JSON.stringify([id, task.contextId])).digest('hex');
    if (entry.quarantined || entry.failedContexts.has(context)) {
      this.fail(task, emit, 'runtime_quarantined', 'Caller context requires offline recovery');
      return;
    }
    entry.users++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let phase = 'queue';
    let timedOut = false;
    const timeout = () => { timedOut = true; abort(); };
    let timer = setTimeout(timeout, opts.concurrency!.queueTimeoutMs);
    let release: (() => void) | undefined;
    let acquired = false;
    let forwarding = true;
    let worker: CallerWorker | undefined;
    let terminal: UpFrame | undefined;
    const heartbeat = setInterval(() => {
      if (!controller.signal.aborted) emit({ type: 'task.status', taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
        metadata: { 'vicoop.runtime': { phase } } });
    }, 5000);
    try {
      release = await this.scheduler!.acquire(id, context, controller.signal);
      clearTimeout(timer);
      timer = setTimeout(timeout, opts.taskTimeoutMs);
      controller.signal.throwIfAborted();
      if (entry.quarantined || entry.failedContexts.has(context)) throw new Error('context unavailable');
      if (!entry.contexts.has(context) && entry.contexts.size >= opts.maxContexts) {
        this.fail(task, emit, 'runtime_capacity', 'Caller conversation capacity reached');
        return;
      }
      phase = 'allocation';
      acquired = true; // Persisted context intent determines what cleanup may touch.
      const container = await this.pool.acquireContext(id, context, controller.signal,
        task.executionScope!.principalId, () => { entry.retained = true; });
      controller.signal.throwIfAborted();
      phase = 'backend-initialization';
      worker = entry.contextWorkers.get(context);
      if (!worker) {
        worker = await this.factory(container, controller.signal);
        entry.contextWorkers.set(context, worker);
        emit({ type: 'task.status', taskId: task.taskId,
          status: { state: 'working', timestamp: new Date().toISOString() },
          metadata: { 'vicoop.runtime': { workspaceMode: 'context', workspaceRestored: container.recovered,
            conversationReset: entry.recovered || entry.contexts.has(context), legacyWorkspace: '/caller-workspace' } } });
      }
      worker.bindContainer?.(container);
      entry.contexts.add(context);
      phase = 'execution';
      const work = worker.backend.handle({ ...task, contextId: context }, frame => {
        if (!forwarding || controller.signal.aborted) return;
        if (frame.type === 'task.complete' || frame.type === 'task.fail') terminal = frame;
        else emit(frame);
      }, controller.signal);
      void work.catch(() => {});
      await abortable(work, controller.signal);
      forwarding = false;
      phase = 'cleanup';
      await within(worker.settle(), 15000);
      if (!worker.healthy()) throw new Error('execution cleanup uncertain');
      await this.pool.stopContext(id, context);
      acquired = false;
      controller.signal.throwIfAborted();
      if (!terminal) throw new Error('backend missing terminal');
      emit(terminal);
    } catch (error) {
      forwarding = false;
      console.error('Caller context runtime failure phase:', phase, error instanceof Error ? error.name : 'unknown');
      // Only this context owns this worker/broker/container. A sibling's grant,
      // approval handler and output snapshots are never closed here.
      if (acquired || worker) {
        worker ??= entry.contextWorkers.get(context);
        worker?.backend.stop?.();
        worker?.close();
        try { await within(worker?.settle() ?? Promise.resolve(), 15000); } catch { /* Docker removal is authoritative. */ }
        try { if (acquired) await this.pool.stopContext(id, context); }
        catch { entry.failedContexts.add(context); }
        entry.contextWorkers.delete(context);
      }
      if (error instanceof CallerStorageHelperUnconfirmedError || error instanceof CallerScopeCleanupUnconfirmedError) {
        entry.quarantined = true;
        entry.failedContexts.add(context); // Unconfirmed shared work continues to consume capacity.
      }
      if (error instanceof CallerStorageHelperUnconfirmedError || error instanceof CallerScopeCleanupUnconfirmedError ||
          error instanceof CallerReservationUnconfirmedError || error instanceof CallerOrphanedResourcesError ||
          error instanceof CallerAllocationIncompleteError || error instanceof CallerStorageMissingError)
        entry.quarantined = true;
      const quarantined = entry.quarantined || entry.failedContexts.has(context);
      this.fail(task, emit,
        quarantined ? 'runtime_quarantined' : (error instanceof CallerQueueFullError || error instanceof CallerContextCapacityError) ? 'runtime_capacity' :
          error instanceof CallerEnvironmentPendingError ? 'runtime_setup_pending' :
          timedOut ? (phase === 'queue' ? 'runtime_queue_timeout' : 'runtime_timeout') :
          controller.signal.aborted ? 'runtime_canceled' : 'runtime_failed',
        quarantined ? 'Runtime cleanup or storage is uncertain; offline recovery required' :
          phase === 'queue' ? 'Caller request left the queue; running executions are unchanged' :
            'Caller context execution ended; persistent context files, including partial writes, are retained');
    } finally {
      forwarding = false;
      clearTimeout(timer);
      clearInterval(heartbeat);
      signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
      entry.users--;
      if (!entry.retained && !entry.quarantined && entry.users === 0) this.entries.delete(id);
      // A failed/unconfirmed container still consumes its slot until restart.
      // This prevents capacity from being exceeded by potentially live work.
      if (!entry.failedContexts.has(context)) release?.();
    }
  }
  stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) this.cancelIdle(entry);
    for (const controller of this.controllers) controller.abort();
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.active]);
    for (const entry of this.entries.values()) {
      for (const worker of entry.contextWorkers.values()) {
        worker.backend.stop?.();
        worker.close();
      }
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
