import type { WebSocket } from 'ws';
import type { AgentCard, DownFrame, TaskUsage } from '@vicoop-bridge/protocol';
import { encodeFrame, TASK_REPLAY_CAPABILITY } from '@vicoop-bridge/protocol';
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2x/sdk';
import { logEvent, truncate } from './log.js';
import { terminalErrorMessageFields } from './terminal-error.js';
import type { X402Pricing } from './x402/pricing.js';

export interface ClientConnection {
  agentId: string;
  clientId: string;
  ownerPrincipal: string;
  // Owner's email (device-flow registrations); null for SIWE-onboarded clients
  // that only have a wallet principal. Carried for observability/logging.
  ownerEmail?: string | null;
  // Canonical backend kind (e.g. "claude", "codex", "vicoop-codex"); undefined
  // when the client supplied an inline agent card. Used for logging the backend.
  backendKind?: string;
  // Optional protocol features advertised on the authenticated hello. Kept
  // connection-scoped so executor dispatch can preserve old-client wire
  // compatibility without falling back to caller-controlled metadata.
  protocolCapabilities?: string[];
  agentCard: AgentCard;
  allowedCallers: string[];
  // x402 pricing from the agent's DB row, or undefined for a free agent (the
  // default). DB-sourced, never read off the hello frame: `payTo` names the
  // wallet that gets paid, so the same trust boundary applies as to
  // `allowedCallers`.
  x402Pricing?: X402Pricing;
  ws: WebSocket;
  connectedAt: number;
}

/**
 * Sink owned by the executor for a live task. WS frames inbound from the
 * client are translated into `TaskArtifactUpdateEvent`/`TaskStatusUpdateEvent`
 * and pushed here; the executor's `executeStream()` yields from it.
 */
export interface TaskSink {
  pushStatus(event: TaskStatusUpdateEvent): void;
  pushArtifact(event: TaskArtifactUpdateEvent): void;
  finish(): void;
}

export interface TaskBinding {
  agentId: string;
  taskId: string;
  // Unique to one dispatch/turn. A2A deliberately reuses taskId for
  // continuations, so reconnect replay must never use taskId as its generation
  // identity. Present only for clients that negotiated task-replay-v1.
  executionId?: string;
  // Next client sequence accepted for this binding. Frames below this value
  // are duplicates; frames above it prove a gap and must fail closed.
  nextClientSeq?: number;
  contextId: string;
  sink: TaskSink;
  // principalId of the caller that originated this task (post-auth). Optional
  // because public agents (allowedCallers.length === 0) skip the auth
  // middleware entirely, so there is no verified caller to record. The admin
  // route does not create TaskBindings — it has its own executor
  // (AdminA2XExecutor) that never calls registry.bindTask().
  principalId?: string;
  requestedExtensions?: string[];
  // Diagnostic counter (issue #414): number of liveness-heartbeat `task.status`
  // frames the server has received from the client and pushed to the sink for
  // this task. Surfaced on the terminal log so a router stall can be checked
  // against whether the server was actually forwarding heartbeats (hop 2) — a
  // high count with a stalled router points downstream (updateTask freeze /
  // router), a ~0 count points upstream (client never emitted). Lazily
  // initialized; incremented in ws.ts's `task.status` handler.
  heartbeats?: number;
  // Token consumption reported on the client's `task.complete` frame, stashed
  // here by ws.ts so the executor can price the task without re-deriving it
  // from wire metadata. Server-internal: it is billing input and is never
  // published back onto the A2A event. Set before the terminal status is
  // pushed to the sink, so it is always visible by the time the executor
  // reads the terminal event off the queue.
  usage?: TaskUsage;
}

export type CallerChangeListener = (agentId: string, callers: string[]) => void;
// Fires whenever the agent connection (including its embedded agentCard) is
// newly registered, replaced, or removed. Downstream consumers that cache
// objects derived from the card — e.g. the HTTP layer's per-agent
// A2XServer / DefaultRequestHandler, which captures the card snapshot at
// construction time — must evict on this signal, otherwise a client that
// reconnects with an updated card (say, `streaming: false` → `true`) will
// continue to be served by a transport built against the old card until the
// server restarts. Fires on first registration too so any transient cache
// entry left behind by a previous lifecycle (e.g. a lingering entry from
// before an unclean shutdown) is cleared unconditionally.
export type AgentChangeListener = (agentId: string) => void;

