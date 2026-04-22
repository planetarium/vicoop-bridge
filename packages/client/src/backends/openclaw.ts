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

type FinalizerCause = 'gateway_closed' | 'timeout';

type FinalizerEvent = ChatEventPayload & { cause?: FinalizerCause };

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
  private closeListeners = new Set<(err: Error) => void>();
  private _state: ClientState = 'idle';
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private nonce: string | null = null;
  private identity: DeviceIdentity;

  constructor(
    private readonly url: string,
    private readonly token?: string,
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

  onClose(listener: (err: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
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
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    this.eventHandlers.clear();
    for (const l of listeners) {
      try {
        l(err);
      } catch (listenerErr) {
        console.error('[openclaw] close listener threw:', (listenerErr as Error).message);
      }
    }
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
  /** Max time (ms) to wait for a terminal chat event after chat.send ack. Default 600000 (10min). */
  taskTimeoutMs?: number;
}

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export function createOpenclawBackend(
  opts: OpenclawBackendOptions = {},
): Backend {
  const url = opts.url ?? process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18789';
  const token = opts.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const agent = opts.agent ?? process.env.OPENCLAW_AGENT ?? 'main';
  const thinking = opts.thinking ?? process.env.OPENCLAW_THINKING;
  const sessionPrefix = opts.sessionKeyPrefix ?? 'agent';
  const debug = opts.debug ?? process.env.OPENCLAW_DEBUG === '1';
  const envTimeout = process.env.OPENCLAW_TASK_TIMEOUT_MS
    ? Number(process.env.OPENCLAW_TASK_TIMEOUT_MS)
    : undefined;
  const taskTimeoutMs = opts.taskTimeoutMs ?? (Number.isFinite(envTimeout) ? (envTimeout as number) : DEFAULT_TASK_TIMEOUT_MS);

  let current: GatewayClient | null = null;
  let connecting: Promise<GatewayClient> | null = null;
  const runToTask = new Map<string, { taskId: string; sessionKey: string }>();
  const taskFinalizers = new Map<string, (evt: FinalizerEvent) => void>();
  const pendingRunEvents = new Map<string, ChatEventPayload[]>();
  // Bounded memory of recently-finalized runIds. Any chat event carrying one
  // of these is dropped instead of buffered in pendingRunEvents, so late or
  // duplicate deltas from OpenClaw cannot accumulate forever after the task
  // has already emitted its terminal frame.
  const recentlyFinalizedRuns = new Set<string>();
  const MAX_FINALIZED_RUNS = 512;
  const MAX_BUFFERED_EVENTS_PER_RUN = 64;

  function markRunFinalized(runId: string): void {
    if (recentlyFinalizedRuns.has(runId)) return;
    recentlyFinalizedRuns.add(runId);
    if (recentlyFinalizedRuns.size > MAX_FINALIZED_RUNS) {
      const oldest = recentlyFinalizedRuns.values().next().value;
      if (oldest !== undefined) recentlyFinalizedRuns.delete(oldest);
    }
  }

  function handleGatewayClose(c: GatewayClient, err: Error): void {
    console.error('[openclaw] connection error:', err.message);
    if (current === c) current = null;
    // Drop any orphaned event buffers and finalization memory — runIds are
    // scoped to a single gateway session, so a reconnect starts clean.
    pendingRunEvents.clear();
    recentlyFinalizedRuns.clear();
    // Fail every in-flight task that was running on this client so handle()
    // does not hang forever waiting for a terminal event that can never come.
    if (taskFinalizers.size === 0) return;
    for (const fin of Array.from(taskFinalizers.values())) {
      fin({
        runId: '',
        sessionKey: '',
        seq: -1,
        state: 'error',
        errorMessage: `gateway closed: ${err.message}`,
        cause: 'gateway_closed',
      });
    }
  }

  async function ensureConnected(): Promise<GatewayClient> {
    if (current && current.state === 'ready') return current;
    if (connecting) return connecting;
    const c = new GatewayClient(url, token);
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
          if (!binding) {
            // Late or duplicate event for a run whose task already finalized:
            // drop without buffering so memory stays bounded.
            if (recentlyFinalizedRuns.has(p.runId)) return;
            // Event arrived before handle() finished registering the runId.
            // Buffer until the handler catches up and drains it.
            const buf = pendingRunEvents.get(p.runId) ?? [];
            if (buf.length >= MAX_BUFFERED_EVENTS_PER_RUN) buf.shift();
            buf.push(p);
            pendingRunEvents.set(p.runId, buf);
            return;
          }
          taskFinalizers.get(binding.taskId)?.(p);
        });
        c.onClose((err) => handleGatewayClose(c, err));
        current = c;
        return c;
      } catch (err) {
        // connect() itself failed: nothing is registered yet, just propagate.
        throw err;
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

      // Register the finalizer BEFORE sending chat.send so that:
      //   1. a gateway close between send and ack still fails this task,
      //   2. a fast terminal event arriving before runId is known is buffered.
      let resolveSettled!: (evt: FinalizerEvent) => void;
      const settled = new Promise<FinalizerEvent>((r) => {
        resolveSettled = r;
      });
      const finalizer = (evt: FinalizerEvent) => {
        if (evt.state === 'final' || evt.state === 'error' || evt.state === 'aborted') {
          resolveSettled(evt);
        }
      };
      taskFinalizers.set(task.taskId, finalizer);

      let runId: string | null = null;
      const timer = setTimeout(() => {
        resolveSettled({
          runId: runId ?? '',
          sessionKey,
          seq: -1,
          state: 'error',
          errorMessage: `task timed out after ${taskTimeoutMs}ms`,
          cause: 'timeout',
        });
      }, taskTimeoutMs);
      timer.unref?.();

      try {
        let ack: ChatSendAck;
        try {
          ack = await gw.request<ChatSendAck>('chat.send', {
            sessionKey,
            message: text,
            idempotencyKey: task.taskId,
            ...(thinking ? { thinking } : {}),
          });
        } catch (err) {
          // A close between send and ack rejects the pending request AND
          // resolves `settled` via the close listener. Since we bail out
          // here without awaiting `settled`, surface the gateway-closed
          // cause directly so the caller gets a precise error code.
          const closed = gw.state === 'closed';
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: closed ? 'gateway_closed' : 'gateway_send_failed',
              message: (err as Error).message,
            },
          });
          return;
        }

        runId = ack.runId;
        runToTask.set(runId, { taskId: task.taskId, sessionKey });
        // Drain any events that raced ahead of registration.
        const buffered = pendingRunEvents.get(runId);
        if (buffered) {
          pendingRunEvents.delete(runId);
          for (const p of buffered) finalizer(p);
        }

        const result = await settled;

        if (result.cause === 'timeout') {
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'task_timeout',
              message: result.errorMessage ?? 'task timed out',
            },
          });
          return;
        }
        if (result.cause === 'gateway_closed') {
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'gateway_closed',
              message: result.errorMessage ?? 'gateway closed',
            },
          });
          return;
        }
        if (result.state === 'error') {
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'gateway_chat_error',
              message: result.errorMessage ?? 'unknown gateway error',
            },
          });
          return;
        }
        if (result.state === 'aborted') {
          emit({
            type: 'task.complete',
            taskId: task.taskId,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          });
          return;
        }

        const text2 = extractFinalText(result.message);
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
      } finally {
        clearTimeout(timer);
        taskFinalizers.delete(task.taskId);
        if (runId) {
          runToTask.delete(runId);
          pendingRunEvents.delete(runId);
          markRunFinalized(runId);
        }
      }
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
