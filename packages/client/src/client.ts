import WebSocket from 'ws';
import {
  CALLER_CONTEXT_CAPABILITY,
  PROTOCOL_VERSION,
  OPENAI_COMPAT_EXTENSION_URI,
  TASK_REPLAY_CAPABILITY,
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
  // Exact receiver-local VC issuer trust sent only on the authenticated hello.
  trustedIdentityIssuers?: string[];
  maxConcurrency?: number;
  // Initial reconnect delay after an unintentional disconnect. Retries use
  // exponential backoff from this value up to `reconnectMaxDelayMs`.
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  reconnectStableMs?: number;
  // Maximum number of unacknowledged task frames retained across reconnects.
  // Setting any retention bound to `0` keeps sequencing/gap detection but
  // disables retry retention and aborts reliable runs when their socket drops.
  maxPendingFrames?: number;
  // Companion byte budget for the encoded unacknowledged frames.
  // `0` has the retention-disable behavior described above.
  maxPendingBytes?: number;
  // Maximum age of an unacknowledged frame. Execution IDs make stale frames safe
  // to drop independently of the server's configured grace.
  // `0` has the retention-disable behavior described above.
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
// Bounds apply to unacknowledged frames, not merely frames produced while the
// socket is visibly down. WebSocket OPEN/send success is not proof of server
// acceptance; task.ack is.
const DEFAULT_MAX_PENDING_FRAMES = 2_000;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_AGE_MS = 60_000;
const DEFAULT_RECONNECT_STABLE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_COLLISION_BACKOFF_MS = 300_000;

type TaskUpFrame = Extract<UpFrame, { taskId: string }>;
interface ClientRun {
  controller: AbortController;
  suppressed: boolean;
  executionId?: string;
  nextSeq: number;
}
interface PendingFrame {
  taskId: string;
  executionId: string;
  seq: number;
  encoded: string;
  bytes: number;
  createdAt: number;
}

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
  private inflight = new Map<string, ClientRun>();
  // Resolved once per process via backend.resolveCapabilities(); the bridge
  // hello frame is held until this settles so the advertised card matches the
  // backend's actual upstream capability. Cached across reconnects so we
  // don't re-probe on every bridge WS reconnect — the underlying upstream
  // doesn't change mid-process.
  private effectiveCardPromise: Promise<AgentCard | undefined> | null = null;
  // Reliable frames stay here until the bridge cumulatively acknowledges their
  // execution-local sequence. Reconnect simply resends the same generations and
  // sequences; the bridge deduplicates them and detects gaps.
  private pendingFrames: PendingFrame[] = [];
  private pendingBytes = 0;
  private pendingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  // False until the authenticated server replies with hello.ack on each
  // connection. This prevents replay from racing asynchronous authentication.
  private replayReady = false;
  private negotiatedMaxFrameBytes: number | null = null;
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
    for (const run of this.inflight.values()) {
      run.suppressed = true;
      run.controller.abort();
    }
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
    this.replayReady = false;
    this.negotiatedMaxFrameBytes = null;
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
            protocolCapabilities: [CALLER_CONTEXT_CAPABILITY, TASK_REPLAY_CAPABILITY],
            ...(this.opts.trustedIdentityIssuers !== undefined
              ? {
                  identityTrust: {
                    trustedIssuers: this.opts.trustedIdentityIssuers,
                  },
                }
              : {}),
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

      // A replaced socket may still have already-queued message callbacks.
      // Once another connection owns `this.ws`, no frame from this socket may
      // mutate task generations, acknowledgements, or in-flight runs.
      if (this.ws !== ws) return;

      switch (frame.type) {
        case 'hello.ack':
          if (!frame.protocolCapabilities.includes(TASK_REPLAY_CAPABILITY)) return;
          this.replayReady = true;
          this.negotiatedMaxFrameBytes = frame.maxFrameBytes;
          this.flushPendingFrames(ws);
          break;
        case 'task.ack':
          this.acknowledgeFrames(frame.executionId, frame.acceptedSeq);
          break;
        case 'task.assign':
          // A task assignment without an execution ID came from a legacy bridge.
          // It is proof that authentication finished, but reconnect replay is
          // intentionally unavailable on that connection.
          if (frame.executionId === undefined) this.replayReady = false;
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
          {
            const run = this.inflight.get(frame.taskId);
            if (run && (frame.executionId === undefined || frame.executionId === run.executionId)) {
              // A generation-scoped cancel is also the server's fail-closed
              // signal (for example after detecting a sequence gap). No later
              // frame from this generation can be accepted, so release its
              // retained prefix and suppress the backend's abort terminal.
              if (frame.executionId !== undefined) {
                run.suppressed = true;
                this.removePendingExecution(frame.executionId);
              }
              run.controller.abort();
            }
          }
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
      // Legacy frames, and reliable runs whose retention was explicitly
      // disabled, cannot safely continue after losing their socket. Stop them
      // so output produced during the outage is never silently discarded.
      // Retained reliable runs resume after the next hello.ack.
      for (const run of this.inflight.values()) {
        if (run.executionId !== undefined && this.pendingRetentionEnabled()) continue;
        run.suppressed = true;
        run.controller.abort();
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
        for (const run of this.inflight.values()) {
          run.suppressed = true;
          run.controller.abort();
        }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(frame));
  }

  private sendTaskFrame(run: ClientRun, frame: TaskUpFrame): void {
    if (run.suppressed) return;
    if (run.executionId === undefined) {
      this.send(frame);
      return;
    }

    const seq = run.nextSeq++;
    const reliableFrame = { ...frame, executionId: run.executionId, seq } as TaskUpFrame;
    const encoded = encodeFrame(reliableFrame);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    const frameLimit = this.pendingFrameLimit();
    const byteLimit = this.pendingByteLimit();
    const ageLimit = this.pendingAgeLimit();
    const retentionEnabled = frameLimit > 0 && byteLimit > 0 && ageLimit > 0;
    const maxFrameBytes = this.negotiatedMaxFrameBytes;

    if (
      (maxFrameBytes !== null && bytes > maxFrameBytes) ||
      (retentionEnabled && bytes > byteLimit) ||
      (retentionEnabled && this.pendingFrames.length >= frameLimit) ||
      (retentionEnabled && this.pendingBytes + bytes > byteLimit)
    ) {
      const why =
        `unacknowledged frame buffer limit exceeded for task ${safeToken(frame.taskId)}`;
      this.failReliableRun(
        run,
        why,
        false,
      );
      // Replace the frame that could not be retained with a small terminal at
      // the same sequence. On a healthy-looking socket this gives the bridge a
      // precise failure instead of making it wait for reconnect grace and then
      // report a generic disconnect. The send callback terminates only after
      // `ws` has flushed the best-effort terminal to the transport.
      this.sendReliableFailureAndDisconnect(run.executionId, frame.taskId, seq, {
        code: 'client_buffer_overflow',
        message: 'client unacknowledged frame buffer limit exceeded',
      });
      return;
    }

    if (retentionEnabled) {
      this.pendingFrames.push({
        taskId: frame.taskId,
        executionId: run.executionId,
        seq,
        encoded,
        bytes,
        createdAt: Date.now(),
      });
      this.pendingBytes += bytes;
      this.schedulePendingExpiry();
    }
    if (this.replayReady && this.ws?.readyState === WebSocket.OPEN) {
      this.sendEncoded(this.ws, encoded);
    }
  }

  private flushPendingFrames(ws: WebSocket): void {
    if (!this.replayReady || ws.readyState !== WebSocket.OPEN) return;
    this.expirePendingFrames();
    if (!this.replayReady || ws.readyState !== WebSocket.OPEN) return;
    for (const entry of this.pendingFrames) {
      if (
        this.negotiatedMaxFrameBytes !== null &&
        entry.bytes > this.negotiatedMaxFrameBytes
      ) {
        const why =
          `retained frame exceeds the negotiated limit for task ${safeToken(entry.taskId)}`;
        const run = [...this.inflight.values()].find(
          (candidate) => candidate.executionId === entry.executionId,
        );
        if (run) this.failReliableRun(run, why, false);
        else {
          this.removePendingExecution(entry.executionId);
          this.logger.error(`${why}; suppressing the execution so the bridge fails it closed`);
        }
        // Entries earlier in this loop have already been queued in sequence.
        // Replace the first oversized one at its own sequence with a bounded
        // terminal, then reconnect so other executions can replay cleanly.
        this.sendReliableFailureAndDisconnect(entry.executionId, entry.taskId, entry.seq, {
          code: 'client_buffer_overflow',
          message: 'retained client frame exceeds the negotiated server limit',
        });
        return;
      }
      this.sendEncoded(ws, entry.encoded);
    }
    if (this.pendingFrames.length > 0) {
      this.logger.info(`replayed ${this.pendingFrames.length} unacknowledged frame(s) after reconnect`);
    }
  }

  private sendEncoded(ws: WebSocket, encoded: string): void {
    try {
      ws.send(encoded, (err) => {
        if (!err || this.ws !== ws) return;
        this.logger.warn(`task frame send failed (${safeToken(err.message)}); reconnecting`);
        ws.terminate();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`task frame send threw (${safeToken(message)}); reconnecting`);
      if (this.ws === ws) ws.terminate();
    }
  }

  private acknowledgeFrames(executionId: string, acceptedSeq: number): void {
    let removed = 0;
    this.pendingFrames = this.pendingFrames.filter((entry) => {
      if (entry.executionId !== executionId || entry.seq > acceptedSeq) return true;
      this.pendingBytes -= entry.bytes;
      removed++;
      return false;
    });
    this.schedulePendingExpiry();
    if (removed > 0) this.logger.debug(`acknowledged ${removed} task frame(s)`);
  }

  private failReliableRun(run: ClientRun, why: string, disconnect: boolean): void {
    if (run.suppressed) return;
    run.suppressed = true;
    run.controller.abort();
    if (run.executionId !== undefined) this.removePendingExecution(run.executionId);
    this.logger.error(`${why}; suppressing the run so the bridge fails it closed`);
    if (disconnect && this.ws?.readyState === WebSocket.OPEN) this.ws.terminate();
  }

  private sendReliableFailureAndDisconnect(
    executionId: string,
    taskId: string,
    seq: number,
    error: { code: string; message: string },
  ): void {
    const ws = this.ws;
    if (!this.replayReady || !ws || ws.readyState !== WebSocket.OPEN) {
      if (ws?.readyState === WebSocket.OPEN) ws.terminate();
      return;
    }

    const encoded = encodeFrame({
      type: 'task.fail',
      taskId,
      executionId,
      seq,
      error,
    });
    if (
      this.negotiatedMaxFrameBytes !== null &&
      Buffer.byteLength(encoded, 'utf8') > this.negotiatedMaxFrameBytes
    ) {
      ws.terminate();
      return;
    }

    try {
      ws.send(encoded, (err) => {
        if (err) {
          this.logger.warn(
            `best-effort task failure send failed (${safeToken(err.message)}); reconnecting`,
          );
        }
        if (this.ws === ws) ws.terminate();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `best-effort task failure send threw (${safeToken(message)}); reconnecting`,
      );
      if (this.ws === ws) ws.terminate();
    }
  }

  private removePendingExecution(executionId: string): void {
    this.pendingFrames = this.pendingFrames.filter((entry) => {
      if (entry.executionId !== executionId) return true;
      this.pendingBytes -= entry.bytes;
      return false;
    });
    this.schedulePendingExpiry();
  }

  private pendingFrameLimit(): number {
    const value = this.opts.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_MAX_PENDING_FRAMES;
  }

  private pendingByteLimit(): number {
    const value = this.opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_MAX_PENDING_BYTES;
  }

  private pendingAgeLimit(): number {
    const value = this.opts.maxPendingAgeMs ?? DEFAULT_MAX_PENDING_AGE_MS;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_MAX_PENDING_AGE_MS;
  }

  private pendingRetentionEnabled(): boolean {
    return (
      this.pendingFrameLimit() > 0 &&
      this.pendingByteLimit() > 0 &&
      this.pendingAgeLimit() > 0
    );
  }

  private schedulePendingExpiry(): void {
    if (this.pendingExpiryTimer !== null) {
      clearTimeout(this.pendingExpiryTimer);
      this.pendingExpiryTimer = null;
    }
    const ageLimit = this.pendingAgeLimit();
    const oldest = this.pendingFrames[0];
    if (!oldest || ageLimit <= 0) return;
    const delay = Math.max(0, oldest.createdAt + ageLimit - Date.now());
    this.pendingExpiryTimer = setTimeout(() => {
      this.pendingExpiryTimer = null;
      this.expirePendingFrames();
    }, delay);
    this.pendingExpiryTimer.unref?.();
  }

  private expirePendingFrames(): void {
    const ageLimit = this.pendingAgeLimit();
    if (ageLimit <= 0 || this.pendingFrames.length === 0) return;
    const cutoff = Date.now() - ageLimit;
    const expiredExecutions = new Set(
      this.pendingFrames
        .filter((entry) => entry.createdAt <= cutoff)
        .map((entry) => entry.executionId),
    );
    for (const executionId of expiredExecutions) {
      const run = [...this.inflight.values()].find((candidate) => candidate.executionId === executionId);
      if (run) {
        this.failReliableRun(
          run,
          `unacknowledged replay expired after ${ageLimit}ms`,
          this.ws?.readyState === WebSocket.OPEN,
        );
      } else {
        this.removePendingExecution(executionId);
        // A backend may already have returned after emitting its terminal, so
        // its run is no longer in `inflight` even though that terminal remains
        // unacknowledged. Dropping it while keeping a half-dead socket open can
        // strand the server binding forever: there is nothing left to replay
        // or abort. Force the normal disconnect/grace path to settle it.
        this.logger.error(
          `unacknowledged replay expired after ${ageLimit}ms; disconnecting so the bridge fails it closed`,
        );
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.terminate();
      }
    }
    this.schedulePendingExpiry();
  }

  private dropPendingFrames(): void {
    if (this.pendingExpiryTimer !== null) clearTimeout(this.pendingExpiryTimer);
    this.pendingExpiryTimer = null;
    this.pendingFrames = [];
    this.pendingBytes = 0;
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
    const previous = this.inflight.get(frame.taskId);
    if (previous) {
      previous.suppressed = true;
      previous.controller.abort();
      if (previous.executionId !== undefined) this.removePendingExecution(previous.executionId);
    }
    const controller = new AbortController();
    const run: ClientRun = {
      controller,
      suppressed: false,
      ...(frame.executionId !== undefined ? { executionId: frame.executionId } : {}),
      nextSeq: 0,
    };
    this.inflight.set(frame.taskId, run);
    try {
      await processTask(frame, controller.signal, {
        backend: this.opts.backend,
        // A suppressed run is over as far as the bridge is concerned; anything
        // still trickling out of the backend must not reach a taskId that may
        // now belong to someone else.
        send: (f) => {
          if (run.suppressed) return;
          this.sendTaskFrame(run, f as TaskUpFrame);
        },
        logger: this.logger,
      });
    } finally {
      if (this.inflight.get(frame.taskId) === run) this.inflight.delete(frame.taskId);
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