// Reconnect grace hold (issue #474). A WS drop that the client recovers from
// used to fail every in-flight task instantly, and the results the client sent
// after reconnecting were discarded as `dropped_terminal_frame` — a 3s infra
// blip became a minute-long outage downstream. Instead we keep the binding
// alive for this long and let the reconnected client's frames land on it.
//
// Sized off the incident: the terminal frames arrived +9s / +10s / +15s after
// the drop, so the hold has to cover TASK COMPLETION, not just reconnect time
// (3.2s). 30s gives 2x margin over the worst observed frame. It is not a cap on
// task duration — a single frame (heartbeat included) on the new connection
// resumes the binding outright, after which the executor's own 10-minute
// inactivity backstop is what governs.
//
// `0` disables the hold and restores the previous fail-immediately behavior.
export const FALLBACK_DISCONNECT_GRACE_MS = 30_000;
// Node's setTimeout silently clamps anything past the signed-32-bit ceiling to
// 1ms, so an operator who typed a very large number to mean "hold a long time"
// would get the opposite — holds that expire immediately. Cap instead, so the
// value can only ever mean what it says.
export const MAX_DISCONNECT_GRACE_MS = 2_147_483_647;

/**
 * Parse `BRIDGE_DISCONNECT_GRACE_MS`. Exported so the production configuration
 * path — the one `new Registry()` actually takes — is reachable from tests;
 * every grace test injects its value through the constructor, so without this
 * a typo'd default or broken parse would ship green.
 *
 * Returns the effective grace plus why, so the caller can say so out loud
 * rather than silently coercing. A negative value is rejected rather than
 * treated as "off": `0` is the documented disable switch, and `-1` is a common
 * enough idiom for it that silently re-enabling a 30s hold would be the exact
 * opposite of what the operator asked for.
 */
export function resolveDisconnectGraceMs(raw: string | undefined): {
  ms: number;
  source: 'default' | 'env' | 'clamped' | 'invalid';
} {
  // Trim first: `Number(' ')` is 0, so a whitespace-only value would otherwise
  // read as a deliberate `0` and silently disable recovery, when only a literal
  // `0` is documented as the kill switch.
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    return { ms: FALLBACK_DISCONNECT_GRACE_MS, source: 'default' };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    return { ms: FALLBACK_DISCONNECT_GRACE_MS, source: 'invalid' };
  }
  if (n > MAX_DISCONNECT_GRACE_MS) return { ms: MAX_DISCONNECT_GRACE_MS, source: 'clamped' };
  return { ms: n, source: 'env' };
}

const DEFAULT_DISCONNECT_GRACE_MS = (() => {
  const resolved = resolveDisconnectGraceMs(process.env.BRIDGE_DISCONNECT_GRACE_MS);
  // Emitted once at module load. The grace decides whether a task survives a
  // drop, and `0` is the rollback lever, so an operator must never have to read
  // the source to find out which one is in effect.
  logEvent('disconnect_grace_configured', {
    graceMs: resolved.ms,
    source: resolved.source,
    ...(resolved.source === 'invalid' || resolved.source === 'clamped'
      ? { requested: truncate(String(process.env.BRIDGE_DISCONNECT_GRACE_MS), 64) }
      : {}),
  });
  return resolved.ms;
})();

/**
 * Is this close code one we should wait out, rather than treat as proof the
 * client is gone?
 *
 * Deliberately a DENY-list, not an allow-list of "transient" codes. The server
 * has never recorded close codes (`client_disconnected` didn't carry one until
 * this change), so we have no data on which code its socket actually observes
 * when a proxy tears the connection down — the client saw `1012` in the
 * incident, but the server end may well see `1006`/`1005`. Enumerating
 * transient codes would be building on that guess. What we DO know exactly is
 * the set of terminal closes, because the bridge itself sends them:
 *
 *   - 4000-4999: this server's own app-level rejections (bad token, duplicate
 *     hello, client deleted, superseded, …). Every one is a decision that the
 *     connection must not continue, so the task is genuinely dead.
 *   - 1000: a clean, intentional close. Nothing to wait for.
 *
 * Everything else — abnormal closure, proxy restart, no code at all — gets the
 * hold.
 *
 * This test alone is not sufficient for closes WE initiate, because the code we
 * observe is the one our socket ends up with, not the one we sent: a peer that
 * never echoes the close frame leaves `ws` to time out and report `1006`. The
 * `serverClosed` WeakSet carries that intent separately; see its declaration.
 */
