import WebSocket from 'ws';
import {
  CALLER_CONTEXT_CAPABILITY,
  PROTOCOL_VERSION,
  OPENAI_COMPAT_EXTENSION_URI,
  encodeFrame,
  parseDownFrame,
  withOpenAICompatModelsAdvertise,
  type AgentCard,
  type Part,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import {
  createLogger,
  type ConsoleSink,
  type LogLevel,
  type Logger,
  safeToken,
} from './logger.js';
import {
  a2aCardUrl,
  a2aEndpoint,
  deriveIdentity,
  formatAcct,
  formatMention,
  webfingerUrl,
} from './identity.js';

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
  // Maximum number of task frames held for replay while the bridge connection
  // is down (see `pendingFrames`). `0` disables buffering and restores the
  // previous drop-on-the-floor behavior.
  maxPendingFrames?: number;
  // Companion byte budget for that buffer, over the encoded frames. Keep at or
  // below the server's pre-auth byte budget; see DEFAULT_MAX_PENDING_BYTES.
  maxPendingBytes?: number;
  // How long a buffered frame stays replayable; see DEFAULT_MAX_PENDING_AGE_MS.
  maxPendingAgeMs?: number;
  // Minimum reconnect delay after a 4009 "another client with the same
  // token connected" close — i.e. two daemons authenticated with the
  // same CLIENT_TOKEN colliding at the registry's clientId check. The
  // default is intentionally large (5 min) so a duplicate-token
  // ping-pong damps out within one cycle instead of hammering the
  // bridge — see vicoop-bridge#270. A legitimate handoff (operator
  // restarts the daemon, old process exits) still recovers; it just
  // waits this long before reconnecting. Tests override to a small value
  // so the 4009-specific path is exercisable without a multi-minute
  // sleep. Setting this below the normal computed backoff has no
  // effect — the floor only raises the delay, never lowers it.
  collisionBackoffMs?: number;
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
  // Test seam: override the default console sink. Production callers leave
  // this unset and logs land on `console.log` / `.warn` / `.error`.
  logSink?: ConsoleSink;
  // Invoked when the daemon hits a non-recoverable terminal close code
  // (currently 4014 "client deleted" and 4005 "bad token" — see the
  // close-handler in `connect()` for the rationale on each). The Client
  // itself only tears down its own state — `stopped = true`, reconnect
  // timer cleared, inflight tasks aborted — and delegates the
  // process-lifecycle decision (e.g. process.exit(1)) to the caller
  // via this callback. Two reasons we don't call process.exit here:
  // tests that construct a Client can't recover from a forced exit,
  // and future embedders (a long-running parent process hosting
  // multiple clients) need to keep running after one client is
  // deleted. The production entrypoint (`cli.ts runClient`) wires this
  // to `process.exit(1)`; tests pass a capturing callback.
  onFatal?: (info: { code: number; reason: string }) => void;
}

