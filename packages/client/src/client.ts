import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  encodeFrame,
  parseDownFrame,
  type AgentCard,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend } from './backend.js';

export interface ClientOptions {
  serverUrl: string;
  token: string;
  agentId: string;
  agentCard: AgentCard;
  backend: Backend;
  maxConcurrency?: number;
  reconnectDelayMs?: number;
}

export class Client {
  private ws: WebSocket | null = null;
  private stopped = false;
  private inflight = new Map<string, AbortController>();

  constructor(private readonly opts: ClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    // Abort all inflight tasks so backends can unwind cleanly instead of
    // running to completion after the WS is gone.
    for (const controller of this.inflight.values()) controller.abort();
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.opts.serverUrl.replace(/\/$/, '')}/connect`);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[client] connected, sending hello');
      this.send({
        type: 'hello',
        agentId: this.opts.agentId,
        agentCard: this.opts.agentCard,
        version: PROTOCOL_VERSION,
        token: this.opts.token,
      });
    });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = parseDownFrame(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch (err) {
        console.error('[client] invalid frame:', err);
        return;
      }

      switch (frame.type) {
        case 'task.assign':
          this.runTask(frame);
          break;
        case 'task.cancel':
          this.inflight.get(frame.taskId)?.abort();
          break;
        case 'ping':
          this.send({ type: 'pong' });
          break;
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[client] disconnected: ${code} ${reason.toString()}`);
      this.ws = null;
      if (!this.stopped) {
        const delay = this.opts.reconnectDelayMs ?? 3000;
        setTimeout(() => this.connect(), delay);
      }
    });

    ws.on('error', (err) => {
      console.error('[client] ws error:', err.message);
    });
  }

  private send(frame: UpFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(frame));
  }

  private async runTask(frame: import('@vicoop-bridge/protocol').DownFrame): Promise<void> {
    if (frame.type !== 'task.assign') return;
    const controller = new AbortController();
    this.inflight.set(frame.taskId, controller);
    try {
      await this.opts.backend.handle(frame, (f) => this.send(f), controller.signal);
    } catch (err) {
      this.send({
        type: 'task.fail',
        taskId: frame.taskId,
        error: {
          code: 'backend_error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      this.inflight.delete(frame.taskId);
    }
  }
}