function isGraceableCloseCode(code: number | undefined): boolean {
  if (code === undefined) return true;
  if (code === 1000) return false;
  return code < 4000 || code > 4999;
}

// Shape of the terminal a binding is failed with. Named so the disconnect
// terminal can be declared once and reused by every path that emits it.
interface TerminalError {
  code: string;
  message: string;
  messageIdSuffix: string;
}

// The mid-task disconnect terminal, unchanged since before the grace hold: a
// task that outlives its hold must be indistinguishable downstream from one
// that failed instantly, so the router needs no new case.
const DISCONNECTED_ERROR: TerminalError = {
  code: 'disconnected',
  message: 'client disconnected mid-task',
  messageIdSuffix: 'disc',
};

interface GraceHold {
  timer: ReturnType<typeof setTimeout>;
  // Identity guard, same discipline as unbindTask: only the binding that was
  // held may be failed by its own timer. A rebind of the same taskId while the
  // hold is pending must never be collateral damage.
  binding: TaskBinding;
  // Diagnostics carried from the hold to whichever event ends it. `heldForMs`
  // on a resume is the one number that answers "is T long enough?" — the
  // distribution of how long real recoveries actually take.
  heldAt: number;
  via: 'disconnect' | 'reconnect';
  closeCode: number | undefined;
}

export class Registry {
  private agents = new Map<string, ClientConnection>();
  private bindings = new Map<string, TaskBinding>();
  // taskId -> pending grace hold. A binding in here is still present in
  // `bindings` and still fully serviceable; the entry only means "if nothing
  // arrives for this task before the timer fires, declare the client dead".
  private graceHolds = new Map<string, GraceHold>();
  // Recently completed reliable bindings. If the terminal ack is lost with
  // the socket, the client may replay that terminal after reconnect. Keeping a
  // short, bounded receipt lets us acknowledge the duplicate without ever
  // looking it up by a taskId that may now belong to another turn.
  private terminalReceipts = new Map<
    string,
    { agentId: string; taskId: string; acceptedSeq: number; expiresAt: number }
  >();
  // Sockets this server closed with a terminal verdict of its own. The close
  // CODE we later observe is not trustworthy for that decision: when we send
  // `close(4014)` and the peer never echoes the close frame — dead TCP, wedged
  // process, or a client that simply declines to — `ws` gives up after its
  // close timeout and emits the default `1006`, which is graceable. Without
  // this the deny-list would be advisory: a client could earn itself a grace
  // hold just by refusing to acknowledge being kicked. Recording the intent at
  // the moment we form it is the only reliable signal.
  //
  // A WeakSet so a socket that never reaches unregisterAgent (identity-guard
  // no-op, connection dropped before registration) cannot pin an entry.
  private serverClosed = new WeakSet<WebSocket>();
  private callerChangeListeners: CallerChangeListener[] = [];
  private agentChangeListeners: AgentChangeListener[] = [];

  constructor(private readonly disconnectGraceMs: number = DEFAULT_DISCONNECT_GRACE_MS) {}

  getDisconnectGraceMs(): number {
    return this.disconnectGraceMs;
  }

  rememberTerminalReceipt(binding: TaskBinding, acceptedSeq: number): void {
    if (!binding.executionId) return;
    const now = Date.now();
    this.pruneTerminalReceipts(now);
    this.terminalReceipts.set(binding.executionId, {
      agentId: binding.agentId,
      taskId: binding.taskId,
      acceptedSeq,
      expiresAt: now + Math.max(this.disconnectGraceMs, 60_000),
    });
    while (this.terminalReceipts.size > 10_000) {
      const oldest = this.terminalReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminalReceipts.delete(oldest);
    }
  }

  getTerminalReceipt(
    executionId: string,
    agentId: string,
    taskId: string,
  ): { acceptedSeq: number } | undefined {
    this.pruneTerminalReceipts(Date.now());
    const receipt = this.terminalReceipts.get(executionId);
    if (!receipt || receipt.agentId !== agentId || receipt.taskId !== taskId) return undefined;
    return { acceptedSeq: receipt.acceptedSeq };
  }

