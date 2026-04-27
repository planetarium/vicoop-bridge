import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { Part } from '@vicoop-bridge/protocol';
import type { Backend } from '../backend.js';

const execFileP = promisify(execFile);

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

// OpenClaw broadcasts this on every `emitSessionTranscriptUpdate` to
// connections that called `sessions.messages.subscribe` for the sessionKey.
// The `message` field is the full assistant/user/tool entry that was appended
// to the transcript — not a token delta. We use it to drive message-boundary
// A2A artifact streaming in lieu of true per-token deltas (which only reach
// `role:"node"` clients subscribed via `chat.subscribe` node events today).
interface SessionMessageEventPayload {
  sessionKey: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
}

type FinalizerCause = 'gateway_closed' | 'timeout' | 'abort_failed';

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
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly handshakeTimeoutMs: number = 10_000,
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

    // Bound the handshake so a gateway that accepts the TCP connection but
    // never finishes the challenge/connect exchange cannot wedge every
    // subsequent ensureConnected() caller.
    this.handshakeTimer = setTimeout(() => {
      if (this._state === 'connecting') {
        this.abortWith(new Error(`gateway handshake timed out after ${this.handshakeTimeoutMs}ms`));
      }
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();

    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('close', () => this.onClosed(new Error('gateway websocket closed')));
      ws.on('error', (err) => this.onClosed(err as Error));
    } catch (err) {
      // `new WebSocket(url)` can throw synchronously for things like an
      // invalid URL. Without this guard, _state would stay 'connecting'
      // and the handshake timer would fire later against a dead promise.
      this.onClosed(err as Error);
    }

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
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        // Synchronous send failure (socket transitioned out of OPEN between
        // the readyState check and ws.send). Clean up the pending entry so
        // it cannot linger and be double-rejected later by onClosed().
        this.pending.delete(id);
        reject(err as Error);
      }
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
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
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
          version: '0.4.2',
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
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
        this.readyResolve?.();
      }
    } catch (err) {
      this.abortWith(err as Error);
    }
  }
}

// Map A2A message parts to OpenClaw's `chat.send` input shape
// (`message` + `attachments`). The gateway accepts image attachments via
// `{ type, mimeType, fileName, content }` where `content` is a base64
// string; non-image MIME types are dropped with a warning inside OpenClaw,
// and there is no native surface for structured data or remote URIs.
//
// Rather than silently drop non-text parts (the prior behavior), we reject
// anything we can't represent so callers see a specific error code
// instead of a lossy request.
interface OpenclawChatInput {
  message: string;
  attachments: Array<{
    type: 'image';
    mimeType: string;
    fileName?: string;
    content: string;
  }>;
}

interface PartMappingError {
  code: string;
  message: string;
}