// Outer race deadline for `backend.resolveCapabilities()` — caps how long
// the bridge-server hello frame waits on the backend probe before falling
// back to the declared card. 12s accommodates the claude backend's worst
// case (operator cwd with hooks / skills / MCP / a large CLAUDE.md can
// push `system/init` emit to 5–10s) plus headroom; faster backends (codex
// reads config.toml in ~1ms) settle well before this and the deadline
// never fires.
const DEFAULT_PROBE_DEADLINE_MS = 12_000;
const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
// Cap on frames held for replay across a reconnect. Sized for the realistic
// worst case — a turn's streamed text is a few hundred small artifact frames —
// with headroom, while still bounding a daemon that keeps producing into a long
// outage. A task that loses frames to this cap is failed rather than replayed
// with a hole; see bufferUnsent(). `0` disables buffering entirely.
const DEFAULT_MAX_PENDING_FRAMES = 2_000;
// Companion byte budget for the same buffer. A frame count alone bounds
// nothing useful: the protocol puts no size limit on text, file or data parts,
// so 2,000 frames can be any number of megabytes. Both limits apply.
//
// MUST stay at or below the server's pre-auth byte budget
// (MAX_PRE_AUTH_BYTES in packages/server/src/ws.ts), because a replay is
// pipelined behind `hello` and the server holds it in memory until its
// authentication settles. A client allowed to buffer more than the server will
// accept pre-auth would be closed mid-replay and reconnect into a loop.
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
// How long a buffered frame is worth replaying. Past the server's own reconnect
// grace the binding it belonged to is gone, and — because A2A reuses a taskId
// across turns — a NEW run may already hold that id. Replaying then would inject
// a dead run's artifacts, or its terminal, into a live one. Anything older than
// this is dropped and its task failed instead.
//
// Kept above the server's default grace (BRIDGE_DISCONNECT_GRACE_MS, 30s) so a
// recovery the server would still have honored is never discarded here.
const DEFAULT_MAX_PENDING_AGE_MS = 45_000;
// Bound on the truncated-task bookkeeping. It is not covered by the frame
// budgets — one entry per distinct task, retained until reconnect — so a long
// outage across many tasks could otherwise grow it without limit.
const MAX_TRUNCATED_TASKS = 10_000;
const DEFAULT_RECONNECT_STABLE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_COLLISION_BACKOFF_MS = 300_000;

export class Client {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectResetTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAwaitingPong = false;
  // Identity block (mention / acct / a2a / agent-card / webfinger URLs)
  // is logged exactly once on first successful connect — same data on every
  // reconnect would just be noise, and we don't want to wait for whoami.
  private identityLogged = false;
  private inflight = new Map<string, AbortController>();
  // Resolved once per process via backend.resolveCapabilities(); the bridge
  // hello frame is held until this settles so the advertised card matches the
  // backend's actual upstream capability. Cached across reconnects so we
  // don't re-probe on every bridge WS reconnect — the underlying upstream
  // doesn't change mid-process.
  private effectiveCardPromise: Promise<AgentCard | undefined> | null = null;
  // Task frames `send()` could not put on the wire because the socket was
  // down, held in arrival order for replay on the next connection.
  //
  // Without this, a reconnect silently loses whatever the backend produced
  // during the outage: streamed deltas vanish mid-answer while the backend's
  // own bookkeeping advances past them, so the end-of-turn catch-up never
  // re-sends them and the task completes with a hole. Worse, a backend that
  // FINISHES during the outage loses its terminal frame outright and never
  // re-emits it, so a fully successful task is reported as failed once the
  // server's reconnect grace expires (vicoop-bridge#474).
  //
  // Replaying is safe and needs no server support beyond that grace hold: a
  // TaskBinding is not tied to a connection, so a frame arriving on the new
  // socket lands on the original task untouched. Frames for a task whose hold
  // already expired are dropped by the server as `dropped_terminal_frame`,
  // which is what would have happened anyway.
  // Entries hold the ENCODED frame, not the frame object: it is what replay
  // actually sends, and it is the only honest measure of what the buffer costs.
  private pendingFrames: Array<{ taskId: string; encoded: string; bytes: number; at: number }> = [];
  private pendingBytes = 0;
  // Entries handed to a socket but not yet known to have been accepted. They
  // stay here until the connection proves itself, so a replay that dies
  // mid-flight — an old bridge rejecting it, a second drop — is retried rather
  // than lost. Kept separate from `pendingFrames` so frames produced after the
  // flush cannot be sent twice.
  private replayInFlight: Array<{ taskId: string; encoded: string; bytes: number; at: number }> = [];
  // Set when a bridge rejects pipelined replay (4003 "expected hello"), i.e. it
  // predates the pre-auth queueing this depends on. Replaying again would just
  // loop, so we fall back to the old drop-on-the-floor behavior for the rest of
  // the process and tell the operator why.
  private replaySupported = true;
  // Tasks that lost at least one frame to the cap. Their replay would be a
  // hole rather than a delay, so they are failed explicitly instead — a caller
  // is far better served by an honest failure it can retry than by a silently
  // truncated answer.
  private truncatedTasks = new Set<string>();
  private readonly logger: Logger;