  private pruneTerminalReceipts(now: number): void {
    for (const [executionId, receipt] of this.terminalReceipts) {
      if (receipt.expiresAt > now) continue;
      this.terminalReceipts.delete(executionId);
    }
  }

  registerAgent(conn: ClientConnection): { ok: true } | { ok: false; reason: string } {
    const existing = this.agents.get(conn.agentId);
    if (existing) {
      if (existing.clientId === conn.clientId) {
        // Two daemons authenticated with the same CLIENT_TOKEN (so they
        // resolve to the same clientId row) and racing to register the
        // same agent. Surface a distinct structured event so fly logs /
        // admin tooling can spot flapping agents independently of the
        // normal client_connected / client_disconnected pair — without
        // this, a duplicate-token loop is indistinguishable from a flaky
        // network in aggregate logs.
        // agentId is user-controlled (hello frame), so truncate before
        // logging — same defense applied in notifyAgentChange below.
        logEvent('client_collision', {
          agentId: truncate(String(conn.agentId), 128),
          clientId: conn.clientId,
          previousConnectedAt: existing.connectedAt,
        });
        // Preserve a terminal verdict this server already made about the old
        // socket. It is policy intent, independent of the close code the peer
        // eventually echoes (or fails to echo), and a reconnect must not turn
        // a condemned connection back into a recoverable one.
        const displacedWasCondemned = this.serverClosed.has(existing.ws);
        // The close `reason` is what the client surfaces in its disconnect
        // log line. Spelling out the cause here means an operator reading
        // the foreground log can recognize the duplicate-token scenario
        // without cross-referencing close codes.
        existing.ws.close(4009, 'another client with the same token connected');
        // Deal with the displaced connection's in-flight tasks *before* swapping
        // the map. The old socket's close fires asynchronously and, by the time
        // its unregisterAgent runs, the map already points at `conn` — so the
        // ws-identity guard makes it a no-op and it can't clean these up. Doing
        // it here (while the bindings still belong to the old conn) is the only
        // point that sees them. The new conn hasn't bound any tasks yet, so
        // this only touches the superseded ones.
        //
        // These get the SAME grace hold the disconnect path gives them, and
        // that uniformity is the point (issue #474). Which path a recovered drop
        // takes is a pure race — the server may see the old socket's close first
        // (→ unregisterAgent) or the new hello first (→ here) — so both must
        // reach the same verdict, or the fix works only in the lucky ordering.
        //
        // An earlier revision tried to keep the old fail-fast behavior for the
        // "two live daemons share a CLIENT_TOKEN" case by testing
        // `readyState === OPEN` here. That is not a liveness test: it only says
        // the server has not OBSERVED a close. The server runs no keepalive of
        // its own, and the client is built to notice first — it pings every 30s
        // and terminates on a missed pong, which on a dead path never reaches
        // us. So the common client-detected drop arrives here with the old
        // socket still nominally OPEN and would be killed instantly: exactly the
        // bug #474 exists to fix, relabeled `superseded`.
        //
        // Holding a genuine collision instead is cheap: the second daemon does
        // not know the first one's taskIds, so it never sends frames for them
        // and the holds simply expire. We trade a more precise error code and T
        // seconds of latency for not misclassifying the case that actually
        // happens.
        //
        // The one exception is a connection this server already condemned (the
        // owner deleted the client). Its tasks are dead regardless of who
        // reconnects, so it keeps failing immediately.
        const supersededError = {
          code: 'superseded',
          message: 'superseded by a reconnect from the same client token',
          messageIdSuffix: 'superseded',
        };
        const displacedSupportsReplay =
          existing.protocolCapabilities?.includes(TASK_REPLAY_CAPABILITY) === true;
        if (displacedWasCondemned) {
          this.failBindingsForAgent(conn.agentId, DISCONNECTED_ERROR);
        } else if (displacedSupportsReplay) {
          this.holdBindingsForAgent(conn.agentId, undefined, 'reconnect', supersededError);
        } else {
          // Legacy clients cannot reclaim output safely, but this is still a
          // same-token replacement rather than a transport disconnect. Keep
          // the path's established terminal classification while failing it
          // immediately.
          this.failBindingsForAgent(conn.agentId, supersededError);
        }
        this.agents.set(conn.agentId, conn);
        this.notifyAgentChange(conn.agentId);
        return { ok: true };
      }
      return { ok: false, reason: 'agent already registered by different client' };
    }
    this.agents.set(conn.agentId, conn);
    this.notifyAgentChange(conn.agentId);
    return { ok: true };
  }

