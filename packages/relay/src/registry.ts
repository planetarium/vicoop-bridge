import type { WebSocket } from 'ws';
import type {
  AgentCard,
  Artifact,
  DownFrame,
  Message,
  TaskStatus,
} from '@vicoop-bridge/protocol';
import { encodeFrame } from '@vicoop-bridge/protocol';

export interface AdapterConnection {
  agentId: string;
  agentCard: AgentCard;
  ws: WebSocket;
  connectedAt: number;
}

export interface TaskRecord {
  id: string;
  contextId: string;
  agentId: string;
  status: TaskStatus;
  history: Message[];
  artifacts: Artifact[];
  resolve: (task: TaskRecord) => void;
  reject: (err: Error) => void;
  done: Promise<TaskRecord>;
  settled: boolean;
}

export class Registry {
  private agents = new Map<string, AdapterConnection>();
  private tasks = new Map<string, TaskRecord>();

  registerAgent(conn: AdapterConnection): { ok: true } | { ok: false; reason: string } {
    if (this.agents.has(conn.agentId)) {
      return { ok: false, reason: 'agent already connected' };
    }
    this.agents.set(conn.agentId, conn);
    return { ok: true };
  }

  unregisterAgent(agentId: string, ws: WebSocket): void {
    const existing = this.agents.get(agentId);
    if (existing && existing.ws === ws) {
      this.agents.delete(agentId);
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId && !task.settled) {
          this.failTask(task.id, 'adapter_disconnected', 'adapter disconnected mid-task');
        }
      }
    }
  }

  getAgent(agentId: string): AdapterConnection | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): AdapterConnection[] {
    return [...this.agents.values()];
  }

  createTask(params: {
    id: string;
    contextId: string;
    agentId: string;
    initialMessage: Message;
  }): TaskRecord {
    let resolve!: (t: TaskRecord) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<TaskRecord>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: TaskRecord = {
      id: params.id,
      contextId: params.contextId,
      agentId: params.agentId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [params.initialMessage],
      artifacts: [],
      resolve,
      reject,
      done,
      settled: false,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = status;
    if (status.message) t.history.push(status.message);
  }

  addArtifact(taskId: string, artifact: Artifact): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const existing = t.artifacts.findIndex((a) => a.artifactId === artifact.artifactId);
    if (existing >= 0) {
      t.artifacts[existing] = {
        ...t.artifacts[existing],
        parts: [...t.artifacts[existing].parts, ...artifact.parts],
      };
    } else {
      t.artifacts.push(artifact);
    }
  }

  completeTask(taskId: string, status: TaskStatus): void {
    const t = this.tasks.get(taskId);
    if (!t || t.settled) return;
    t.status = status;
    if (status.message) t.history.push(status.message);
    t.settled = true;
    t.resolve(t);
  }

  failTask(taskId: string, code: string, message: string): void {
    const t = this.tasks.get(taskId);
    if (!t || t.settled) return;
    t.status = {
      state: 'failed',
      timestamp: new Date().toISOString(),
      message: {
        role: 'agent',
        messageId: `${taskId}-err`,
        parts: [{ kind: 'text', text: `${code}: ${message}` }],
      },
    };
    t.settled = true;
    t.resolve(t);
  }

  sendToAgent(agentId: string, frame: DownFrame): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    conn.ws.send(encodeFrame(frame));
    return true;
  }
}
