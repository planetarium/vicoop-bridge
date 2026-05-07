import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  encodeFrame,
  parseDownFrame,
  type AgentCard,
  type Part,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import { createLogger, type LogLevel, type Logger, safeToken } from './logger.js';

export interface ClientOptions {
  serverUrl: string;
  token: string;
  agentId: string;
  agentCard?: AgentCard;
  backendKind: string;
  backend: Backend;
  maxConcurrency?: number;
  // Initial reconnect delay after an unintentional disconnect. Retries use
  // exponential backoff from this value up to `reconnectMaxDelayMs`.
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  reconnectStableMs?: number;
  // WebSocket protocol ping interval. The client terminates the socket when
  // a previous ping has not received a pong by the next tick, which turns
  // half-open network failures into a normal reconnect path. Set to 0 to
  // disable.
  heartbeatIntervalMs?: number;
  // Upper bound on how long we'll wait for `backend.resolveCapabilities()`
  // before sending the bridge-server hello with the card's declared
  // capabilities. Defaults to 3000 ms — comfortably under the bridge
  // server's 10s hello deadline so a slow or hung probe cannot push us
  // into the 4001 "hello timeout" close and a reconnect loop.
  probeDeadlineMs?: number;
  // Verbosity for client-emitted logs. Falls back to the
  // `VICOOP_CLIENT_LOG_LEVEL` env var, then to `info`. Lifecycle events
  // (task.assign / backend.start / task.complete / task.canceled /
  // task.fail / task.cancel) surface at `info`; `debug` adds the
  // task.assign detail line (`messageId`, `role`, `partsCount`) and the
  // full backend exception message on the late-throw path.
  logLevel?: LogLevel;
}

