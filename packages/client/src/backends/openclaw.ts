import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import WebSocket from 'ws';
import type { Part } from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';

const GATEWAY_PROTOCOL_VERSION = 3;

interface DeviceIdentity {
  deviceId: string;
  publicKeyRawB64Url: string;
  privateKeyPem: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  const deviceId = createHash('sha256').update(rawPub).digest('hex');
  return {
    deviceId,
    publicKeyRawB64Url: b64url(rawPub),
    privateKeyPem: (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString(),
  };
}

function buildDeviceAuthPayload(p: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce: string;
}): string {
  return [
    'v2',
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(','),
    String(p.signedAtMs),
    p.token ?? '',
    p.nonce,
  ].join('|');
}

function signPayload(privateKeyPem: string, payload: string): string {
  const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKeyPem);
  return b64url(sig);
}

interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}
interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}
interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}
type Frame = RequestFrame | ResponseFrame | EventFrame;

interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
}

interface ChatSendAck {
  runId: string;
  status: 'started' | 'in_flight';
}

type EventHandler = (evt: EventFrame) => void;

type ClientState = 'idle' | 'connecting' | 'ready' | 'closed';

class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Set<EventHandler>();
  private _state: ClientState = 'idle';
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private nonce: string | null = null;
  private identity: DeviceIdentity;

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly onError?: (err: Error) => void,
  ) {
    this.identity = generateDeviceIdentity();
  }

  get state(): ClientState {
    return this._state;
  }

  connect(): Promise<void> {
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'connecting') return this.readyPromise!;
    if (this._state === 'closed') {
      return Promise.reject(new Error('gateway client closed'));
    }

    this._state = 'connecting';
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('message', (raw) => this.handleMessage(raw));
    ws.on('close', () => this.onClosed(new Error('gateway websocket closed')));
    ws.on('error', (err) => this.onClosed(err as Error));

    return this.readyPromise;
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('gateway not connected');
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: 'req', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  private handleMessage(raw: WebSocket.RawData | string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Frame;
    } catch {
      return;
    }
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      const p = frame.payload as { nonce?: string } | undefined;
      this.nonce = p?.nonce?.trim() ?? null;
      if (!this.nonce) {
        this.abortWith(new Error('gateway sent empty connect nonce'));
        return;
      }
      void this.sendConnect();
      return;
    }
    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new Error(frame.error?.message ?? 'gateway error'));
      return;
    }
    if (frame.type === 'event') {
      for (const h of this.eventHandlers) h(frame);
    }
  }

  private onClosed(err: Error): void {
    if (this._state === 'closed') return;
    const wasConnecting = this._state === 'connecting';
    this._state = 'closed';
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (wasConnecting) this.readyReject?.(err);
    this.readyResolve = null;
    this.readyReject = null;
    this.ws = null;
    this.onError?.(err);
  }

  private abortWith(err: Error): void {
    this.ws?.close();
    this.onClosed(err);
  }

  private async sendConnect(): Promise<void> {
    try {
      const role = 'operator';
      const clientId = 'gateway-client';
      const clientMode = 'backend';
      const scopes = ['operator.admin', 'operator.write', 'operator.read'];
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: this.identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: this.token,
        nonce: this.nonce!,
      });
      const signature = signPayload(this.identity.privateKeyPem, payload);
      const params = {
        minProtocol: GATEWAY_PROTOCOL_VERSION,
        maxProtocol: GATEWAY_PROTOCOL_VERSION,
        client: {
          id: clientId,
          displayName: 'vicoop-bridge-client',
          version: '0.0.0',
          platform: process.platform,
          mode: clientMode,
        },
        caps: [],
        role,
        scopes,
        auth: this.token ? { token: this.token } : undefined,
        device: {
          id: this.identity.deviceId,
          publicKey: this.identity.publicKeyRawB64Url,
          signature,
          signedAt: signedAtMs,
          nonce: this.nonce!,
        },
      };
      await this.request('connect', params);
      if (this._state === 'connecting') {
        this._state = 'ready';
        this.readyResolve?.();
      }
    } catch (err) {
      this.abortWith(err as Error);
    }
  }
}