  constructor(private readonly opts: ClientOptions) {
    this.logger = createLogger(opts.logLevel, opts.logSink);
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
    // Nothing will replay these — the process is going away.
    this.dropPendingFrames();
    this.ws?.close();
    // Tear down long-lived backend resources (e.g. codex app-server child).
    // Per-task abort above covers per-handle subprocesses; this hook is for
    // upstreams the backend keeps across tasks. Best-effort and synchronous
    // so callers can `process.exit` on the next line — errors from a buggy
    // backend cleanup must not block daemon shutdown.
    try {
      this.opts.backend.stop?.();
    } catch (err) {
      this.logger.warn(`backend stop threw: ${err instanceof Error ? err.message : String(err)}`);
    }
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
        const hasModels = (detected.openaiCompatModels?.length ?? 0) > 0;
        if (
          detected.streaming === undefined &&
          detected.pushNotifications === undefined &&
          !hasModels
        ) {
          return base;
        }
        let next = base;
        if (
          detected.streaming !== undefined ||
          detected.pushNotifications !== undefined
        ) {
          const merged: AgentCard['capabilities'] = {
            ...(base.capabilities ?? {}),
            ...(detected.streaming !== undefined ? { streaming: detected.streaming } : {}),
            ...(detected.pushNotifications !== undefined
              ? { pushNotifications: detected.pushNotifications }
              : {}),
          };
          next = { ...next, capabilities: merged };
        }
        if (hasModels && detected.openaiCompatModels) {
          // No-op if the card doesn't declare openai-compat/v1 — see
          // `withOpenAICompatModelsAdvertise` for the rationale.
          next = withOpenAICompatModelsAdvertise(next, detected.openaiCompatModels);
        }
        return next;
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

  // Print the mention / acct / A2A endpoint / card URL / WebFinger URL block
  // that `vicoop-client whoami` would surface, so an operator who just
  // started the daemon doesn't have to open a second shell to find the
  // identifiers external callers will see. Logged once per process — same
  // data on every reconnect would just be noise. Skipped silently when the
  // agentId fails the Mentionable local rule (rare; uuid-prefixed ids match
  // the regex), since mention/acct/webfinger aren't meaningful in that case
  // and the operator can still get a coherent answer from `whoami`.
  private logIdentityOnce(): void {
    if (this.identityLogged) return;
    this.identityLogged = true;
    const id = deriveIdentity(this.opts.agentId, this.opts.serverUrl);
    if (!id) return;
    this.logger.info(`agentId:    ${safeToken(id.agentId)}`);
    this.logger.info(`mention:    ${safeToken(formatMention(id))}`);
    this.logger.info(`acct:       ${safeToken(formatAcct(id))}`);
    this.logger.info(`a2a:        ${safeToken(a2aEndpoint(id))}`);
    this.logger.info(`a2a card:   ${safeToken(a2aCardUrl(id))}`);
    this.logger.info(`webfinger:  ${safeToken(webfingerUrl(id))}`);
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
        this.logIdentityOnce();
        ws.send(
          encodeFrame({
            type: 'hello',
            agentId: this.opts.agentId,
            ...(agentCard ? { agentCard } : {}),
            backendKind: this.opts.backendKind,
            version: PROTOCOL_VERSION,
            token: this.opts.token,
            protocolCapabilities: [CALLER_CONTEXT_CAPABILITY],
          }),
        );
        // Immediately behind the hello, on this same socket, so the replay is
        // the first thing the server sees for these tasks — before any frame
        // the backend produces next.
        this.flushPendingFrames(ws);
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
        case 'usage.request':
          this.handleUsageRequest(frame);
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
      if (!current) return;
      this.ws = null;
      // The connection died without ever proving itself, so anything we
      // replayed onto it may never have been processed. Put it back.
      this.requeueReplay();
      // 4003 "expected hello" means this bridge predates the pre-auth queueing
      // that pipelined replay depends on — it rejected our frames for arriving
      // while it was still authenticating. Retrying would loop forever, so drop
      // back to the pre-buffer behavior and say so loudly: a bridge upgrade is
      // what restores it.
      if (code === 4003) {
        this.replaySupported = false;
        this.logger.warn(
          'bridge rejected buffered replay (4003); it predates reconnect replay support — ' +
            'output produced during a disconnect will be dropped until the bridge is upgraded',
        );
        this.dropPendingFrames();
      }
      // Terminal auth failures the daemon cannot recover from by waiting:
      //
      //   - **4014 "client deleted"** (issue #166). The DB row was just
      //     hard-deleted by an owner-side `vicoop-client agent delete`.
      //     Future hellos will be rejected with 4005 anyway (the row is
      //     gone), so we exit immediately rather than wait one more
      //     reconnect cycle.
      //
      //   - **4005 "bad token"**. ws.ts only emits 4005 after a
      //     `SELECT … WHERE token_hash = $1` returns no row — either the
      //     token is wrong (operator copy/paste, or daemon was relaunched
      //     after deletion without rotating) or the row was deleted and
      //     the daemon missed the live 4014 close. In both cases the
      //     failure is permanent: no amount of backoff produces a row
      //     that matches. Looping just spams the bridge.
      //
      // Other close codes (4001-4004 / 4006-4013) might be transient or
      // bug-shaped but are out of scope for this PR — they continue to
      // hit scheduleReconnect.
      //
      // We tear down our own reconnect state and delegate the
      // process-lifecycle decision to `onFatal`. The production
      // entrypoint exits non-zero so systemd / a parent supervisor
      // surfaces the failure instead of masking it as a transient
      // network hiccup.
      if (code === 4014 || code === 4005) {
        const label = code === 4014 ? 'client deleted by owner' : 'bridge rejected token';
        this.logger.error(`${label}; stopping (code=${code})`);
        this.stopped = true;
        this.clearReconnectTimer();
        for (const controller of this.inflight.values()) controller.abort();
        // Nothing will ever replay these — this daemon is not reconnecting. The
        // host process may keep running (onFatal owns that decision), so
        // release the buffer rather than hold it for a reconnect that is not
        // coming.
        this.dropPendingFrames();
        this.opts.onFatal?.({ code, reason: reason.toString() });
        return;
      }
      // 4009 = another daemon registered with the same CLIENT_TOKEN (the
      // token that authenticates the client_id row; 4009 fires when the
      // bridge sees two live registrations resolving to the same
      // clientId — see registry.ts) and the bridge replaced us. The
      // "disconnected: 4009 …" line above already logs the sanitized
      // reason, but on its own it reads like any other disconnect —
      // operators have to know the close-code table to recognize the
      // duplicate-token failure mode. Surface a dedicated WARN with the
      // concrete remediation so the foreground log names both the cause
      // and the fix on one line (vicoop-bridge#270).
      //
      // We deliberately do NOT treat this as fatal: if the other daemon
      // exits (operator kills it, or it crashes), this side should still
      // recover automatically. But the default ~30 s exponential backoff
      // is far too eager — two daemons running concurrently will ping-pong
      // at the 30 s cap forever, never letting either reach the 60 s
      // stable window that resets the attempt counter. Floor the next
      // reconnect at `collisionBackoffMs` (5 min by default) so the
      // ping-pong damps out after a single cycle.
      if (code === 4009) {
        this.logger.warn(
          'another vicoop-client is connected with the same CLIENT_TOKEN — ' +
            'kill duplicates (`pgrep -fl vicoop-client`) or this daemon will keep being replaced',
        );
        this.scheduleReconnect(this.opts.collisionBackoffMs ?? DEFAULT_COLLISION_BACKOFF_MS);
        return;
      }
      this.scheduleReconnect();
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
      this.confirmReplay();
      return;
    }
    this.reconnectResetTimer = setTimeout(() => {
      this.reconnectResetTimer = null;
      if (!this.stopped && this.ws === ws && ws.readyState === WebSocket.OPEN) {
        this.reconnectAttempt = 0;
        // The same signal that says this connection is real says the replay
        // landed: a bridge that was going to reject it would have closed by now.
        this.confirmReplay();
      }
    }, stableMs);
    this.reconnectResetTimer.unref?.();
  }

