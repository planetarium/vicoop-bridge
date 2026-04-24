import type { WebSocket } from 'ws';
import type { AgentCard, DownFrame } from '@vicoop-bridge/protocol';
import { encodeFrame } from '@vicoop-bridge/protocol';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';
import { logEvent, truncate } from './log.js';

export interface ClientConnection {
  agentId: string;
  clientId: string;
  ownerWallet: string;
  agentCard: AgentCard;
  allowedCallers: string[];
  ws: WebSocket;
  connectedAt: number;
}

export interface TaskBinding {
  agentId: string;
  taskId: string;
  contextId: string;
  eventBus: ExecutionEventBus;
}

export type CallerChangeListener = (agentId: string, callers: string[]) => void;
// Fires whenever the agent connection (including its embedded agentCard) is
// newly registered, replaced, or removed. Downstream consumers that cache
// objects derived from the card — e.g. the HTTP layer's per-agent
// JsonRpcTransportHandler, which captures `capabilities.streaming` at
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
        existing.ws.close(4009, 'replaced by new connection');
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

  unregisterAgent(agentId: string, ws: WebSocket): void {
    const existing = this.agents.get(agentId);
    if (!existing || existing.ws !== ws) return;
    this.agents.delete(agentId);
    this.notifyAgentChange(agentId);
    for (const binding of [...this.bindings.values()]) {
      if (binding.agentId !== agentId) continue;
      binding.eventBus.publish({
        kind: 'status-update',
        taskId: binding.taskId,
        contextId: binding.contextId,
        final: true,
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            role: 'agent',
            messageId: `${binding.taskId}-disc`,
            parts: [{ kind: 'text', text: 'client disconnected mid-task' }],
            taskId: binding.taskId,
            contextId: binding.contextId,
          },
        },
      });
      binding.eventBus.finished();
      this.bindings.delete(binding.taskId);
    }
  }

  getAgent(agentId: string): ClientConnection | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): ClientConnection[] {
    return [...this.agents.values()];
  }

  bindTask(binding: TaskBinding): void {
    this.bindings.set(binding.taskId, binding);
  }

  getBinding(taskId: string): TaskBinding | undefined {
    return this.bindings.get(taskId);
  }

  unbindTask(taskId: string): void {
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