function extractFinalText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as Record<string, unknown>;
  // common shapes seen across openclaw internals
  if (typeof m.text === 'string') return m.text;
  if (typeof m.body === 'string') return m.body;
  if (typeof m.Body === 'string') return m.Body as string;
  if (Array.isArray(m.parts)) {
    return (m.parts as Array<{ text?: string }>)
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('');
  }
  if (Array.isArray(m.content)) {
    return (m.content as Array<{ text?: string; type?: string }>)
      .filter((c) => c?.type === 'text' || typeof c?.text === 'string')
      .map((c) => c?.text ?? '')
      .join('');
  }
  return '';
}

export interface OpenclawBackendOptions {
  url?: string;
  token?: string;
  agent?: string;
  thinking?: string;
  sessionKeyPrefix?: string;
  debug?: boolean;
}

export function createOpenclawBackend(
  opts: OpenclawBackendOptions = {},
): Backend {
  const url = opts.url ?? process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18789';
  const token = opts.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const agent = opts.agent ?? process.env.OPENCLAW_AGENT ?? 'main';
  const thinking = opts.thinking ?? process.env.OPENCLAW_THINKING;
  const sessionPrefix = opts.sessionKeyPrefix ?? 'agent';
  const debug = opts.debug ?? process.env.OPENCLAW_DEBUG === '1';

  let current: GatewayClient | null = null;
  let connecting: Promise<GatewayClient> | null = null;
  const runToTask = new Map<string, { taskId: string; sessionKey: string }>();
  const taskFinalizers = new Map<string, (evt: ChatEventPayload) => void>();

  async function ensureConnected(): Promise<GatewayClient> {
    if (current && current.state === 'ready') return current;
    if (connecting) return connecting;
    const c = new GatewayClient(url, token, (err) => {
      console.error('[openclaw] connection error:', err.message);
      if (current === c) current = null;
    });
    connecting = (async () => {
      try {
        await c.connect();
        console.log(`[openclaw] connected ${url}`);
        c.onEvent((evt) => {
          if (evt.event !== 'chat') return;
          const p = evt.payload as ChatEventPayload | undefined;
          if (!p?.runId) return;
          if (debug) {
            console.log('[openclaw] chat event:', JSON.stringify(p).slice(0, 500));
          }
          const binding = runToTask.get(p.runId);
          if (!binding) return;
          taskFinalizers.get(binding.taskId)?.(p);
        });
        current = c;
        return c;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  return {
    name: 'openclaw',

    async handle(task, emit) {
      const gw = await ensureConnected();
      const sessionKey = `${sessionPrefix}:${agent}:${task.contextId}`;
      const text = task.message.parts
        .map((p) => (p.kind === 'text' ? p.text : ''))
        .join('\n')
        .trim();

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      const idempotencyKey = task.taskId;
      let ack: ChatSendAck;
      try {
        ack = await gw.request<ChatSendAck>('chat.send', {
          sessionKey,
          message: text,
          idempotencyKey,
          ...(thinking ? { thinking } : {}),
        });
      } catch (err) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: 'gateway_send_failed', message: (err as Error).message },
        });
        return;
      }

      const runId = ack.runId;
      runToTask.set(runId, { taskId: task.taskId, sessionKey });

      const settled = await new Promise<ChatEventPayload>((resolve) => {
        taskFinalizers.set(task.taskId, (evt) => {
          if (evt.state === 'final' || evt.state === 'error' || evt.state === 'aborted') {
            resolve(evt);
          }
        });
      });

      taskFinalizers.delete(task.taskId);
      runToTask.delete(runId);

      if (settled.state === 'error') {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: {
            code: 'gateway_chat_error',
            message: settled.errorMessage ?? 'unknown gateway error',
          },
        });
        return;
      }
      if (settled.state === 'aborted') {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      const text2 = extractFinalText(settled.message);
      const parts: Part[] = [{ kind: 'text', text: text2 }];
      const artifactId = randomUUID();
      emit({
        type: 'task.artifact',
        taskId: task.taskId,
        artifact: { artifactId, name: 'openclaw-result', parts },
        lastChunk: true,
      });
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            messageId: randomUUID(),
            parts,
          },
        },
      });
    },

    async cancel(taskId) {
      const entry = [...runToTask.entries()].find(([, v]) => v.taskId === taskId);
      if (!entry || !current) return;
      const [runId, binding] = entry;
      try {
        await current.request('chat.abort', { sessionKey: binding.sessionKey, runId });
      } catch (err) {
        console.error('[openclaw] abort failed:', (err as Error).message);
      }
    },
  };
}
