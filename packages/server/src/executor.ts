import {
  AgentExecutor,
  BaseAgent,
  InMemoryRunner,
  StreamingMode,
  TaskNotCancelableError,
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
import { X402Gate, createPostgresX402Context, type X402Settlement } from './x402/gate.js';
import { readTaskUsage } from './x402/usage.js';
import type { Sql } from './db.js';
import { CALLER_CONTEXT_CAPABILITY, CallerContextV1 } from '@vicoop-bridge/protocol';

/**
 * What the executor needs to run the x402 payment gate: a DB handle for the
 * offering store, and the public URL of this agent, which is what the payer
 * is shown they are paying for.
 */
export interface X402ExecutorOptions {
  sql: Sql;
  resource: string;
}


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
    // These names are transport-owned. Caller-supplied lookalikes must not
    // cross the WS boundary where a backend might mistake them for verified
    // context.
    if (key === 'caller' || key === 'callerContext' || key === 'caller_context') continue;
    if (
      key === 'mentionable' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const mentionable: Record<string, unknown> = {};
      for (const [mentionableKey, mentionableValue] of Object.entries(value)) {
        if (
          mentionableKey === 'identity_evidence' ||
          mentionableKey === 'verifiable_credentials'
        ) {
          continue;
        }
        mentionable[mentionableKey] = mentionableValue;
      }
      if (Object.keys(mentionable).length > 0) out[key] = mentionable;
      continue;
    }
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
  // Gate for the agent's current pricing, rebuilt when the pricing changes.
  // Pricing is read from the live `ClientConnection` on every turn rather
  // than captured here, so an admin repricing an agent takes effect on the
  // next call instead of on the next reconnect.
  private gateCache: { key: string; gate: X402Gate } | undefined;

  constructor(
    private readonly agentId: string,
    private readonly registry: Registry,
    private readonly taskStore: TaskStore,
    private readonly inactivityTimeoutMs: number = DEFAULT_INACTIVITY_TIMEOUT_MS,
    // Absent in tests and on deployments without a DB-backed payment path;
    // the gate is then never installed and every agent is free.
    private readonly x402: X402ExecutorOptions | undefined = undefined,
  ) {
    super({
      runner: NOOP_RUNNER,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
  }

  /**
   * The payment gate for this turn, or `undefined` when the agent is free.
   */
  private currentGate(): X402Gate | undefined {
    if (this.x402 === undefined) return undefined;
    const pricing = this.registry.getAgent(this.agentId)?.x402Pricing;
    if (pricing === undefined) {
      this.gateCache = undefined;
      return undefined;
    }
    const key = JSON.stringify(pricing);
    if (this.gateCache?.key !== key) {
      const { context, offerStore } = createPostgresX402Context(this.x402.sql, this.agentId);
      this.gateCache = {
        key,
        gate: new X402Gate(this.agentId, pricing, context, offerStore, this.x402.resource),
      };
    }
    return this.gateCache.gate;
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

  /**
   * Fold the payment outcome into the agent's terminal event, and release the
   * offering.
   *
   * Which half runs depends on when the scheme could settle:
   *
   * - `settled` (`exact`) — already charged before the agent was contacted.
   *   Only the receipt is attached here, on success *and* on failure: the
   *   payer paid either way and the receipt is their proof. A task that fails
   *   after payment is a real cost to them, which is what
   *   `x402_paid_task_failed` counts.
   * - `deferred` (`upto`) — the charge is metered from consumption, which does
   *   not exist until now, so this is the first moment it can be computed. The
   *   token counts come from the `task.complete` frame, which `ws.ts` stashes
   *   on the binding.
   *
   * Only a completed task is settled under `upto`: a failure leaves the
   * payer's authorization unused rather than charging for work they did not
   * get. The corollary is that the output has already streamed to the caller
   * by the time this runs, so a payer who invalidates their authorization
   * mid-task receives the result and a `failed` status. `upto` cannot avoid
   * that — there is nothing to meter before the work — and
   * `x402_unpaid_delivery` counts it.
   */
  private async settleTerminal(
    gate: X402Gate,
    settlement: X402Settlement,
    event: TaskStatusUpdateEvent,
    binding: TaskBinding,
    taskId: string,
    contextId: string,
  ): Promise<TaskStatusUpdateEvent> {
    // The offering row outlives the work — under `exact` it holds the claim
    // that stops a resubmission being charged a second time — so releasing it
    // is this function's job regardless of which branch runs.
    const done = async <T>(value: T): Promise<T> => {
      await gate.clear(taskId);
      return value;
    };

    if (settlement.mode === 'settled') {
      if (event.status.state !== TaskState.COMPLETED) {
        logEvent('x402_paid_task_failed', {
          agentId: this.agentId,
          taskId,
          state: event.status.state,
        });
      }
      return done(this.withReceipt(event, settlement.metadata, taskId, contextId));
    }

    if (event.status.state !== TaskState.COMPLETED) return done(event);

    const read = readTaskUsage(binding.usage, event.status.message?.metadata);
    if (read.source === 'openai-compat') {
      // The client is old enough not to send the protocol field. Billing still
      // works off the legacy key, but this is the signal to chase the client
      // upgrade — the fallback is meant to be retired.
      logEvent('x402_usage_legacy_source', { agentId: this.agentId, taskId });
    }

    const result = await gate.settle({
      taskId,
      contextId,
      obligation: settlement.obligation,
      usage: read.usage,
      ...(read.model !== undefined ? { model: read.model } : {}),
    });
    if (result.kind === 'failed') {
      // The caller already has the output — see the note above. This is the
      // event that quantifies the window, so it is emitted here rather than
      // left implicit in the settlement failure.
      logEvent('x402_unpaid_delivery', { agentId: this.agentId, taskId });
      return done(result.event);
    }
    return done(this.withReceipt(event, result.metadata, taskId, contextId));
  }

  /**
   * Attach settlement metadata to a terminal event's status message, which is
   * where the x402 transport specifies clients read receipts from.
   */
  private withReceipt(
    event: TaskStatusUpdateEvent,
    metadata: Record<string, unknown>,
    taskId: string,
    contextId: string,
  ): TaskStatusUpdateEvent {
    const existing = event.status.message;
    return {
      ...event,
      status: {
        ...event.status,
        message: {
          ...(existing ?? {
            messageId: `${taskId}-x402-receipt`,
            role: 'agent' as const,
            parts: [],
            taskId,
            contextId,
          }),
          metadata: { ...(existing?.metadata ?? {}), ...metadata },
        },
      },
    };
  }

  override async *executeStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const taskId = task.id;
    const contextId = task.contextId ?? taskId;

    // x402 payment gate. Runs before the task is bound or forwarded, so an
    // unpaid call never reaches the connected agent and never consumes its
    // capacity. `settlement` is set only when a payment was verified and is
    // therefore owed once the work completes.
    const gate = this.currentGate();
    let settlement: X402Settlement | undefined;
    if (gate) {
      const outcome = await gate.open({ taskId, contextId, message });
      if (outcome.kind === 'halt') {
        task.status = outcome.event.status;
        task.history = appendHistoryMessage(
          appendHistoryMessage(task.history ?? [], message),
          outcome.event.status.message,
        );
        yield outcome.event;
        // The SDK persists non-terminal statuses mid-stream on the streaming
        // path but not on `message/send`, so write it here for both. The
        // resume turn does not depend on this — it reads the offering from
        // the x402 store — but `tasks/get` should report input-required
        // rather than the state the task was loaded with.
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
      settlement = outcome.settlement;
    }

    const queue = new AsyncEventQueue<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>();
    const ac = new AbortController();

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
    const clientSupportsCallerContext =
      this.registry
        .getAgent(this.agentId)
        ?.protocolCapabilities?.includes(CALLER_CONTEXT_CAPABILITY) === true;
    const callerResult =
      clientSupportsCallerContext && principalId !== undefined
        ? CallerContextV1.safeParse({ authenticated: { principalId } })
        : undefined;
    const caller = callerResult?.success ? callerResult.data : undefined;
    if (callerResult && !callerResult.success) {
      // Do not put the raw principal or schema details in logs. An invalid
      // transport-owned value is omitted instead of emitting a task.assign
      // frame that the upgraded client would reject wholesale.
      logEvent('caller_context_omitted', {
        agentId: this.agentId,
        taskId,
        reason: 'invalid_authenticated_principal',
      });
    }

    const binding: TaskBinding = {
      agentId: this.agentId,
      taskId,
      contextId,
      sink,
      ...(principalId !== undefined ? { principalId } : {}),
      ...(requestedExtensions !== undefined ? { requestedExtensions } : {}),
    };
    if (!this.registry.bindTask(binding)) {
      // This queue will never be consumed because the binding was rejected.
      // Close it now, and do not publish the AbortController into the task map.
      queue.end();
      const failEvent: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        final: true,
        status: {
          state: TaskState.FAILED,
          timestamp: new Date().toISOString(),
          message: {
            messageId: `${taskId}-owner-mismatch`,
            role: 'agent',
            parts: [{ text: 'task ownership validation failed' }],
            ...terminalErrorMessageFields(
              {
                code: 'task_owner_mismatch',
                message: 'task ownership validation failed',
              },
              requestedExtensions,
            ),
            taskId,
            contextId,
          },
        },
      };
      const terminal =
        gate && settlement
          ? await this.settleTerminal(gate, settlement, failEvent, binding, taskId, contextId)
          : failEvent;
      task.status = terminal.status;
      task.history = appendHistoryMessage(
        appendHistoryMessage(task.history ?? [], message),
        terminal.status.message,
      );
      yield terminal;
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
    this.abortControllers.set(taskId, ac);

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
      ...(caller !== undefined ? { caller } : {}),
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
      // Route through the same terminal handling as any other failure. The
      // agent can disconnect between verify and here, and under `exact` the
      // payer has already been charged by that point — this is what attaches
      // their receipt, records `x402_paid_task_failed`, and releases the
      // offering. Skipping it also left `deferred` offerings uncleared.
      const terminal =
        gate && settlement
          ? await this.settleTerminal(gate, settlement, failEvent, binding, taskId, contextId)
          : failEvent;
      task.status = terminal.status;
      history = appendHistoryMessage(history, terminal.status.message);
      task.history = history;
      this.registry.unbindTask(taskId, binding);
      if (this.abortControllers.get(taskId) === ac) this.abortControllers.delete(taskId);
      yield terminal;
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

    // Observability for the "response arrived but the stream never closed"
    // class: track whether the client ever sent a frame it marked `final`
    // (terminal OR a final non-terminal state like input-required). A stream
    // that closes without ever seeing one ended abnormally (client abort, or a
    // queue closed by something other than a proper terminal) — exactly the
    // shape we want to catch. Emitted once, only for those cases (clean
    // terminals are already covered by ws.ts task_completed/task_failed).
    const streamStartedAt = Date.now();
    let sawFinalEvent = false;

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
        if (event.final) sawFinalEvent = true;
        if (TERMINAL_STATES.has(event.status.state)) {
          // Settle before recording anything: a settlement failure replaces
          // the agent's terminal event outright, and appending the original
          // first would leave both in history.
          const terminal =
            gate && settlement
              ? await this.settleTerminal(gate, settlement, event, binding, taskId, contextId)
              : event;
          // Terminal — mutate task in place so the request-handler's
          // post-stream read reflects the final state.
          history = appendHistoryMessage(history, terminal.status.message);
          task.history = history;
          task.status = terminal.status;
          if (accumulatedArtifacts.length > 0) {
            task.artifacts = accumulatedArtifacts;
          }
          yield terminal;
          break;
        }
        history = appendHistoryMessage(history, event.status.message);
        task.history = history;
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
      if (!sawFinalEvent) {
        // Closed without any client-marked-final frame — abnormal teardown.
        logEvent('task_stream_closed', {
          agentId: this.agentId,
          taskId,
          contextId,
          durationMs: Date.now() - streamStartedAt,
          reason: ac.signal.aborted ? 'aborted' : 'no_final_frame',
          finalState: task.status.state,
          ...(principalId !== undefined ? { principalId } : {}),
        });
      }
      this.registry.unbindTask(taskId, binding);
      if (this.abortControllers.get(taskId) === ac) this.abortControllers.delete(taskId);
    }
  }

  override async cancel(task: Task): Promise<Task> {
    const taskId = task.id;
    const contextId = task.contextId ?? taskId;
    const ac = this.abortControllers.get(taskId);
    const binding = this.registry.getBinding(taskId);

    if (binding && binding.agentId !== this.agentId) {
      logEvent('binding_owner_mismatch', {
        agentId: this.agentId,
        ownerAgentId: binding.agentId,
        taskId,
        operation: 'cancel',
      });
      throw new TaskNotCancelableError('Task cannot be canceled');
    }

    // Notify the connected client so it can abort in-flight work and
    // emit its own task.fail / task.complete frame.
    this.registry.sendToAgent(this.agentId, { type: 'task.cancel', taskId });

    // Deliver the CANCELED terminal through the sink FIRST, then finish the
    // queue: the executor's iterate() consumes the terminal event (breaking on
    // TERMINAL_STATES) and yields it to the client before the stream closes.
    // Aborting first would resolve iterate() with `done` and leave this event
    // buffered-but-unyielded — the stream would close without ever delivering
    // the terminal frame. The ac.abort() below is then only a fallback to
    // unblock a parked executor when there was no binding to deliver through.
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

    if (ac && !ac.signal.aborted) ac.abort();

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
