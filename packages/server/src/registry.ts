import type { WebSocket } from 'ws';
import type { AgentCard, DownFrame, TaskUsage } from '@vicoop-bridge/protocol';
import { encodeFrame } from '@vicoop-bridge/protocol';
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2x/sdk';
import { logEvent, truncate } from './log.js';
import { terminalErrorMessageFields } from './terminal-error.js';
import type { X402Pricing } from './x402/pricing.js';

export interface ClientConnection {
  agentId: string;
  clientId: string;
  ownerPrincipal: string;
  // Owner's email (device-flow registrations); null for SIWE-onboarded clients
  // that only have a wallet principal. Carried for observability/logging.
  ownerEmail?: string | null;
  // Canonical backend kind (e.g. "claude", "codex", "vicoop-codex"); undefined
  // when the client supplied an inline agent card. Used for logging the backend.
  backendKind?: string;
  agentCard: AgentCard;
  allowedCallers: string[];
  // x402 pricing from the agent's DB row, or undefined for a free agent (the
  // default). DB-sourced, never read off the hello frame: `payTo` names the
  // wallet that gets paid, so the same trust boundary applies as to
  // `allowedCallers`.
  x402Pricing?: X402Pricing;
  ws: WebSocket;
  connectedAt: number;
}

/**
 * Sink owned by the executor for a live task. WS frames inbound from the
 * client are translated into `TaskArtifactUpdateEvent`/`TaskStatusUpdateEvent`
 * and pushed here; the executor's `executeStream()` yields from it.
 */
export interface TaskSink {
  pushStatus(event: TaskStatusUpdateEvent): void;
  pushArtifact(event: TaskArtifactUpdateEvent): void;
  finish(): void;
}

export interface TaskBinding {
  agentId: string;
  taskId: string;
  contextId: string;
  sink: TaskSink;
  // principalId of the caller that originated this task (post-auth). Optional
  // because public agents (allowedCallers.length === 0) skip the auth
  // middleware entirely, so there is no verified caller to record. The admin
  // route does not create TaskBindings — it has its own executor
  // (AdminA2XExecutor) that never calls registry.bindTask().
  principalId?: string;
  requestedExtensions?: string[];
  // Diagnostic counter (issue #414): number of liveness-heartbeat `task.status`
  // frames the server has received from the client and pushed to the sink for
  // this task. Surfaced on the terminal log so a router stall can be checked
  // against whether the server was actually forwarding heartbeats (hop 2) — a
  // high count with a stalled router points downstream (updateTask freeze /
  // router), a ~0 count points upstream (client never emitted). Lazily
  // initialized; incremented in ws.ts's `task.status` handler.
  heartbeats?: number;
  // Token consumption reported on the client's `task.complete` frame, stashed
  // here by ws.ts so the executor can price the task without re-deriving it
  // from wire metadata. Server-internal: it is billing input and is never
  // published back onto the A2A event. Set before the terminal status is
  // pushed to the sink, so it is always visible by the time the executor
  // reads the terminal event off the queue.
  usage?: TaskUsage;
}

export type CallerChangeListener = (agentId: string, callers: string[]) => void;
// Fires whenever the agent connection (including its embedded agentCard) is
// newly registered, replaced, or removed. Downstream consumers that cache
// objects derived from the card — e.g. the HTTP layer's per-agent
// A2XServer / DefaultRequestHandler, which captures the card snapshot at
// construction time — must evict on this signal, otherwise a client that
// reconnects with an updated card (say, `streaming: false` → `true`) will
// continue to be served by a transport built against the old card until the
// server restarts. Fires on first registration too so any transient cache
// entry left behind by a previous lifecycle (e.g. a lingering entry from
// before an unclean shutdown) is cleared unconditionally.
export type AgentChangeListener = (agentId: string) => void;

export class Registry {
  private agents = new Map<string, ClientConnection>();
  private bindings = new Map<string, TaskBinding>();
  private callerChangeListeners: CallerChangeListener[] = [];
  private agentChangeListeners: AgentChangeListener[] = [];