  // Close every live WebSocket whose ClientConnection.clientId matches.
  // Used by the admin-api delete-client path so a daemon whose client row
  // was just deleted sees a distinct close code (4014) and exits without
  // reconnecting. Returns the number of connections closed; callers
  // surface that to the operator as confirmation that an orphan vs a
  // live daemon was deleted.
  //
  // 4014 is the next unused slot in the bridge's WS close-code range:
  //   - 4001-4008 ws.ts (hello timeout, invalid frame, expected hello,
  //     protocol-version mismatch, bad token, registry registration
  //     failed, duplicate hello, agent id not in client allowlist)
  //   - 4009 registry.ts (this file: `another client with the same token
  //     connected` — duplicate-token collision)
  //   - 4010-4011 ws.ts (agent id owned by a different principal,
  //     reserved agent id)
  //   - 4012-4013 card-resolver.ts (missing card-or-backend, unknown
  //     backend kind)
  // Reusing any of those would make the daemon misclassify unrelated
  // handshake failures as deletion and exit instead of backing off.
  //
  // The close itself fires this WS's own `close` handler asynchronously,
  // which in turn calls unregisterAgent and removes the entry from the
  // `agents` map and flushes any bound tasks via the usual disconnect
  // path. We don't pre-delete from `agents` here — letting the close
  // handler do it keeps the in-memory state machine single-sourced.
  disconnectClient(clientId: string): number {
    let closed = 0;
    for (const conn of this.agents.values()) {
      if (conn.clientId !== clientId) continue;
      // The owner deleted this client; its tasks are dead whatever close code
      // comes back to us. See `serverClosed`.
      this.serverClosed.add(conn.ws);
      conn.ws.close(4014, 'client deleted');
      closed++;
    }
    return closed;
  }

  // `closeCode` is the WS close code this socket reported, or undefined when
  // the caller has none (the #364 reconcile path, which unregisters a socket
  // that went away before registration finished). It decides only one thing:
  // whether the in-flight tasks die now or get a grace hold. The agent itself
  // leaves the `agents` map either way — it is offline until it says hello
  // again, so routing and agent-card consumers see no change from this.
  /**
   * Record that THIS server is closing `ws` with an app-level verdict, before
   * calling `ws.close(4xxx)`. Callers outside the registry (ws.ts's handshake
   * and protocol rejections) use this so their intent survives the round trip
   * — see `serverClosed`, which explains why the observed close code cannot be
   * trusted for that decision.
   */
  noteServerClose(ws: WebSocket): void {
    this.serverClosed.add(ws);
  }

  unregisterAgent(agentId: string, ws: WebSocket, closeCode?: number): void {
    const existing = this.agents.get(agentId);
    if (!existing || existing.ws !== ws) return;
    this.agents.delete(agentId);
    this.notifyAgentChange(agentId);
    const supportsReplay =
      existing.protocolCapabilities?.includes(TASK_REPLAY_CAPABILITY) === true;
    if (supportsReplay && isGraceableCloseCode(closeCode) && !this.serverClosed.has(ws)) {
      // holdBindingsForAgent handles a disabled grace itself, falling back to
      // the same immediate failure, so there is one decision point rather than
      // two conditions that could drift apart.
      this.holdBindingsForAgent(agentId, closeCode, 'disconnect', DISCONNECTED_ERROR);
      return;
    }
    this.failBindingsForAgent(agentId, DISCONNECTED_ERROR);
  }

