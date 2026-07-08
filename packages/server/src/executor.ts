import {
  AgentExecutor,
  BaseAgent,
  InMemoryRunner,
  StreamingMode,
  TaskState,
  TERMINAL_STATES,
  type Artifact,
  type AgentEvent,
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
  type TaskStore,
} from '@a2x/sdk';
import type { Registry, TaskBinding, TaskSink } from './registry.js';
import { AsyncEventQueue } from './event-queue.js';
import { logEvent } from './log.js';
import { terminalErrorMessageFields } from './terminal-error.js';

// AgentExecutor's constructor requires a Runner+BaseAgent because Layer 2
// (the in-process LLM model) is the default. Our WS-forwarding path
// bypasses Layer 2 entirely — execute/executeStream/cancel are overridden
// and never call into the runner. The dummy runner is only there so super()
// type-checks.
class NoopAgent extends BaseAgent {
  constructor() {
    super({ name: 'vicoop-bridge-noop' });
  }
  async *run(): AsyncGenerator<AgentEvent> {
    // Never invoked.
  }
}

const NOOP_RUNNER = new InMemoryRunner({
  agent: new NoopAgent(),
  appName: 'vicoop-bridge-noop',
});

// Server-authoritative inactivity backstop. If a bound task produces NO inbound
// frame — content, artifact, OR a heartbeat `task.status` — for this long, the
// bridge fabricates a terminal `failed` status so the SSE stream closes instead
// of hanging forever on a lost/absent terminal frame (a connected-but-silent
// daemon, or any future path that drops the terminal). Every inbound frame
// resets it, so a healthily-heartbeating long task is never reaped. `0`
// disables it. Default 10 min: comfortably above the longest legitimate silent
// gap for backends that heartbeat, while still reaping a genuinely dead stream.
const DEFAULT_INACTIVITY_TIMEOUT_MS = (() => {
  const raw = process.env.BRIDGE_TASK_INACTIVITY_TIMEOUT_MS;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : 600_000;
})();

function appendArtifactChunk(accumulated: Artifact[], event: TaskArtifactUpdateEvent): void {
  if (event.append !== true) {
    accumulated.push(event.artifact);
    return;
  }

  const existing = accumulated.find((a) => a.artifactId === event.artifact.artifactId);
  if (!existing) {
    accumulated.push(event.artifact);
    return;
  }

  existing.parts = mergeArtifactParts(existing.parts, event.artifact.parts);
  existing.name = event.artifact.name ?? existing.name;
  existing.metadata = event.artifact.metadata ?? existing.metadata;
  existing.extensions = event.artifact.extensions ?? existing.extensions;
}

function mergeArtifactParts(existing: Artifact['parts'], chunk: Artifact['parts']): Artifact['parts'] {
  if (existing.length === 1 && chunk.length === 1) {
    const current = existing[0] as Record<string, unknown>;
    const next = chunk[0] as Record<string, unknown>;
    if (typeof current.text === 'string' && typeof next.text === 'string') {
      return [{ ...current, text: current.text + next.text }] as Artifact['parts'];
    }
  }
  return [...existing, ...chunk];
}

/**
 * Drop server-internal `_`-prefixed metadata keys (e.g. `_principalId`)
 * before forwarding a message to the connected client. The convention is
 * shared with the admin route — `_`-prefix means "bridge-internal context,
 * not for downstream". Returns undefined when nothing meaningful survives so
 * the WS frame omits the metadata field entirely (preserving the
 * pre-existing wire shape for messages that had no metadata).
 *
 * Exported for unit tests.
 */
export function stripInternalMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key.startsWith('_')) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function appendHistoryMessage(history: Message[], message: Message | undefined): Message[] {
  if (message === undefined) return history;
  if (history.some((existing) => existing.messageId === message.messageId)) return history;
  return [...history, message];
}

/**
 * AgentExecutor that forwards A2A requests to a WebSocket-connected
 * client and pipes the client's task.* frames back as A2A streaming
 * events.
 *
 * Each call to executeStream() / execute() owns an AsyncEventQueue;
 * the registry's TaskSink (held in the binding) is wired to that queue.
 * ws.ts converts inbound `task.status` / `task.artifact` / `task.complete`
 * / `task.fail` frames into status/artifact events and pushes them onto
 * the sink, which flows through the queue and out as wire-format SSE
 * events via the request handler.
 */
