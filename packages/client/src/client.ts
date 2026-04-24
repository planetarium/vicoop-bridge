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
  // Resolved once per process via backend.resolveCapabilities(); the bridge
  // hello frame is held until this settles so the advertised card matches the
  // backend's actual upstream capability. Cached across reconnects so we
  // don't re-probe on every bridge WS reconnect — the underlying upstream
  // doesn't change mid-process.
  private effectiveCardPromise: Promise<AgentCard> | null = null;

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

  private resolveEffectiveCard(): Promise<AgentCard> {
    if (this.effectiveCardPromise) return this.effectiveCardPromise;
    const base = this.opts.agentCard;
    const probe = this.opts.backend.resolveCapabilities;
    if (!probe) {
      this.effectiveCardPromise = Promise.resolve(base);
      return this.effectiveCardPromise;
    }
    this.effectiveCardPromise = (async () => {
      try {
        const detected = await probe.call(this.opts.backend);
        const merged: AgentCard['capabilities'] = {
          ...(base.capabilities ?? {}),
          ...(detected.streaming !== undefined ? { streaming: detected.streaming } : {}),
          ...(detected.pushNotifications !== undefined
            ? { pushNotifications: detected.pushNotifications }
            : {}),
        };
        return { ...base, capabilities: merged };
      } catch (err) {
        console.warn(
          `[client] backend capability probe threw (${err instanceof Error ? err.message : String(err)}); using declared card capabilities`,
        );
        return base;
      }
    })();
    return this.effectiveCardPromise;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.opts.serverUrl.replace(/\/$/, '')}/connect`);
    this.ws = ws;

    ws.on('open', () => {
      // The probe runs in parallel with the bridge TCP/WS handshake; by the
      // time `open` fires it's usually already settled. Awaiting here means
      // the bridge-server sees a card whose capabilities match what the
      // backend can actually deliver. If the probe is still running (slow
      // gateway handshake), `hello` is delayed by the difference — typically
      // a few ms on a local loopback gateway.
      this.resolveEffectiveCard().then((agentCard) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        console.log('[client] connected, sending hello');
        this.send({
          type: 'hello',
          agentId: this.opts.agentId,
          agentCard,
          version: PROTOCOL_VERSION,
          token: this.opts.token,
        });
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