  // Start a grace hold on every in-flight task bound to this agent instead of
  // failing it. The binding stays in `bindings` and its sink stays open, so a
  // frame arriving on the client's next connection lands on it untouched —
  // nothing about a TaskBinding is connection-scoped (no `ws` field; outbound
  // sends re-resolve the connection by agentId at send time), which is what
  // makes a hold this cheap.
  // `terminalError` is what this hold resolves to if it is never resumed —
  // both when it expires and, immediately, when the grace is switched off
  // (`BRIDGE_DISCONNECT_GRACE_MS=0`). It is the caller's own terminal, so each
  // path's unresumed outcome is byte-identical to what it produced before the
  // grace existed, just T later: `disconnected` for a drop, `superseded` for a
  // same-token reconnect that never reclaimed the task.
  //
  // Keeping them distinct matters downstream: `disconnected` is the code the
  // router's cooldown amplifier keys on, and a client that demonstrably came
  // back (we saw its hello) but did not reclaim an old task is not a
  // disconnected agent — reporting it as one would manufacture exactly the
  // false failure signal issue #474 exists to remove.
  private holdBindingsForAgent(
    agentId: string,
    closeCode: number | undefined,
    via: 'disconnect' | 'reconnect',
    terminalError: TerminalError,
  ): void {
    if (this.disconnectGraceMs <= 0) {
      this.failBindingsForAgent(agentId, terminalError);
      return;
    }
    for (const binding of [...this.bindings.values()]) {
      if (binding.agentId !== agentId) continue;
      // Already holding this one (e.g. a second disconnect arriving for a
      // binding whose hold is still pending). Leave the original deadline in
      // place rather than sliding it forward on every event.
      if (this.graceHolds.has(binding.taskId)) continue;
      const heldAt = Date.now();
      const timer = setTimeout(() => {
        this.graceHolds.delete(binding.taskId);
        // Never resumed. Fail it exactly the way this path always has — same
        // code, same message, same messageId suffix — so nothing downstream has
        // to learn a new shape. The only difference is that it happens
        // `disconnectGraceMs` later.
        if (this.bindings.get(binding.taskId) !== binding) return;
        // Carries the same `via`/`closeCode` as the hold that armed it, so the
        // expiry line alone answers "which drop killed this task" without a
        // timestamp join back to binding_grace_held.
        logEvent('binding_grace_expired', {
          agentId: binding.agentId,
          taskId: binding.taskId,
          graceMs: this.disconnectGraceMs,
          via,
          ...(closeCode !== undefined ? { closeCode } : {}),
          ...(binding.principalId !== undefined ? { principalId: binding.principalId } : {}),
        });
        this.failBinding(binding, terminalError);
        this.bindings.delete(binding.taskId);
      }, this.disconnectGraceMs);
      // Never let a pending hold keep the process alive on its own.
      timer.unref?.();
      this.graceHolds.set(binding.taskId, { timer, binding, heldAt, via, closeCode });
      logEvent('binding_grace_held', {
        agentId: binding.agentId,
        taskId: binding.taskId,
        graceMs: this.disconnectGraceMs,
        via,
        ...(closeCode !== undefined ? { closeCode } : {}),
        ...(binding.principalId !== undefined ? { principalId: binding.principalId } : {}),
      });
    }
  }

  /**
   * Cancel the grace hold on a task because the client just proved it is alive
   * and still working on it.
   *
   * Called for every task-scoped frame from an authenticated connection — a
   * heartbeat `task.status` is enough, and that matters: it means even a
   * multi-minute task resumes the instant the reconnected client's next beat
   * lands, long before the hold would have expired. No-op for the overwhelming
   * majority of frames, where no hold is pending.
   *
   * `agentId` is checked so a frame cannot resume a hold belonging to some
   * other agent's task, even if it somehow guessed the taskId.
   */
  resumeBinding(taskId: string, agentId: string): void {
    const hold = this.graceHolds.get(taskId);
    if (!hold) return;
    if (hold.binding.agentId !== agentId) return;
    // Identity guard: a hold whose binding has since been replaced belongs to
    // the old binding. Leave it for the timer, which re-checks the same thing.
    if (this.bindings.get(taskId) !== hold.binding) return;
    clearTimeout(hold.timer);
    this.graceHolds.delete(taskId);
    logEvent('binding_grace_resumed', {
      agentId,
      taskId,
      heldForMs: Date.now() - hold.heldAt,
      graceMs: this.disconnectGraceMs,
      via: hold.via,
      ...(hold.closeCode !== undefined ? { closeCode: hold.closeCode } : {}),
      ...(hold.binding.principalId !== undefined
        ? { principalId: hold.binding.principalId }
        : {}),
    });
  }