  registerAgent(conn: ClientConnection): { ok: true } | { ok: false; reason: string } {
    const existing = this.agents.get(conn.agentId);
    if (existing) {
      if (existing.clientId === conn.clientId) {
        // Two daemons authenticated with the same CLIENT_TOKEN (so they
        // resolve to the same clientId row) and racing to register the
        // same agent. Surface a distinct structured event so fly logs /
        // admin tooling can spot flapping agents independently of the
        // normal client_connected / client_disconnected pair — without
        // this, a duplicate-token loop is indistinguishable from a flaky
        // network in aggregate logs.
        // agentId is user-controlled (hello frame), so truncate before
        // logging — same defense applied in notifyAgentChange below.
        logEvent('client_collision', {
          agentId: truncate(String(conn.agentId), 128),
          clientId: conn.clientId,
          previousConnectedAt: existing.connectedAt,
        });
        // The close `reason` is what the client surfaces in its disconnect
        // log line. Spelling out the cause here means an operator reading
        // the foreground log can recognize the duplicate-token scenario
        // without cross-referencing close codes.
        existing.ws.close(4009, 'another client with the same token connected');
        // Fail the displaced connection's in-flight tasks *before* swapping the
        // map. The old socket's close fires asynchronously and, by the time its
        // unregisterAgent runs, the map already points at `conn` — so the
        // ws-identity guard makes it a no-op and it can't clean these up. Doing
        // it here (while the bindings still belong to the old conn) is the only
        // point that sees them. The new conn hasn't bound any tasks yet, so
        // this only terminates the superseded ones.
        this.failBindingsForAgent(conn.agentId, {
          code: 'superseded',
          message: 'superseded by a reconnect from the same client token',
          messageIdSuffix: 'superseded',
        });
        this.agents.set(conn.agentId, conn);
        this.notifyAgentChange(conn.agentId);
        return { ok: true };
      }
      return { ok: false, reason: 'agent already registered by different client' };
    }
    this.agents.set(conn.agentId, conn);
    this.notifyAgentChange(conn.agentId);
    return { ok: true };
  }

  // Close every live WebSocket whose ClientConnection.clientId matches.
  // Used by the admin-api delete-client path so a daemon whose client row
  // was just deleted sees a distinct close code (4014) and exits without
  // reconnecting. Returns the number of connections closed; callers
  // surface that to the operator as confirmation that an orphan vs a
  // live daemon was deleted.
  //
  // 4014 is the next unused slot in the bridge's WS close-code range:
  //   - 4001-4008 ws.ts (hello timeout, invalid frame, expected hello,
  //     protocol-version mismatch, bad token, registry registration
  //     failed, duplicate hello, agent id not in client allowlist)
  //   - 4009 registry.ts (this file: `another client with the same token
  //     connected` — duplicate-token collision)
  //   - 4010-4011 ws.ts (agent id owned by a different principal,
  //     reserved agent id)
  //   - 4012-4013 card-resolver.ts (missing card-or-backend, unknown
  //     backend kind)
  // Reusing any of those would make the daemon misclassify unrelated
  // handshake failures as deletion and exit instead of backing off.
  //
  // The close itself fires this WS's own `close` handler asynchronously,
  // which in turn calls unregisterAgent and removes the entry from the
  // `agents` map and flushes any bound tasks via the usual disconnect
  // path. We don't pre-delete from `agents` here — letting the close
  // handler do it keeps the in-memory state machine single-sourced.
  disconnectClient(clientId: string): number {
    let closed = 0;
    for (const conn of this.agents.values()) {
      if (conn.clientId !== clientId) continue;
      conn.ws.close(4014, 'client deleted');
      closed++;
    }
    return closed;
  }

  unregisterAgent(agentId: string, ws: WebSocket): void {
    const existing = this.agents.get(agentId);
    if (!existing || existing.ws !== ws) return;
    this.agents.delete(agentId);
    this.notifyAgentChange(agentId);
    this.failBindingsForAgent(agentId, {
      code: 'disconnected',
      message: 'client disconnected mid-task',
      messageIdSuffix: 'disc',
    });
  }

