import type { WebSocket } from 'ws';
import type { AgentCard, DownFrame } from '@vicoop-bridge/protocol';
import { encodeFrame } from '@vicoop-bridge/protocol';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';

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

export class Registry {
  private agents = new Map<string, ClientConnection>();
  private bindings = new Map<string, TaskBinding>();
  private callerChangeListeners: CallerChangeListener[] = [];

  registerAgent(conn: ClientConnection): { ok: true } | { ok: false; reason: string } {
    const existing = this.agents.get(conn.agentId);
    if (existing) {
      if (existing.clientId === conn.clientId) {
        existing.ws.close(4009, 'replaced by new connection');
        this.agents.set(conn.agentId, conn);
        return { ok: true };
      }
      return { ok: false, reason: 'agent already registered by different client' };
    }
    this.agents.set(conn.agentId, conn);
    return { ok: true };
  }

  unregisterAgent(agentId: string, ws: WebSocket): void {
    const existing = this.agents.get(agentId);
    if (!existing || existing.ws !== ws) return;
    this.agents.delete(agentId);
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

  updateAllowedCallers(agentId: string, callers: string[]): void {
    const normalized = callers.map((c) => c.toLowerCase());
    const conn = this.agents.get(agentId);
    if (conn) conn.allowedCallers = normalized;
    for (const listener of this.callerChangeListeners) {
      listener(agentId, callers);
    }
  }

  sendToAgent(agentId: string, frame: DownFrame): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    conn.ws.send(encodeFrame(frame));
    return true;
  }
}
