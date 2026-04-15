import type { WebSocket } from 'ws';
import type { AgentCard, DownFrame } from '@vicoop-bridge/protocol';
import { encodeFrame } from '@vicoop-bridge/protocol';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';

export interface AdapterConnection {
  agentId: string;
  agentCard: AgentCard;
  ws: WebSocket;
  connectedAt: number;
}

export interface TaskBinding {
  agentId: string;
  taskId: string;
  contextId: string;
  eventBus: ExecutionEventBus;
}

export class Registry {
  private agents = new Map<string, AdapterConnection>();
  private bindings = new Map<string, TaskBinding>();

  registerAgent(conn: AdapterConnection): { ok: true } | { ok: false; reason: string } {
    if (this.agents.has(conn.agentId)) {
      return { ok: false, reason: 'agent already connected' };
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
            parts: [{ kind: 'text', text: 'adapter disconnected mid-task' }],
            taskId: binding.taskId,
            contextId: binding.contextId,
          },
        },
      });
      binding.eventBus.finished();
      this.bindings.delete(binding.taskId);
    }
  }

  getAgent(agentId: string): AdapterConnection | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): AdapterConnection[] {
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

  sendToAgent(agentId: string, frame: DownFrame): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    conn.ws.send(encodeFrame(frame));
    return true;
  }
}