export class WSForwardingExecutor extends AgentExecutor {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly agentId: string,
    private readonly registry: Registry,
    private readonly taskStore: TaskStore,
    private readonly inactivityTimeoutMs: number = DEFAULT_INACTIVITY_TIMEOUT_MS,
  ) {
    super({
      runner: NOOP_RUNNER,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
  }

  override async execute(task: Task, message: Message): Promise<Task> {
    // Drain the streaming variant so callers that use message/send
    // (non-streaming) still get the full final task with accumulated
    // artifacts. The terminal events mutate `task` in place.
    for await (const _event of this.executeStream(task, message)) {
      void _event;
    }
    return task;
  }

  override async *executeStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const taskId = task.id;
    const contextId = task.contextId ?? taskId;
    const queue = new AsyncEventQueue<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>();
    const ac = new AbortController();
    this.abortControllers.set(taskId, ac);

    const sink: TaskSink = {
      pushStatus: (event) => queue.push(event),
      pushArtifact: (event) => queue.push(event),
      finish: () => queue.end(),
    };

    // The /agents/:id route stashes server-internal context on
    // `message.metadata` under `_`-prefixed keys (matching the admin route's
    // `_principalId` / `_bearerToken` convention). `_principalId` flows into
    // the binding so accept-path logs in ws.ts can correlate caller →
    // completed task without exposing it to the client agent over the wire.
    const rawMetadata = (message as { metadata?: Record<string, unknown> }).metadata;
    const principalId =
      typeof rawMetadata?._principalId === 'string' ? rawMetadata._principalId : undefined;
    const forwardMetadata = stripInternalMetadata(rawMetadata);
    const requestedExtensions = message.extensions;

    const binding: TaskBinding = {
      agentId: this.agentId,
      taskId,
      contextId,
      sink,
      ...(principalId !== undefined ? { principalId } : {}),
      ...(requestedExtensions !== undefined ? { requestedExtensions } : {}),
    };
    this.registry.bindTask(binding);

    let history = appendHistoryMessage(task.history ?? [], message);
    task.history = history;

    const sent = this.registry.sendToAgent(this.agentId, {
      type: 'task.assign',
      taskId,
      contextId,
      message: {
        role: message.role,
        // The WS protocol uses the v0.3 wire shape (`{kind, ...}`); the
        // request-handler hands us `message` unmodified, so we forward
        // the parts through as-is.
        parts: message.parts as never,
        messageId: message.messageId,
        ...(forwardMetadata !== undefined ? { metadata: forwardMetadata } : {}),
        ...(message.extensions !== undefined ? { extensions: message.extensions } : {}),
      },
      ...(message.extensions !== undefined ? { requestedExtensions: message.extensions } : {}),
    });

    if (!sent) {
      logEvent('task_unreachable', {
        agentId: this.agentId,
        taskId,
        contextId,
        ...(principalId !== undefined ? { principalId } : {}),
      });
      const failEvent: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        final: true,
        status: {
          state: TaskState.FAILED,
          timestamp: new Date().toISOString(),
          message: {
            messageId: `${taskId}-unreach`,
            role: 'agent',
            parts: [{ text: 'client not connected' }],
            ...terminalErrorMessageFields(
              {
                code: 'client_not_connected',
                message: 'client not connected',
              },
              requestedExtensions,
            ),
            taskId,
            contextId,
          },
        },
      };
      task.status = failEvent.status;
      history = appendHistoryMessage(history, failEvent.status.message);
      task.history = history;
      this.registry.unbindTask(taskId, binding);
      if (this.abortControllers.get(taskId) === ac) this.abortControllers.delete(taskId);
      yield failEvent;
      try {
        await this.taskStore.updateTask(taskId, {
          status: task.status,
          history: task.history,
        });
      } catch (err) {
        logEvent('task_persist_error', { taskId, error: String(err) });
      }
      return;
    }

    const accumulatedArtifacts: Artifact[] = [];

    // Inactivity backstop: reset on every inbound frame; on expiry, fabricate a
    // terminal `failed` status and close the queue so this generator returns
    // and the SSE stream closes. Push-after-end and end-after-terminal are
    // no-ops (AsyncEventQueue), so racing a real terminal frame is harmless.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const clearWatchdog = (): void => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
    };
    const armWatchdog = (): void => {
      if (this.inactivityTimeoutMs <= 0) return;
      clearWatchdog();
      watchdog = setTimeout(() => {
        queue.push({
          taskId,
          contextId,
          final: true,
          status: {
            state: TaskState.FAILED,
            timestamp: new Date().toISOString(),
            message: {
              messageId: `${taskId}-inactivity`,
              role: 'agent',
              parts: [{ text: 'task timed out: no activity from the connected agent' }],
              ...terminalErrorMessageFields(
                {
                  code: 'inactivity_timeout',
                  message: 'no activity from the connected agent',
                },
                requestedExtensions,
              ),
              taskId,
              contextId,
            },
          },
        });
        queue.end();
        logEvent('task_inactivity_timeout', {
          agentId: this.agentId,
          taskId,
          contextId,
          inactivityMs: this.inactivityTimeoutMs,
          ...(principalId !== undefined ? { principalId } : {}),
        });
      }, this.inactivityTimeoutMs);
    };

    try {
      armWatchdog();
      for await (const event of queue.iterate(ac.signal)) {
        armWatchdog();
        if ('artifact' in event) {
          // Mirror the streamed artifact onto the task object so the
          // post-stream `getTask()` path (push notifications, sync
          // `message/send`) sees the same artifacts the streaming
          // consumers received.
          appendArtifactChunk(accumulatedArtifacts, event);
          yield event;
          continue;
        }
        // status event
        history = appendHistoryMessage(history, event.status.message);
        task.history = history;
        if (TERMINAL_STATES.has(event.status.state)) {
          // Terminal — mutate task in place so the request-handler's
          // post-stream read reflects the final state.
          task.status = event.status;
          if (accumulatedArtifacts.length > 0) {
            task.artifacts = accumulatedArtifacts;
          }
          yield event;
          break;
        }
        yield event;
      }
      // Stop the watchdog before the awaited persist below — the stream is done
      // producing, so a timer firing during the DB write would be spurious.
      clearWatchdog();

      if (!TERMINAL_STATES.has(task.status.state)) {
        // Stream ended without a terminal frame (e.g. queue closed by
        // disconnect handler that already pushed a failed status — that
        // status is now in `task.status`). Defensive: mark canceled.
        if (ac.signal.aborted) {
          task.status = {
            state: TaskState.CANCELED,
            timestamp: new Date().toISOString(),
          };
        }
      }

      try {
        await this.taskStore.updateTask(taskId, {
          status: task.status,
          history: task.history,
          ...(accumulatedArtifacts.length > 0 ? { artifacts: accumulatedArtifacts } : {}),
        });
      } catch (err) {
        logEvent('task_persist_error', { taskId, error: String(err) });
      }
    } finally {
      clearWatchdog();
      this.registry.unbindTask(taskId, binding);
      if (this.abortControllers.get(taskId) === ac) this.abortControllers.delete(taskId);
    }
  }

  override async cancel(task: Task): Promise<Task> {
    const taskId = task.id;
    const contextId = task.contextId ?? taskId;
    const ac = this.abortControllers.get(taskId);

    // Notify the connected client so it can abort in-flight work and
    // emit its own task.fail / task.complete frame. Even if the client
    // ignores it, the local AbortController + binding cleanup proceeds
    // so the executor's stream terminates promptly.
    this.registry.sendToAgent(this.agentId, { type: 'task.cancel', taskId });

    if (ac && !ac.signal.aborted) ac.abort();

    const binding = this.registry.getBinding(taskId);
    if (binding) {
      const cancelStatus: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        final: true,
        status: {
          state: TaskState.CANCELED,
          timestamp: new Date().toISOString(),
        },
      };
      binding.sink.pushStatus(cancelStatus);
      binding.sink.finish();
    }

    task.status = {
      state: TaskState.CANCELED,
      timestamp: new Date().toISOString(),
    };
    try {
      await this.taskStore.updateTask(taskId, { status: task.status });
    } catch (err) {
      logEvent('task_persist_error', { taskId, error: String(err) });
    }
    return task;
  }
}
