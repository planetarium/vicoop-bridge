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
import type { Registry, TaskSink } from './registry.js';
import { AsyncEventQueue } from './event-queue.js';
import { logEvent } from './log.js';

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

    this.registry.bindTask({ agentId: this.agentId, taskId, contextId, sink });

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
      },
    });

    if (!sent) {
      logEvent('task_unreachable', { agentId: this.agentId, taskId, contextId });
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
            taskId,
            contextId,
          },
        },
      };
      task.status = failEvent.status;
      this.registry.unbindTask(taskId);
      this.abortControllers.delete(taskId);
      yield failEvent;
      try {
        await this.taskStore.updateTask(taskId, { status: task.status });
      } catch (err) {
        logEvent('task_persist_error', { taskId, error: String(err) });
      }
      return;
    }

    const accumulatedArtifacts: Artifact[] = [];

    try {
      for await (const event of queue.iterate(ac.signal)) {
        if ('artifact' in event) {
          // Mirror the streamed artifact onto the task object so the
          // post-stream `getTask()` path (push notifications, sync
          // `message/send`) sees the same artifacts the streaming
          // consumers received.
          accumulatedArtifacts.push(event.artifact);
          yield event;
          continue;
        }
        // status event
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
          ...(accumulatedArtifacts.length > 0 ? { artifacts: accumulatedArtifacts } : {}),
        });
      } catch (err) {
        logEvent('task_persist_error', { taskId, error: String(err) });
      }
    } finally {
      this.registry.unbindTask(taskId);
      this.abortControllers.delete(taskId);
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