  private scheduleReconnect(floorMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    // `floorMs` lets specific close codes (currently only 4009 duplicate-
    // token collision) raise the delay above the computed backoff. It only
    // raises, never lowers — a transient close that happens to schedule
    // after a collision-floored cycle still uses the normal backoff. Pure
    // additive change: omitting the argument preserves the previous
    // behavior byte-for-byte.
    const computed = this.nextReconnectDelay(attempt);
    const delay = floorMs !== undefined ? Math.max(computed, floorMs) : computed;
    this.logger.info(`reconnecting in ${delay}ms attempt=${attempt + 1}`);
    // Intentionally NOT unref'd. By the time we get here the WS is gone and
    // the heartbeat / reconnect-reset timers have been cleared, so this timer
    // is the only handle keeping a disconnected daemon up until reconnect
    // fires — signal listeners alone don't ref the event loop. Unref'ing it
    // (a previous revision did) caused the process to exit on the first
    // disconnect, killing the entire reconnect/backoff path. `stop()` clears
    // this timer explicitly via `clearReconnectTimer()`, so intentional
    // shutdown still exits cleanly. See issue #156.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info(`reconnect attempt=${attempt + 1}`);
      this.connect();
    }, delay);
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFrame(frame));
      return;
    }
    this.bufferUnsent(frame);
  }

  // Queue a frame the socket could not take. Only task-scoped frames are worth
  // keeping: `pong` answers a ping that has long since timed out, and
  // `usage.response` answers a requestId the server forgot when the connection
  // died. Replaying either would be noise at best.
  private bufferUnsent(frame: UpFrame): void {
    if (this.stopped) return;
    if (!('taskId' in frame)) return;
    const limit = this.opts.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
    const byteLimit = this.opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    if (limit <= 0 || byteLimit <= 0) return;

    const encoded = encodeFrame(frame);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > byteLimit) {
      // A single frame nobody could ever replay. Buffering it would evict the
      // whole rest of the queue for nothing.
      this.markTruncated(frame.taskId, `frame of ${bytes} bytes exceeds the ${byteLimit}-byte buffer`);
      return;
    }

    this.pendingFrames.push({ taskId: frame.taskId, encoded, bytes, at: Date.now() });
    this.pendingBytes += bytes;
    // Drop the OLDEST first, so what survives is the tail nearest the terminal
    // — but record each victim's task, because a partial replay of a text
    // stream is exactly the silent hole this buffer exists to prevent.
    while (this.pendingFrames.length > limit || this.pendingBytes > byteLimit) {
      const dropped = this.pendingFrames.shift();
      if (!dropped) break;
      this.pendingBytes -= dropped.bytes;
      this.markTruncated(
        dropped.taskId,
        `offline frame buffer full (${this.pendingFrames.length + 1}/${limit} frames, ${this.pendingBytes + dropped.bytes}/${byteLimit} bytes)`,
      );
    }
  }

  private markTruncated(taskId: string, why: string): void {
    if (this.truncatedTasks.has(taskId)) return;
    if (this.truncatedTasks.size >= MAX_TRUNCATED_TASKS) {
      // Degrade to the pre-buffer behavior for further tasks rather than let
      // the bookkeeping outgrow the buffer it describes: the server's own grace
      // expiry still fails them, just without our explicit reason.
      this.logger.warn(
        `truncated-task list full (${MAX_TRUNCATED_TASKS}); task ${safeToken(taskId)} will be left to the bridge's grace expiry`,
      );
      return;
    }
    this.truncatedTasks.add(taskId);
    this.logger.warn(
      `${why}; task ${safeToken(taskId)} will be failed instead of replayed`,
    );
  }

  // Replay buffered frames onto a freshly authenticated connection, in the
  // order they were produced. Sent on the captured socket rather than through
  // `send()` so a replay can never re-enter the buffer and loop.
  //
  // These are pipelined immediately behind `hello`: the server queues frames
  // that arrive while its (async) authentication is still settling and
  // processes them once it completes, so no ack round-trip is needed.
  private flushPendingFrames(ws: WebSocket): void {
    if (this.pendingFrames.length === 0 && this.truncatedTasks.size === 0) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!this.replaySupported) {
      this.dropPendingFrames();
      return;
    }

    // Anything the server would no longer honour is not merely useless to send,
    // it is dangerous: the binding is gone and a new run may already hold that
    // taskId. Fail those tasks instead of injecting a dead run's output.
    const maxAge = this.opts.maxPendingAgeMs ?? DEFAULT_MAX_PENDING_AGE_MS;
    const cutoff = Date.now() - maxAge;
    const fresh: typeof this.pendingFrames = [];
    for (const entry of this.pendingFrames) {
      if (entry.at < cutoff) {
        this.markTruncated(entry.taskId, `buffered output is older than ${maxAge}ms`);
        continue;
      }
      fresh.push(entry);
    }

    const truncated = this.truncatedTasks;
    this.pendingFrames = [];
    this.pendingBytes = 0;
    this.truncatedTasks = new Set();

    let replayed = 0;
    for (const entry of fresh) {
      if (truncated.has(entry.taskId)) continue;
      ws.send(entry.encoded);
      // Retained, not discarded: if this connection turns out to be unusable
      // the frames go back on the queue instead of vanishing.
      this.replayInFlight.push(entry);
      replayed++;
    }
    for (const taskId of truncated) {
      this.inflight.get(taskId)?.abort();
      ws.send(
        encodeFrame({
          type: 'task.fail',
          taskId,
          error: {
            code: 'client_buffer_overflow',
            message: 'output was lost while the bridge connection was down',
          },
        }),
      );
    }
    this.logger.info(
      `replayed ${replayed} buffered frame(s) after reconnect` +
        (truncated.size > 0 ? `; failed ${truncated.size} truncated task(s)` : ''),
    );
  }

  // The replay reached a connection that stayed up — let it go.
  private confirmReplay(): void {
    if (this.replayInFlight.length === 0) return;
    this.replayInFlight = [];
  }

  // The connection died before proving itself. Put the replay back at the FRONT
  // of the queue so ordering against anything produced since is preserved.
  private requeueReplay(): void {
    if (this.replayInFlight.length === 0) return;
    const back = this.replayInFlight;
    this.replayInFlight = [];
    this.pendingFrames = [...back, ...this.pendingFrames];
    this.pendingBytes += back.reduce((n, e) => n + e.bytes, 0);
  }

  private dropPendingFrames(): void {
    this.pendingFrames = [];
    this.replayInFlight = [];
    this.pendingBytes = 0;
    this.truncatedTasks.clear();
  }

  // Answer a server-initiated usage.request by querying the backend's optional
  // usage() capability. Fire-and-forget (errors surface as usage.response with
  // ok:false rather than throwing) so it never stalls the message loop.
  private handleUsageRequest(
    frame: import('@vicoop-bridge/protocol').UsageRequestFrame,
  ): void {
    const backend = this.opts.backend;
    if (!backend.usage) {
      this.send({
        type: 'usage.response',
        requestId: frame.requestId,
        ok: false,
        error: {
          code: 'unsupported',
          message: `backend '${backend.name}' does not support usage queries`,
        },
      });
      return;
    }
    this.logger.info(`usage.request requestId=${safeToken(frame.requestId)}`);
    backend.usage().then(
      (usage) => {
        this.send({ type: 'usage.response', requestId: frame.requestId, ok: true, usage });
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `usage.request failed requestId=${safeToken(frame.requestId)}: ${safeToken(message)}`,
        );
        this.send({
          type: 'usage.response',
          requestId: frame.requestId,
          ok: false,
          error: { code: 'usage_failed', message },
        });
      },
    );
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