function isImageMime(mime: string | undefined): mime is string {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

// Exported for unit testing; shape matches what `handle()` feeds into
// `chat.send` (minus `sessionKey` / `idempotencyKey` / `thinking`).
export function mapPartsToChatInput(
  parts: Part[],
): { ok: true; input: OpenclawChatInput } | { ok: false; error: PartMappingError } {
  const textBits: string[] = [];
  const attachments: OpenclawChatInput['attachments'] = [];
  for (const [idx, p] of parts.entries()) {
    if (p.kind === 'text') {
      textBits.push(p.text);
      continue;
    }
    if (p.kind === 'file') {
      const f = p.file;
      // uri requires fetching and may need caller auth — out of scope for
      // this backend. Reject explicitly so callers know to inline bytes.
      if (f.uri !== undefined) {
        return {
          ok: false,
          error: {
            code: 'unsupported_file_uri',
            message: `part[${idx}]: file.uri is not supported by the openclaw backend; inline the file as base64 bytes instead`,
          },
        };
      }
      if (f.bytes === undefined) {
        return {
          ok: false,
          error: {
            code: 'invalid_file_part',
            message: `part[${idx}]: file part must carry either bytes or uri`,
          },
        };
      }
      if (!isImageMime(f.mimeType)) {
        return {
          ok: false,
          error: {
            code: 'unsupported_file_mime',
            message: `part[${idx}]: only image/* mimeTypes are supported by the openclaw backend (got ${f.mimeType ?? 'unset'})`,
          },
        };
      }
      attachments.push({
        type: 'image',
        mimeType: f.mimeType,
        ...(f.name !== undefined ? { fileName: f.name } : {}),
        content: f.bytes,
      });
      continue;
    }
    if (p.kind === 'data') {
      return {
        ok: false,
        error: {
          code: 'unsupported_data_part',
          message: `part[${idx}]: data parts are not supported by the openclaw backend; serialize to a text part if the agent should see structured input`,
        },
      };
    }
  }
  return {
    ok: true,
    input: {
      message: textBits.join('\n').trim(),
      attachments,
    },
  };
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
  /** Max time (ms) to wait for the gateway handshake to complete. Default 10000. */
  handshakeTimeoutMs?: number;
  /**
   * Override the default process-based port discovery used on connect
   * failure. Returns candidate WebSocket URLs (ws:// or wss://) to try.
   * Primarily for testing.
   */
  discoverGatewayUrls?: () => Promise<string[]>;
}

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10 * 1000;
const DEFAULT_DISCOVERY_PROCESS_NAME = 'openclaw';
const DEFAULT_DISCOVERY_HANDSHAKE_TIMEOUT_MS = 3_000;
const DISCOVERY_LSOF_TIMEOUT_MS = 2_000;

export interface DiscoveredListener {
  host: string;
  port: number;
}

// Parses `lsof -nP -iTCP -sTCP:LISTEN` output and returns listeners bound to
// loopback or wildcard. The original bind host is preserved so callers can
// distinguish IPv4/IPv6/wildcard binds. Exported for unit testing.
export function parseLsofListeningPorts(output: string): DiscoveredListener[] {
  const out: DiscoveredListener[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    // NAME column (last) for LISTEN rows looks like "127.0.0.1:3000 (LISTEN)"
    // or "*:18789 (LISTEN)" or "[::1]:3000 (LISTEN)".
    const m = line.match(/\s(\S+):(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    const host = m[1];
    const loopback =
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '*' ||
      host === '0.0.0.0' ||
      host === '[::]';
    if (!loopback) continue;
    const port = Number(m[2]);
    if (!Number.isFinite(port) || port <= 0) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, port });
  }
  return out;
}

function buildCandidateUrl(template: URL, host: '127.0.0.1' | '::1', port: number): string {
  // Reconstruct from parts so protocol (ws/wss), user-info, pathname, search,
  // and hash are all preserved while only host+port get swapped. Preserving
  // user-info matters when the configured URL carries credentials
  // (ws://user:pass@host:port) — dropping them would make the retry fail even
  // on the right port.
  //
  // Why not just clone the URL and set `.hostname`? Node's WHATWG URL setter
  // silently refuses to swap an IPv4 hostname for `::1` (and vice versa),
  // leaving the original host in place — so that approach would quietly lose
  // the v6 candidate. Reconstructing via string interpolation is safe
  // because `template.username` / `template.password` are exposed in their
  // already-percent-encoded form by the URL parser, so special characters
  // (e.g. `@`, `:`) in credentials round-trip correctly.
  const h = host === '::1' ? '[::1]' : host;
  const userInfo =
    template.username !== '' || template.password !== ''
      ? `${template.username}${template.password !== '' ? `:${template.password}` : ''}@`
      : '';
  return `${template.protocol}//${userInfo}${h}:${port}${template.pathname}${template.search}${template.hash}`;
}

// Expand a bind host + port into ws:// candidate URLs derived from `template`
// (preserves scheme/path/search/hash — only host+port change). IPv4 binds
// (`127.0.0.1`, `0.0.0.0`, `*`) map to IPv4 loopback; `[::1]` stays on IPv6
// loopback. The IPv6 wildcard (`[::]`) is the only bind that expands to both
// families, since a dual-stack listener is reachable via either 127.0.0.1 or
// [::1] depending on how the client connects.
export function listenersToGatewayUrls(
  listeners: DiscoveredListener[],
  template: string,
): string[] {
  let tpl: URL;
  try {
    tpl = new URL(template);
  } catch {
    return [];
  }
  const urls = new Set<string>();
  for (const { host, port } of listeners) {
    if (host === '127.0.0.1' || host === '0.0.0.0' || host === '*') {
      urls.add(buildCandidateUrl(tpl, '127.0.0.1', port));
    } else if (host === '[::1]') {
      urls.add(buildCandidateUrl(tpl, '::1', port));
    } else if (host === '[::]') {
      urls.add(buildCandidateUrl(tpl, '127.0.0.1', port));
      urls.add(buildCandidateUrl(tpl, '::1', port));
    }
  }
  return Array.from(urls);
}

async function discoverLocalGatewayUrls(processName: string, template: string): Promise<string[]> {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileP(
      'lsof',
      // `-a` AND-s the selectors below; without it lsof OR-s them and returns
      // every LISTEN socket on the host plus every file handle owned by the
      // target process, which produces false candidates and extra latency.
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-c', processName],
      { timeout: DISCOVERY_LSOF_TIMEOUT_MS },
    );
    return listenersToGatewayUrls(parseLsofListeningPorts(stdout), template);
  } catch {
    return [];
  }
}