  // Push a terminal `failed` status to every in-flight task bound to this
  // agent, finish its sink, and drop the binding. Both the normal disconnect
  // (unregisterAgent) and the same-token reconnect replacement (registerAgent)
  // funnel through here so an in-flight task is never left without a terminal
  // event — the HTTP stream for that task would otherwise hang forever waiting
  // on AsyncEventQueue.iterate(), since the bound sink's finish() is what
  // closes the iterator. The reconnect path in particular MUST call this
  // explicitly before swapping the agents map: once the map points at the new
  // conn, the old socket's late close handler hits the ws-identity guard in
  // unregisterAgent and early-returns, so it can no longer fail these bindings.
  private failBindingsForAgent(
    agentId: string,
    error: { code: string; message: string; messageIdSuffix: string },
  ): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.agentId !== agentId) continue;
      this.failBinding(binding, error);
      // Identity-guarded: only drop the entry if it is still THIS binding, so a
      // concurrent rebind of the same taskId is never clobbered.
      if (this.bindings.get(binding.taskId) === binding) {
        this.bindings.delete(binding.taskId);
      }
    }
  }

  // Push a terminal `failed` status onto a binding's sink and close it, so the
  // executor consuming that sink's queue observes a terminal event and its
  // executeStream() generator returns (closing the SSE stream) instead of
  // hanging forever on AsyncEventQueue.iterate(). Does NOT touch the bindings
  // map — callers decide whether to delete (disconnect) or overwrite (rebind).
  private failBinding(
    binding: TaskBinding,
    error: { code: string; message: string; messageIdSuffix: string },
  ): void {
    binding.sink.pushStatus({
      taskId: binding.taskId,
      contextId: binding.contextId,
      final: true,
      status: {
        // `failed` is the spec's terminal failure state; mirrors the
        // pre-migration behavior where mid-task client disconnects
        // were surfaced as a failed status with an explanatory message.
        // Cast keeps this file decoupled from the @a2x/sdk TaskState
        // enum value while still emitting the wire-correct string.
        state: 'failed' as never,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${binding.taskId}-${error.messageIdSuffix}`,
          role: 'agent',
          parts: [{ text: error.message }],
          ...terminalErrorMessageFields(
            {
              code: error.code,
              message: error.message,
            },
            binding.requestedExtensions,
          ),
          taskId: binding.taskId,
          contextId: binding.contextId,
        },
      },
    });
    binding.sink.finish();
  }

  getAgent(agentId: string): ClientConnection | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): ClientConnection[] {
    return [...this.agents.values()];
  }

  bindTask(binding: TaskBinding): void {
    // A taskId can be reused across turns (A2A keeps the same taskId for an
    // `input-required` continuation) or arrive on a duplicate/retried request
    // while the prior run is still in flight. If a DIFFERENT live binding
    // already holds this taskId, terminate it first — otherwise the displaced
    // executor's AsyncEventQueue is never closed and its SSE stream hangs
    // forever (the connected client's frames would now route to the new
    // binding). Terminating it emits a `failed` terminal so that stream closes
    // cleanly instead of orphaning.
    const existing = this.bindings.get(binding.taskId);
    if (existing && existing !== binding) {
      logEvent('binding_displaced', {
        agentId: binding.agentId,
        taskId: binding.taskId,
        ...(binding.principalId !== undefined ? { principalId: binding.principalId } : {}),
      });
      this.failBinding(existing, {
        code: 'task_superseded',
        message: 'task superseded by a newer request for the same task id',
        messageIdSuffix: 'superseded',
      });
    }
    this.bindings.set(binding.taskId, binding);
  }

  getBinding(taskId: string): TaskBinding | undefined {
    return this.bindings.get(taskId);
  }

  // Identity-scoped: only remove the entry when it is still the SAME binding
  // this caller installed. A stale executor tearing down (after its awaited
  // taskStore.updateTask) must never delete a newer binding that has since
  // claimed the same taskId — that clobber is what silently drops the new
  // turn's terminal frame and wedges its stream open. Mirrors the ws-identity
  // guard already applied to the agents map in unregisterAgent (issue #365).
  unbindTask(taskId: string, binding: TaskBinding): void {
    if (this.bindings.get(taskId) !== binding) return;
    this.bindings.delete(taskId);
  }

  onCallerChange(listener: CallerChangeListener): void {
    this.callerChangeListeners.push(listener);
  }

  onAgentChange(listener: AgentChangeListener): void {
    this.agentChangeListeners.push(listener);
  }

  updateAllowedCallers(agentId: string, callers: string[]): void {
    const conn = this.agents.get(agentId);
    if (conn) conn.allowedCallers = callers;
    for (const listener of this.callerChangeListeners) {
      listener(agentId, callers);
    }
  }

  /**
   * Apply a pricing change to the live connection.
   *
   * The executor re-reads `x402Pricing` off the connection on every turn, so
   * this alone makes repricing take effect on the next call. It also fires
   * the agent-change signal because the AgentCard advertises the price, and
   * the card (plus the request handler built around it) is cached per agent —
   * without the eviction a repriced agent would keep publishing the old
   * figures until it reconnected.
   *
   * A no-op when the agent is not currently connected: the new pricing is
   * already in the database and will be read at its next hello.
   */
  updateX402Pricing(agentId: string, pricing: X402Pricing | undefined): void {
    const conn = this.agents.get(agentId);
    if (!conn) return;
    if (pricing === undefined) delete conn.x402Pricing;
    else conn.x402Pricing = pricing;
    this.notifyAgentChange(agentId);
  }

  private notifyAgentChange(agentId: string): void {
    for (const listener of this.agentChangeListeners) {
      try {
        listener(agentId);
      } catch (err) {
        // A misbehaving listener must not abort further notifications or
        // corrupt the register/unregister call site. Log through
        // logEvent() so user-controlled agentId (originates in the hello
        // frame and is an unconstrained string at this layer) is JSON-
        // escaped rather than interpolated into a format string — this
        // prevents CRLF log injection. Truncate it too so a pathological
        // client can't inflate each error line unbounded. Preserve the
        // stack when available; fall back to String() for non-Error
        // throws so the log is still actionable.
        logEvent('registry_agent_listener_error', {
          agentId: truncate(String(agentId), 128),
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      }
    }
  }

  sendToAgent(agentId: string, frame: DownFrame): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    conn.ws.send(encodeFrame(frame));
    return true;
  }
}