const DEFAULT_PROBE_DEADLINE_MS = 3000;
const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_RECONNECT_STABLE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export class Client {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectResetTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAwaitingPong = false;
  private inflight = new Map<string, AbortController>();
  // Resolved once per process via backend.resolveCapabilities(); the bridge
  // hello frame is held until this settles so the advertised card matches the
  // backend's actual upstream capability. Cached across reconnects so we
  // don't re-probe on every bridge WS reconnect — the underlying upstream
  // doesn't change mid-process.
  private effectiveCardPromise: Promise<AgentCard | undefined> | null = null;
  private readonly logger: Logger;

  constructor(private readonly opts: ClientOptions) {
    this.logger = createLogger(opts.logLevel);
  }

  start(): void {
    // Kick off the capability probe before opening the bridge WS so it runs
    // in parallel with (and usually finishes before) the server's hello
    // deadline starts ticking at the `open` event. Starting it inside
    // `ws.on('open')` instead could push `hello` past the server's 10s
    // hello timeout when the backend probe itself takes a while (e.g. the
    // openclaw gateway handshake on an unreachable/slow-to-handshake host).
    void this.resolveEffectiveCard();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearReconnectResetTimer();
    this.clearHeartbeat();
    // Abort all inflight tasks so backends can unwind cleanly instead of
    // running to completion after the WS is gone.
    for (const controller of this.inflight.values()) controller.abort();
    this.ws?.close();
  }

  private resolveEffectiveCard(): Promise<AgentCard | undefined> {
    if (this.effectiveCardPromise) return this.effectiveCardPromise;
    const base = this.opts.agentCard;
    if (!base) {
      this.effectiveCardPromise = Promise.resolve(undefined);
      return this.effectiveCardPromise;
    }
    const probe = this.opts.backend.resolveCapabilities;
    if (!probe) {
      this.effectiveCardPromise = Promise.resolve(base);
      return this.effectiveCardPromise;
    }
    const deadlineMs = this.opts.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
    this.effectiveCardPromise = (async () => {
      const TIMEOUT = Symbol('probe-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), deadlineMs);
        timer.unref?.();
      });
      // `Promise.resolve().then(...)` converts a synchronous throw from a
      // non-async probe implementation into a promise rejection — otherwise
      // the throw would escape before `.catch` is attached and surface as an
      // unhandled rejection on `effectiveCardPromise`, which the `open`
      // handler consumes with `.then` only.
      const probePromise = Promise.resolve()
        .then(() => probe.call(this.opts.backend))
        .catch((err: unknown) => {
          // Sanitize the message — even a probe error path can carry text
          // derived from upstream, and a stray newline in an error message
          // would let a non-fatal probe failure split the warn into two
          // log lines (or appear to inject a fake `[client] …` entry).
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `backend capability probe threw (${safeToken(message)}); using declared card capabilities`,
          );
          return null;
        });
      try {
        const outcome = await Promise.race([probePromise, timeoutPromise]);
        if (outcome === TIMEOUT) {
          this.logger.warn(
            `backend capability probe did not complete within ${deadlineMs}ms; sending hello with declared card capabilities`,
          );
          return base;
        }
        if (outcome === null) return base;
        const detected = outcome;
        // Preserve the documented "no override" contract: an empty detected
        // object must leave the card byte-for-byte unchanged, including an
        // absent `capabilities` field. Only materialize `capabilities` when
        // the probe actually reports a value we need to apply.
        if (detected.streaming === undefined && detected.pushNotifications === undefined) {
          return base;
        }
        const merged: AgentCard['capabilities'] = {
          ...(base.capabilities ?? {}),
          ...(detected.streaming !== undefined ? { streaming: detected.streaming } : {}),
          ...(detected.pushNotifications !== undefined
            ? { pushNotifications: detected.pushNotifications }
            : {}),
        };
        return { ...base, capabilities: merged };
      } finally {
        // Clear the deadline timer so a fast probe doesn't leave an extra
        // callback and its closure alive until `deadlineMs` elapses. The
        // unref() above is enough to keep this from blocking process exit,
        // but clearing is cheaper than letting it fire.
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return this.effectiveCardPromise;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.opts.serverUrl.replace(/\/$/, '')}/connect`);
    this.ws = ws;

    ws.on('open', () => {
      this.scheduleReconnectAttemptReset(ws);
      this.startHeartbeat(ws);
      // The probe runs in parallel with the bridge TCP/WS handshake; by the
      // time `open` fires it's usually already settled. Awaiting here means
      // the bridge-server sees a card whose capabilities match what the
      // backend can actually deliver. If the probe is still running (slow
      // gateway handshake), `hello` is delayed by the difference — typically
      // a few ms on a local loopback gateway.
      //
      // Send on the captured `ws` (not `this.send()` / `this.ws`) so a
      // reconnect-driven socket swap during the probe's async gap cannot
      // misdirect the hello onto a fresh connection that has its own `open`
      // handler coming. Also drop the frame silently if this socket moved
      // out of OPEN before the probe settled — the next `connect()` cycle
      // will issue its own hello.
      const sendHello = (agentCard: AgentCard | undefined): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        this.logger.info('connected, sending hello');
        ws.send(
          encodeFrame({
            type: 'hello',
            agentId: this.opts.agentId,
            ...(agentCard ? { agentCard } : {}),
            backendKind: this.opts.backendKind,
            version: PROTOCOL_VERSION,
            token: this.opts.token,
          }),
        );
      };
      // The internal catch inside resolveEffectiveCard() already coerces
      // every failure into "return base", so this `.catch` is defense in
      // depth — if a future refactor ever lets a rejection escape, still
      // send hello with the declared card instead of silently dropping it.
      this.resolveEffectiveCard()
        .then(sendHello)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `effectiveCard promise rejected unexpectedly (${safeToken(message)}); sending hello with declared card`,
          );
          sendHello(this.opts.agentCard);
        });
    });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = parseDownFrame(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch (err) {
        // Stringify+sanitize before passing to the logger so a frame parse
        // error (Zod or otherwise) carrying newlines / control chars in
        // its message can't split the log into multiple lines.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`invalid frame: ${safeToken(message)}`);
        return;
      }

      switch (frame.type) {
        case 'task.assign':
          // `summarizeParts` already sanitizes each MIME via safeToken, so
          // the `parts=` token here intentionally does NOT wrap the whole
          // summary again — that would double-escape backslashes (a `\n`
          // sanitized to `\\n` would become `\\\\n`) and make the field
          // harder to read for operators.
          this.logger.info(
            `task.assign taskId=${safeToken(frame.taskId)} contextId=${safeToken(frame.contextId)} parts=${summarizeParts(frame.message.parts)}`,
          );
          this.logger.debug(
            `task.assign detail taskId=${safeToken(frame.taskId)} messageId=${safeToken(frame.message.messageId)} role=${frame.message.role} partsCount=${frame.message.parts.length}`,
          );
          this.runTask(frame);
          break;
        case 'task.cancel':
          this.logger.info(`task.cancel taskId=${safeToken(frame.taskId)}`);
          this.inflight.get(frame.taskId)?.abort();
          break;
        case 'ping':
          this.send({ type: 'pong' });
          break;
      }
    });

    ws.on('pong', () => {
      if (this.ws === ws) this.heartbeatAwaitingPong = false;
    });

    ws.on('close', (code, reason) => {
      const current = this.ws === ws;
      if (current) this.clearReconnectResetTimer();
      if (current) this.clearHeartbeat();
      // `reason` is a remote-controlled byte buffer from the WebSocket
      // close frame; sanitize before logging so a server can't inject a
      // fake `[client] …` line via newlines.
      this.logger.info(`disconnected: ${code} ${safeToken(reason.toString())}`);
      if (current) {
        this.ws = null;
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      // Sanitize: ws error messages can include URLs, hostnames, or
      // upstream text and we want the same single-line invariant we
      // applied to the close `reason` and lifecycle logs.
      this.logger.error(`ws error: ${safeToken(err.message)}`);
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    const intervalMs = this.opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (intervalMs <= 0) return;
    this.heartbeatAwaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || this.ws !== ws) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.heartbeatAwaitingPong) {
        this.logger.warn('connection heartbeat timed out; reconnecting');
        ws.terminate();
        return;
      }
      this.heartbeatAwaitingPong = true;
      try {
        ws.ping();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`connection heartbeat failed (${safeToken(message)}); reconnecting`);
        ws.terminate();
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatAwaitingPong = false;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearReconnectResetTimer(): void {
    if (this.reconnectResetTimer) {
      clearTimeout(this.reconnectResetTimer);
      this.reconnectResetTimer = null;
    }
  }

  private scheduleReconnectAttemptReset(ws: WebSocket): void {
    this.clearReconnectResetTimer();
    const stableMs = this.opts.reconnectStableMs ?? DEFAULT_RECONNECT_STABLE_MS;
    if (stableMs <= 0) {
      this.reconnectAttempt = 0;
      return;
    }
    this.reconnectResetTimer = setTimeout(() => {
      this.reconnectResetTimer = null;
      if (!this.stopped && this.ws === ws && ws.readyState === WebSocket.OPEN) {
        this.reconnectAttempt = 0;
      }
    }, stableMs);
    this.reconnectResetTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const delay = this.nextReconnectDelay(attempt);
    this.logger.info(`reconnecting in ${delay}ms attempt=${attempt + 1}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info(`reconnect attempt=${attempt + 1}`);
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private nextReconnectDelay(attempt: number): number {
    const base = Math.max(0, this.opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    const max = Math.max(base, this.opts.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS);
    const capped = Math.min(max, base * 2 ** attempt);
    const ratio = Math.max(0, this.opts.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO);
    if (capped === 0 || ratio === 0) return Math.round(capped);
    const jitter = capped * ratio;
    const min = Math.max(0, capped - jitter);
    const maxWithJitter = Math.min(max, capped + jitter);
    return Math.round(min + Math.random() * (maxWithJitter - min));
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
      await processTask(frame, controller.signal, {
        backend: this.opts.backend,
        send: (f) => this.send(f),
        logger: this.logger,
      });
    } finally {
      this.inflight.delete(frame.taskId);
    }
  }
}

export interface ProcessTaskDeps {
  backend: Backend;
  // Wire send. Receives every frame the backend emits, plus a fallback
  // task.fail emitted by `processTask` itself when the backend throws
  // without having emitted a terminal.
  send: (frame: UpFrame) => void;
  logger: Logger;
}

// Run a single A2A task through the backend and emit the lifecycle logs
// described in vicoop-bridge issue #98. Extracted from `Client.runTask` so
// the lifecycle logic is unit-testable without a real WebSocket — tests
// pass stub backends and a capturing send/logger.
export async function processTask(
  frame: TaskAssignFrame,
  signal: AbortSignal,
  deps: ProcessTaskDeps,
): Promise<void> {
  const startedAt = Date.now();
  // Track lifecycle state through an object so reads after `await` aren't
  // narrowed back to the initial `null` by control-flow analysis — TS
  // doesn't follow assignments made inside the `emit` closure below.
  //
  // `artifactIds` counts *distinct* artifacts via their `artifactId`
  // rather than counting raw `task.artifact` frames: the protocol allows
  // a single artifact to be streamed across multiple chunks (`lastChunk`),
  // so a per-frame counter would over-report.
  const state: {
    artifactIds: Set<string>;
    terminal:
      | { kind: 'complete' }
      | { kind: 'canceled' }
      | { kind: 'fail'; code: string }
      | null;
  } = { artifactIds: new Set(), terminal: null };

  // Wrap emit so we can observe terminal frames the backend sends and
  // report taskId/elapsedMs/artifacts/code from the same code path,
  // without changing the wire-level frames or inspecting their payloads.
  // A `task.complete` with `status.state === 'canceled'` is the codebase's
  // existing cancellation convention (see backends/claude.ts); record it
  // distinctly so the lifecycle log doesn't mislabel cancels as completions.
  const emit: Emit = (f) => {
    if (f.type === 'task.artifact') state.artifactIds.add(f.artifact.artifactId);
    else if (f.type === 'task.complete') {
      state.terminal =
        f.status.state === 'canceled' ? { kind: 'canceled' } : { kind: 'complete' };
    } else if (f.type === 'task.fail') {
      state.terminal = { kind: 'fail', code: f.error.code };
    }
    deps.send(f);
  };

  // Sanitize wire-derived tokens so a hostile server (or a bug in a
  // backend that derives strings from user content) can't break out of a
  // single log line via embedded \n / control chars.
  const taskTok = safeToken(frame.taskId);
  const backendTok = safeToken(deps.backend.name);
  deps.logger.info(`backend.start taskId=${taskTok} backend=${backendTok}`);
  try {
    await deps.backend.handle(frame, emit, signal);
    const elapsedMs = Date.now() - startedAt;
    const terminal = state.terminal;
    if (terminal === null) {
      // Backend resolved without emitting task.complete or task.fail. The
      // bridge server will likely time the task out; surface it at warn so
      // operators see the broken contract instead of a silent gap.
      deps.logger.warn(
        `backend.end taskId=${taskTok} elapsedMs=${elapsedMs} (no terminal frame)`,
      );
    } else if (terminal.kind === 'complete') {
      deps.logger.info(
        `task.complete taskId=${taskTok} elapsedMs=${elapsedMs} artifacts=${state.artifactIds.size}`,
      );
    } else if (terminal.kind === 'canceled') {
      deps.logger.info(
        `task.canceled taskId=${taskTok} elapsedMs=${elapsedMs} artifacts=${state.artifactIds.size}`,
      );
    } else {
      deps.logger.info(
        `task.fail taskId=${taskTok} code=${safeToken(terminal.code)} elapsedMs=${elapsedMs}`,
      );
    }
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = err instanceof Error ? err.constructor.name : typeof err;
    if (state.terminal !== null) {
      // The backend already emitted a terminal frame and then threw. Do
      // *not* send a second terminal — the bridge server treats a second
      // task.complete/task.fail for the same taskId as a protocol
      // violation. Surface the late throw at warn so operators notice
      // the backend's broken contract instead of seeing it silently
      // swallowed. The raw error message can include user content
      // (prompts, file paths, upstream payloads) and stays out of the
      // default-visible warn line; debug carries the full text for
      // operators who opt in.
      deps.logger.warn(
        `backend threw after terminal taskId=${taskTok} elapsedMs=${elapsedMs} terminal=${state.terminal.kind} errorClass=${safeToken(errorClass)}`,
      );
      // Use a generous limit so the full backend message is preserved at
      // debug — the default 200-char ceiling on lifecycle tokens is too
      // tight for an exception's text. Still escape line breaks so the
      // log line stays single-line.
      deps.logger.debug(
        `backend threw after terminal taskId=${taskTok} message=${safeToken(message, 4000)}`,
      );
    } else if (signal.aborted) {
      // The throw is plausibly the backend reacting to the AbortSignal it
      // was handed (an incoming `task.cancel` aborted the controller).
      // Emit a canceled-state task.complete — the codebase's existing
      // convention for cancellation (see backends/claude.ts) — instead of
      // misclassifying the cancel as a `backend_error` fail and racing
      // the bridge server's own cancel path.
      deps.send({
        type: 'task.complete',
        taskId: frame.taskId,
        status: { state: 'canceled', timestamp: new Date().toISOString() },
      });
      deps.logger.info(
        `task.canceled taskId=${taskTok} elapsedMs=${elapsedMs} artifacts=${state.artifactIds.size}`,
      );
    } else {
      const code = 'backend_error';
      deps.send({
        type: 'task.fail',
        taskId: frame.taskId,
        error: { code, message },
      });
      deps.logger.info(
        `task.fail taskId=${taskTok} code=${code} elapsedMs=${elapsedMs}`,
      );
    }
  }
}

// Summarize an A2A message's parts as a comma-separated list of unique MIME
// types for logging. Avoids leaking content (text bodies, file bytes) by
// reporting only the structural shape of the message. The MIME from a
// `file` part is user/peer-supplied, so each entry is run through
// `safeToken` to neutralize embedded newlines / control chars before the
// summary is interpolated into a log line.
export function summarizeParts(parts: readonly Part[]): string {
  if (parts.length === 0) return '(none)';
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const part of parts) {
    const mime = safeToken(mimeForPart(part));
    if (!seen.has(mime)) {
      seen.add(mime);
      ordered.push(mime);
    }
  }
  return ordered.join(',');
}

function mimeForPart(part: Part): string {
  if (part.kind === 'text') return 'text/plain';
  if (part.kind === 'file') {
    // The protocol allows `mimeType` to be any string (or absent).
    // Normalize empty / whitespace-only values to the octet-stream
    // fallback so log lines don't end up with empty `parts=,` segments.
    const mime = part.file.mimeType?.trim();
    return mime || 'application/octet-stream';
  }
  return 'application/json';
}