function sameGatewayUrl(a: string, b: string): boolean {
  // Used to avoid re-trying the already-failed primary URL. Err on the side
  // of "different → try it": if any of protocol, host, port, pathname,
  // search, or user-info differs, treat the candidate as distinct. That way
  // an injected discover returning the same host/port with (say) a different
  // token query or path still gets attempted — the primary may have failed
  // precisely because of that component.
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol === ub.protocol &&
      ua.hostname === ub.hostname &&
      ua.port === ub.port &&
      ua.pathname === ub.pathname &&
      ua.search === ub.search &&
      ua.username === ub.username &&
      ua.password === ub.password
    );
  } catch {
    return a === b;
  }
}

// Defensive error-to-string: catch clauses receive `unknown`, so a rejection
// with `null`, a plain object, or a primitive would crash the logging path
// that tries to read `.message`. Always return a string suitable for logs
// without throwing.
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
}

// Strip query, hash, and user-info from a gateway URL before logging so
// credentials embedded in a token query param (or userinfo) don't leak into
// stdout. Keeps protocol + host + port + pathname, which is what operators
// actually need to diagnose a connect failure. Exported for unit testing.
export function redactUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}`;
  } catch {
    return '<unparseable-url>';
  }
}

// Discovery is only attempted when the configured URL targets the local
// machine. A remote gateway that's temporarily unreachable must not silently
// fall back to a local OpenClaw process — that would route tasks to the wrong
// place. Wildcard binds (`0.0.0.0`, `::`) count as local too, since users may
// copy a local bind address like `ws://0.0.0.0:<port>` into config.
function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname; // WHATWG URL strips brackets for IPv6
    return (
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === 'localhost' ||
      h === '::1' ||
      h === '::'
    );
  } catch {
    return false;
  }
}