  // Drop a pending hold without failing anything — used wherever a binding
  // leaves the map through a path that has already decided its fate (normal
  // terminal, rebind, explicit fail), so a stale timer can't fire against it.
  private clearGraceHold(taskId: string, binding?: TaskBinding): void {
    const hold = this.graceHolds.get(taskId);
    if (!hold) return;
    if (binding !== undefined && hold.binding !== binding) return;
    clearTimeout(hold.timer);
    this.graceHolds.delete(taskId);
  }

  // Push a terminal `failed` status to every in-flight task bound to this
  // agent, finish its sink, and drop the binding. Both the normal disconnect
  // (unregisterAgent) and the same-token reconnect replacement (registerAgent)
  // funnel through here so an in-flight task is never left without a terminal
  // event — the HTTP stream for that task would otherwise hang forever waiting
  // on AsyncEventQueue.iterate(), since the bound sink's finish() is what
  // closes the iterator. The reconnect path in particular MUST call this
  // explicitly before swapping the agents map: once the map points at the new
  // conn, the old socket's late close handler hits the ws-identity guard in
  // unregisterAgent and early-returns, so it can no longer fail these bindings.
  private failBindingsForAgent(agentId: string, error: TerminalError): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.agentId !== agentId) continue;
      // This binding's fate is being decided right now; a pending hold on it is
      // moot and its timer must not outlive it.
      this.clearGraceHold(binding.taskId, binding);
      this.failBinding(binding, error);
      // Identity-guarded: only drop the entry if it is still THIS binding, so a
      // concurrent rebind of the same taskId is never clobbered.
      if (this.bindings.get(binding.taskId) === binding) {
        this.bindings.delete(binding.taskId);
      }
    }
  }

  // Push a terminal `failed` status onto a binding's sink and close it, so the
  // executor consuming that sink's queue observes a terminal event and its
  // executeStream() generator returns (closing the SSE stream) instead of
  // hanging forever on AsyncEventQueue.iterate(). Does NOT touch the bindings
  // map — callers decide whether to delete (disconnect) or overwrite (rebind).
  private failBinding(binding: TaskBinding, error: TerminalError): void {
    binding.sink.pushStatus({
      taskId: binding.taskId,
      contextId: binding.contextId,
      final: true,
      status: {
        // `failed` is the spec's terminal failure state; mirrors the
        // pre-migration behavior where mid-task client disconnects
        // were surfaced as a failed status with an explanatory message.
        // Cast keeps this file decoupled from the @a2x/sdk TaskState
        // enum value while still emitting the wire-correct string.
        state: 'failed' as never,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${binding.taskId}-${error.messageIdSuffix}`,
          role: 'agent',
          parts: [{ text: error.message }],
          ...terminalErrorMessageFields(
            {
              code: error.code,
              message: error.message,
            },
            binding.requestedExtensions,
          ),
          taskId: binding.taskId,
          contextId: binding.contextId,
        },
      },
    });
    binding.sink.finish();
  }

  getAgent(agentId: string): ClientConnection | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): ClientConnection[] {
    return [...this.agents.values()];
  }

  bindTask(binding: TaskBinding): boolean {
    // A taskId can be reused across turns (A2A keeps the same taskId for an
    // `input-required` continuation) or arrive on a duplicate/retried request
    // while the prior run is still in flight. If a DIFFERENT live binding
    // already holds this taskId, terminate it first — otherwise the displaced
    // executor's AsyncEventQueue is never closed and its SSE stream hangs
    // forever (the connected client's frames would now route to the new
    // binding). Terminating it emits a `failed` terminal so that stream closes
    // cleanly instead of orphaning.
    const existing = this.bindings.get(binding.taskId);
    if (existing && existing.agentId !== binding.agentId) {
      // A task id is owned by exactly one agent (issue #476). Never let a
      // request routed through another agent fail or displace the legitimate
      // caller's live stream, even if an upstream task-store scoping regression
      // hands the wrong task to that executor.
      logEvent('binding_owner_mismatch', {
        agentId: binding.agentId,
        ownerAgentId: existing.agentId,
        taskId: binding.taskId,
        operation: 'bind',
        ...(binding.principalId !== undefined ? { principalId: binding.principalId } : {}),
      });
      return false;
    }
    if (existing && existing !== binding) {
      logEvent('binding_displaced', {
        agentId: binding.agentId,
        taskId: binding.taskId,
        ...(binding.principalId !== undefined ? { principalId: binding.principalId } : {}),
      });
      // The displaced binding is being terminated here and now, so any hold it
      // was under is decided — drop the timer before the new binding takes over
      // the taskId. (The timer is identity-guarded too, so this is belt and
      // braces, but leaving live timers around for dead bindings is a trap.)
      this.clearGraceHold(binding.taskId, existing);
      this.failBinding(existing, {
        code: 'task_superseded',
        message: 'task superseded by a newer request for the same task id',
        messageIdSuffix: 'superseded',
      });
    }
    this.bindings.set(binding.taskId, binding);
    return true;
  }

  getBinding(taskId: string): TaskBinding | undefined {
    return this.bindings.get(taskId);
  }

  failTaskBinding(binding: TaskBinding, code: string, message: string): void {
    if (this.bindings.get(binding.taskId) !== binding) return;
    this.clearGraceHold(binding.taskId, binding);
    this.failBinding(binding, {
      code,
      message,
      messageIdSuffix: code,
    });
    this.bindings.delete(binding.taskId);
  }

  // Identity-scoped: only remove the entry when it is still the SAME binding
  // this caller installed. A stale executor tearing down (after its awaited
  // taskStore.updateTask) must never delete a newer binding that has since
  // claimed the same taskId — that clobber is what silently drops the new
  // turn's terminal frame and wedges its stream open. Mirrors the ws-identity
  // guard already applied to the agents map in unregisterAgent (issue #365).
  unbindTask(taskId: string, binding: TaskBinding): void {
    if (this.bindings.get(taskId) !== binding) return;
    // A task that reaches its terminal while a hold is pending — the exact case
    // this feature exists to rescue, where the reconnected client's
    // `task.complete` lands during the grace window — must take its timer with
    // it. Otherwise the timer would fire later and try to fail an already
    // completed task.
    this.clearGraceHold(taskId, binding);
    this.bindings.delete(taskId);
  }

  onCallerChange(listener: CallerChangeListener): void {
    this.callerChangeListeners.push(listener);
  }

  onAgentChange(listener: AgentChangeListener): void {
    this.agentChangeListeners.push(listener);
  }

  updateAllowedCallers(agentId: string, callers: string[]): void {
    const conn = this.agents.get(agentId);
    if (conn) conn.allowedCallers = callers;
    for (const listener of this.callerChangeListeners) {
      listener(agentId, callers);
    }
  }

  /**
   * Apply a pricing change to the live connection.
   *
   * The executor re-reads `x402Pricing` off the connection on every turn, so
   * this alone makes repricing take effect on the next call. It also fires
   * the agent-change signal because the AgentCard advertises the price, and
   * the card (plus the request handler built around it) is cached per agent —
   * without the eviction a repriced agent would keep publishing the old
   * figures until it reconnected.
   *
   * A no-op when the agent is not currently connected: the new pricing is
   * already in the database and will be read at its next hello.
   */
  updateX402Pricing(agentId: string, pricing: X402Pricing | undefined): void {
    const conn = this.agents.get(agentId);
    if (!conn) return;
    if (pricing === undefined) delete conn.x402Pricing;
    else conn.x402Pricing = pricing;
    this.notifyAgentChange(agentId);
  }

  private notifyAgentChange(agentId: string): void {
    for (const listener of this.agentChangeListeners) {
      try {
        listener(agentId);
      } catch (err) {
        // A misbehaving listener must not abort further notifications or
        // corrupt the register/unregister call site. Log through
        // logEvent() so user-controlled agentId (originates in the hello
        // frame and is an unconstrained string at this layer) is JSON-
        // escaped rather than interpolated into a format string — this
        // prevents CRLF log injection. Truncate it too so a pathological
        // client can't inflate each error line unbounded. Preserve the
        // stack when available; fall back to String() for non-Error
        // throws so the log is still actionable.
        logEvent('registry_agent_listener_error', {
          agentId: truncate(String(agentId), 128),
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      }
    }
  }

  sendToAgent(agentId: string, frame: DownFrame): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    conn.ws.send(encodeFrame(frame));
    return true;
  }
}