// Diagnostic (issue #414): is this `task.status` frame's metadata the tagged
// liveness-heartbeat marker (`metadata[<URI>].heartbeat === true`)? Other
// `task.status` frames (initial working, progress) don't count as beats.
function isHeartbeatStatusFrame(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false;
  const ext = (metadata as Record<string, unknown>)[OPENAI_COMPAT_EXTENSION_URI];
  if (typeof ext !== 'object' || ext === null) return false;
  return (ext as Record<string, unknown>).heartbeat === true;
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
    // Diagnostic counter (issue #414): liveness-heartbeat `task.status` frames
    // this task emitted onto the wire (hop 1). Surfaced on the lifecycle log so
    // a router stall can be checked against whether the client actually emitted
    // heartbeats during a long silent turn — a ~0 count over a multi-minute task
    // means the beats never fired/left; a healthy count (~elapsedMs/10s) shifts
    // suspicion downstream (server forward / router re-arm).
    heartbeats: number;
    terminal:
      | { kind: 'complete' }
      | { kind: 'canceled' }
      | { kind: 'fail'; code: string; message: string }
      | null;
  } = { artifactIds: new Set(), heartbeats: 0, terminal: null };

  // Wrap emit so we can observe terminal frames the backend sends and
  // report taskId/elapsedMs/artifacts/code from the same code path,
  // without changing the wire-level frames or inspecting their payloads.
  // A `task.complete` with `status.state === 'canceled'` is the codebase's
  // existing cancellation convention (see backends/claude.ts); record it
  // distinctly so the lifecycle log doesn't mislabel cancels as completions.
  const emit: Emit = (f) => {
    if (f.type === 'task.artifact') state.artifactIds.add(f.artifact.artifactId);
    else if (f.type === 'task.status' && isHeartbeatStatusFrame(f.metadata)) {
      state.heartbeats += 1;
    } else if (f.type === 'task.complete') {
      state.terminal =
        f.status.state === 'canceled' ? { kind: 'canceled' } : { kind: 'complete' };
    } else if (f.type === 'task.fail') {
      state.terminal = {
        kind: 'fail',
        code: f.error.code,
        message: f.error.message ?? '',
      };
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
        `backend.end taskId=${taskTok} elapsedMs=${elapsedMs} heartbeats=${state.heartbeats} (no terminal frame)`,
      );
    } else if (terminal.kind === 'complete') {
      deps.logger.info(
        `task.complete taskId=${taskTok} elapsedMs=${elapsedMs} artifacts=${state.artifactIds.size} heartbeats=${state.heartbeats}`,
      );
    } else if (terminal.kind === 'canceled') {
      deps.logger.info(
        `task.canceled taskId=${taskTok} elapsedMs=${elapsedMs} artifacts=${state.artifactIds.size} heartbeats=${state.heartbeats}`,
      );
    } else {
      // Surface error.message alongside the code so operators can debug
      // failures from the foreground log alone (#147). Backends embed
      // stderr tails, exit-status detail, and other diagnostic context
      // there; previously the code-only line forced operators to enable
      // wire-frame tracing on the bridge just to see why a task failed.
      // Use a generous cap because backend messages legitimately include
      // multi-line stderr excerpts — safeToken still escapes newlines so
      // the log stays single-line.
      const msgPart = terminal.message
        ? ` message=${safeToken(terminal.message, 4000)}`
        : '';
      deps.logger.info(
        `task.fail taskId=${taskTok} code=${safeToken(terminal.code)} elapsedMs=${elapsedMs} heartbeats=${state.heartbeats}${msgPart}`,
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
        `task.canceled taskId=${taskTok} elapsedMs=${elapsedMs} artifacts=${state.artifactIds.size} heartbeats=${state.heartbeats}`,
      );
    } else {
      const code = 'backend_error';
      deps.send({
        type: 'task.fail',
        taskId: frame.taskId,
        error: { code, message },
      });
      const msgPart = message ? ` message=${safeToken(message, 4000)}` : '';
      deps.logger.info(
        `task.fail taskId=${taskTok} code=${code} elapsedMs=${elapsedMs} heartbeats=${state.heartbeats}${msgPart}`,
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