function resolveTimeout(
  explicit: number | undefined,
  envName: string,
  fallback: number,
  label: string,
): number {
  const envRaw = process.env[envName];
  const envNum = envRaw !== undefined ? Number(envRaw) : undefined;
  const requested = explicit ?? envNum;
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested) || requested <= 0) {
    console.warn(`[openclaw] invalid ${label} "${requested}", falling back to ${fallback}ms`);
    return fallback;
  }
  return requested;
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
  const taskTimeoutMs = resolveTimeout(
    opts.taskTimeoutMs,
    'OPENCLAW_TASK_TIMEOUT_MS',
    DEFAULT_TASK_TIMEOUT_MS,
    'taskTimeoutMs',
  );
  const handshakeTimeoutMs = resolveTimeout(
    opts.handshakeTimeoutMs,
    'OPENCLAW_HANDSHAKE_TIMEOUT_MS',
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    'handshakeTimeoutMs',
  );

  let current: GatewayClient | null = null;
  let connecting: Promise<GatewayClient> | null = null;
  const runToTask = new Map<string, { taskId: string; sessionKey: string }>();
  const taskFinalizers = new Map<string, (evt: FinalizerEvent) => void>();
  const pendingRunEvents = new Map<string, ChatEventPayload[]>();
  // sessionKeys we have already called `sessions.messages.subscribe` on for
  // the current gateway connection. Subscription is idempotent per
  // connection: one call per sessionKey regardless of how many tasks reuse
  // it. Cleared on reconnect because the connId (and therefore the server's
  // subscriber entry) is gone after a WS close.
  const subscribedSessionKeys = new Set<string>();
  // Latched true once we've observed an `unknown method` response to
  // `sessions.messages.subscribe` (via the capability probe or a per-task
  // attempt). When set, every subsequent task skips the subscribe RPC and
  // its accompanying warn log. Reset on reconnect so an upgraded gateway
  // can re-enable streaming without a client restart.
  let gatewayLacksMessageSubscribe = false;
  // Per-sessionKey owner of message-boundary streaming. OpenClaw's
  // `session.message` payload carries no runId, so we cannot route events
  // for two concurrent `chat.send` calls on the same sessionKey. First task
  // wins ownership; a second concurrent task on the same sessionKey skips
  // registration and falls back to the one-shot final artifact. Normal
  // sequential use on the same contextId is unaffected because the owner
  // entry is released in finally{}.
  type SessionMessageOwner = {
    taskId: string;
    handler: (p: SessionMessageEventPayload) => void;
  };
  const sessionMessageOwners = new Map<string, SessionMessageOwner>();
  // Bounded memory of recently-finalized runIds. Any chat event carrying one
  // of these is dropped instead of buffered in pendingRunEvents, so late or
  // duplicate deltas from OpenClaw cannot accumulate forever after the task
  // has already emitted its terminal frame.
  const recentlyFinalizedRuns = new Set<string>();
  const MAX_FINALIZED_RUNS = 512;
  const MAX_BUFFERED_EVENTS_PER_RUN = 64;
  const MAX_PENDING_RUN_KEYS = 256;

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
    // Subscriptions are connId-scoped on the gateway side; after a close
    // there is no remote state to reconcile. Forget them so the next
    // connection re-subscribes cleanly.
    subscribedSessionKeys.clear();
    sessionMessageOwners.clear();
    // An upgraded gateway (e.g. OpenClaw <v2026.3.22 → ≥v2026.3.22 across a
    // restart) may start supporting `sessions.messages.subscribe` after a
    // reconnect. Clearing the latch lets the next probe/attempt re-evaluate.
    gatewayLacksMessageSubscribe = false;
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

  let resolvedUrl = url;
  const discoveryProcessName =
    process.env.OPENCLAW_PROCESS_NAME ?? DEFAULT_DISCOVERY_PROCESS_NAME;
  const discover =
    opts.discoverGatewayUrls ??
    (() => discoverLocalGatewayUrls(discoveryProcessName, resolvedUrl));

  async function connectAt(candidateUrl: string, hsTimeoutMs: number): Promise<GatewayClient> {
    const c = new GatewayClient(candidateUrl, token, hsTimeoutMs);
    await c.connect();
    c.onEvent((evt) => {
      if (evt.event === 'session.message') {
        const p = evt.payload as SessionMessageEventPayload | undefined;
        if (!p?.sessionKey) return;
        if (debug) {
          console.log('[openclaw] session.message event:', JSON.stringify(p).slice(0, 500));
        }
        const owner = sessionMessageOwners.get(p.sessionKey);
        if (!owner) return;
        try {
          owner.handler(p);
        } catch (err) {
          console.error('[openclaw] session.message handler threw:', (err as Error).message);
        }
        return;
      }
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
        // Buffer until the handler catches up and drains it. Evict the
        // oldest unknown runId when the map grows past the cap so a
        // noisy/misbehaving gateway can't inflate memory indefinitely.
        let buf = pendingRunEvents.get(p.runId);
        if (!buf) {
          if (pendingRunEvents.size >= MAX_PENDING_RUN_KEYS) {
            const oldest = pendingRunEvents.keys().next().value;
            if (oldest !== undefined) pendingRunEvents.delete(oldest);
          }
          buf = [];
          pendingRunEvents.set(p.runId, buf);
        }
        if (buf.length >= MAX_BUFFERED_EVENTS_PER_RUN) buf.shift();
        buf.push(p);
        return;
      }
      taskFinalizers.get(binding.taskId)?.(p);
    });
    c.onClose((err) => handleGatewayClose(c, err));
    return c;
  }

  async function tryConnectWithDiscovery(): Promise<GatewayClient> {
    try {
      const c = await connectAt(resolvedUrl, handshakeTimeoutMs);
      console.log(`[openclaw] connected ${redactUrl(resolvedUrl)}`);
      return c;
    } catch (primaryErr) {
      // Fall back to process-based discovery: locate any OpenClaw-named
      // process listening on loopback and try its port(s). Keeps the common
      // "gateway moved to a different port" case self-healing without any
      // OpenClaw-side cooperation. Skip when the configured URL is remote —
      // a remote gateway outage must not silently reroute tasks to a local
      // process.
      if (!isLoopbackUrl(resolvedUrl)) throw primaryErr;
      // Discovery is best-effort. An injected discoverGatewayUrls that throws
      // must not mask the original connect error, so treat any rejection as
      // "no candidates" and fall through to surface the primary failure.
      let candidates: string[] = [];
      try {
        candidates = await discover();
      } catch (discoverErr) {
        if (debug) {
          console.warn(`[openclaw] discover() threw, treating as empty: ${errorMessage(discoverErr)}`);
        }
      }
      const alternates = candidates.filter((u) => !sameGatewayUrl(u, resolvedUrl));
      if (alternates.length === 0) throw primaryErr;
      console.warn(
        `[openclaw] connect to ${redactUrl(resolvedUrl)} failed (${errorMessage(primaryErr)}); trying ${alternates.length} discovered candidate(s)`,
      );
      const probeTimeout = Math.min(handshakeTimeoutMs, DEFAULT_DISCOVERY_HANDSHAKE_TIMEOUT_MS);
      for (const alt of alternates) {
        try {
          const c = await connectAt(alt, probeTimeout);
          console.log(
            `[openclaw] auto-discovered gateway at ${redactUrl(alt)} (was ${redactUrl(resolvedUrl)})`,
          );
          resolvedUrl = alt;
          return c;
        } catch (candidateErr) {
          if (debug) {
            console.warn(
              `[openclaw] discovered candidate ${redactUrl(alt)} failed: ${errorMessage(candidateErr)}`,
            );
          }
        }
      }
      // Surface the original connect failure instead of the last candidate's
      // error — that's what the operator actually configured, and the
      // candidate errors are downstream noise whose identity depends on scan
      // order and false positives.
      throw primaryErr;
    }
  }

  async function ensureConnected(): Promise<GatewayClient> {
    if (current && current.state === 'ready') return current;
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const c = await tryConnectWithDiscovery();
        current = c;
        return c;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  // Idempotent per (connection, sessionKey). Subscription is the mechanism
  // that unlocks message-boundary streaming: OpenClaw will broadcast a
  // `session.message` event to this connection whenever the transcript for
  // `sessionKey` gets a new entry. Failure is non-fatal — the task falls
  // back to today's single-artifact-on-final behavior.
  async function ensureSessionMessageSubscription(
    gw: GatewayClient,
    sessionKey: string,
  ): Promise<void> {
    if (subscribedSessionKeys.has(sessionKey)) return;
    // Short-circuit once we know the gateway doesn't implement the RPC —
    // attempting it per task would just produce a noisy warn log on every
    // chat.send against a pre-v2026.3.22 gateway.
    if (gatewayLacksMessageSubscribe) return;
    try {
      await gw.request('sessions.messages.subscribe', { key: sessionKey });
      subscribedSessionKeys.add(sessionKey);
    } catch (err) {
      const msg = errorMessage(err);
      if (/unknown method/i.test(msg)) {
        gatewayLacksMessageSubscribe = true;
        console.warn(
          `[openclaw] gateway does not implement sessions.messages.subscribe; streaming disabled for this connection (requires OpenClaw >= v2026.3.22)`,
        );
        return;
      }
      console.warn(
        `[openclaw] sessions.messages.subscribe failed for ${sessionKey}: ${msg} (continuing without streaming)`,
      );
    }
  }

  return {
    name: 'openclaw',

    // Probe whether the gateway implements `sessions.messages.subscribe` so
    // the bridge-server can advertise a card capability that matches reality.
    // OpenClaw added the RPC in v2026.3.22; older gateways reject it with
    // `unknown method: sessions.messages.subscribe`. We treat that specific
    // error as a negative signal and every other failure mode (scope denied,
    // invalid key, etc.) as "method exists → streaming available", since they
    // prove the method dispatched before being rejected. Gateway unreachable
    // at probe time returns `{}` so the card's declared value wins — the
    // alternative (assuming "not supported" on transient outages) would
    // spuriously downgrade healthy deployments.
    async resolveCapabilities() {
      let gw: GatewayClient;
      try {
        gw = await ensureConnected();
      } catch (err) {
        console.warn(
          `[openclaw] capability probe skipped: gateway unreachable (${errorMessage(err)}); leaving card capabilities as declared`,
        );
        return {};
      }
      const probeKey = `__vicoop-capability-probe__:${randomUUID()}`;
      try {
        await gw.request('sessions.messages.subscribe', { key: probeKey });
        // Probe succeeded against a synthetic sessionKey. Best-effort cleanup
        // so the subscriber slot isn't kept alive — subscription state is
        // connection-scoped anyway, so a failed unsubscribe is harmless.
        try {
          await gw.request('sessions.messages.unsubscribe', { key: probeKey });
        } catch {
          /* ignore */
        }
        return { streaming: true };
      } catch (err) {
        const msg = errorMessage(err);
        if (/unknown method/i.test(msg)) {
          gatewayLacksMessageSubscribe = true;
          console.warn(
            '[openclaw] gateway does not implement sessions.messages.subscribe; advertising streaming:false (streaming requires OpenClaw >= v2026.3.22)',
          );
          return { streaming: false };
        }
        return { streaming: true };
      }
    },

    async handle(task, emit, signal) {
      // Fast path: the task was canceled before we even started. Emit a
      // terminal canceled frame and do not touch the gateway.
      if (signal.aborted) {
        emit({
          type: 'task.complete',
          taskId: task.taskId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        });
        return;
      }

      // Validate and normalize A2A parts BEFORE touching the gateway so
      // malformed input fails fast without opening a WS or consuming a
      // session slot.
      const mapped = mapPartsToChatInput(task.message.parts);
      if (!mapped.ok) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: mapped.error,
        });
        return;
      }

      let gw: GatewayClient;
      try {
        gw = await ensureConnected();
      } catch (err) {
        emit({
          type: 'task.fail',
          taskId: task.taskId,
          error: { code: 'gateway_closed', message: (err as Error).message },
        });
        return;
      }
      const sessionKey = `${sessionPrefix}:${agent}:${task.contextId}`;
      const { message: text, attachments } = mapped.input;

      emit({
        type: 'task.status',
        taskId: task.taskId,
        status: { state: 'working', timestamp: new Date().toISOString() },
      });

      // Subscribe to per-message transcript events for this sessionKey so we
      // can forward each assistant message as a separate A2A artifact while
      // the run is in progress. Subscribing here (before chat.send) avoids
      // races where fast agents write their first message before we would
      // otherwise have registered. Failure degrades to the non-streaming
      // final-only path — not fatal.
      await ensureSessionMessageSubscription(gw, sessionKey);

      // Per-task streaming state. `emittedAnyArtifact` decides whether the
      // terminal `chat.final` should also emit a final-only artifact (i.e.
      // whether the streaming path already delivered content). `seenAssistantMessageIds`
      // drops duplicate transcript events for the same message (e.g. if
      // OpenClaw re-emits after a rewrite). `sessionMessageSettled` closes
      // the gate at terminal time so a late `session.message` arriving after
      // we have already emitted `task.complete` cannot produce an artifact
      // past the terminal frame.
      let emittedAnyArtifact = false;
      const seenAssistantMessageIds = new Set<string>();
      let sessionMessageSettled = false;

      const onSessionMessage = (p: SessionMessageEventPayload): void => {
        if (sessionMessageSettled) return;
        const msg = p.message;
        if (!msg || typeof msg !== 'object') return;
        const role = (msg as { role?: unknown }).role;
        // Transcript also records user/tool entries — only assistant output
        // maps to A2A artifacts. The user's own message was delivered by
        // the caller and re-emitting it would loop back to them.
        if (role !== 'assistant') return;
        const mid = typeof p.messageId === 'string' ? p.messageId : '';
        if (mid) {
          if (seenAssistantMessageIds.has(mid)) return;
          seenAssistantMessageIds.add(mid);
        }
        const artifactText = extractFinalText(msg);
        if (!artifactText) return;
        emit({
          type: 'task.artifact',
          taskId: task.taskId,
          artifact: {
            artifactId: randomUUID(),
            name: 'openclaw-message',
            parts: [{ kind: 'text', text: artifactText }],
          },
          // Each message is a self-contained artifact (option (b) in the
          // design discussion): distinct artifactId, complete on emission.
          // The end-of-run signal is carried by task.complete, not by any
          // individual artifact.
          lastChunk: true,
        });
        emittedAnyArtifact = true;
      };

      // First task on this sessionKey wins streaming ownership. A concurrent
      // second task on the same contextId would see interleaved session.message
      // events with no runId to disambiguate, so it falls back to the
      // one-shot final artifact path. This is the common-case tradeoff —
      // serial reuse of a contextId (the normal A2A usage pattern) streams
      // fine because the first task releases ownership in finally{}.
      const ownedSession =
        subscribedSessionKeys.has(sessionKey) && !sessionMessageOwners.has(sessionKey);
      if (ownedSession) {
        sessionMessageOwners.set(sessionKey, {
          taskId: task.taskId,
          handler: onSessionMessage,
        });
      } else if (subscribedSessionKeys.has(sessionKey)) {
        console.warn(
          `[openclaw] ${sessionKey} already has a streaming owner; task ${task.taskId} will emit a single final artifact`,
        );
      }

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
      // A signal-abort that fires before the chat.send ack has to wait until
      // we know the runId. This flag captures that intent so the ack path
      // can fire chat.abort immediately once runId is populated.
      let pendingAbort = false;

      const fireAbort = async (activeRunId: string): Promise<void> => {
        try {
          await gw.request('chat.abort', { sessionKey, runId: activeRunId });
          // Leave `settled` pending: after a successful chat.abort OpenClaw
          // emits `state: 'aborted'` which drives the finalizer through the
          // normal event path. taskTimeoutMs bounds the wait if that echo
          // never arrives.
        } catch (err) {
          // Without this branch a failed chat.abort would leave the task
          // hanging until taskTimeoutMs, because no terminal event is coming.
          resolveSettled({
            runId: activeRunId,
            sessionKey,
            seq: -1,
            state: 'error',
            errorMessage: (err as Error).message,
            cause: 'abort_failed',
          });
        }
      };

      let abortHandled = false;
      const onAbort = (): void => {
        // Listener can race with an explicit `if (signal.aborted) onAbort()`
        // after attach, so guard against double-invocation to avoid sending
        // two chat.abort RPCs.
        if (abortHandled) return;
        abortHandled = true;
        if (runId === null) {
          pendingAbort = true;
          return;
        }
        void fireAbort(runId);
      };
      signal.addEventListener('abort', onAbort);
      // A signal that aborted between handle() entry (fast-path check) and
      // this listener attach — typically during `await ensureConnected()` —
      // will not auto-fire the listener we just attached (AbortSignal does
      // not replay the event). Check explicitly so pre-ack cancels arriving
      // during connect still propagate to the gateway.
      if (signal.aborted) onAbort();

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
            // Only include `attachments` when non-empty so the text-only
            // happy path is unchanged on the wire.
            ...(attachments.length > 0 ? { attachments } : {}),
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

        // Fire a deferred abort now that the runId is known.
        if (pendingAbort) void fireAbort(runId);

        const result = await settled;

        // Close the streaming gate before any terminal emit. Any
        // `session.message` that arrives from this point on (e.g. a
        // transcript write that races with the final event) must not
        // produce an artifact after task.complete/fail.
        sessionMessageSettled = true;

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
        if (result.cause === 'abort_failed') {
          emit({
            type: 'task.fail',
            taskId: task.taskId,
            error: {
              code: 'gateway_abort_failed',
              message: result.errorMessage ?? 'chat.abort request failed',
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
        // Only emit the final-result artifact when streaming produced
        // nothing — otherwise each assistant message already went out as its
        // own artifact and re-emitting the final text here would be a
        // redundant copy of the last one. task.complete still carries the
        // final message in status.message, which is how A2A conventionally
        // stamps the terminal content anyway.
        if (!emittedAnyArtifact) {
          const artifactId = randomUUID();
          emit({
            type: 'task.artifact',
            taskId: task.taskId,
            artifact: { artifactId, name: 'openclaw-result', parts },
            lastChunk: true,
          });
        }
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
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        taskFinalizers.delete(task.taskId);
        if (runId) {
          runToTask.delete(runId);
          pendingRunEvents.delete(runId);
          markRunFinalized(runId);
        }
        // Defensive: if we bailed out of handle() before reaching the
        // explicit gate close above (synchronous throw, early return), the
        // session.message handler could otherwise still fire for this task.
        sessionMessageSettled = true;
        if (ownedSession && sessionMessageOwners.get(sessionKey)?.taskId === task.taskId) {
          sessionMessageOwners.delete(sessionKey);
        }
      }
    },
  };
}
