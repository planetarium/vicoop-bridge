import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  encodeFrame,
  parseDownFrame,
  type AgentCard,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { AdapterBackend } from './backend.js';

export interface AdapterClientOptions {
  relayUrl: string;
  token: string;
  agentId: string;
  agentCard: AgentCard;
  backend: AdapterBackend;
  maxConcurrency?: number;
  reconnectDelayMs?: number;
}

export class AdapterClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private inflight = new Map<string, AbortController>();

  constructor(private readonly opts: AdapterClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.opts.relayUrl.replace(/\/$/, '')}/connect`);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[adapter] connected, sending hello');
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
        console.error('[adapter] invalid frame:', err);
        return;
      }

      switch (frame.type) {
        case 'task.assign':
          this.runTask(frame);
          break;
        case 'task.cancel':
          this.inflight.get(frame.taskId)?.abort();
          void this.opts.backend.cancel(frame.taskId);
          break;
        case 'ping':
          this.send({ type: 'pong' });
          break;
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[adapter] disconnected: ${code} ${reason.toString()}`);
      this.ws = null;
      if (!this.stopped) {
        const delay = this.opts.reconnectDelayMs ?? 3000;
        setTimeout(() => this.connect(), delay);
      }
    });

    ws.on('error', (err) => {
      console.error('[adapter] ws error:', err.message);
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
      await this.opts.backend.handle(frame, (f) => this.send(f));
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
