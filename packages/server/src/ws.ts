import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import {
  parseUpFrame,
  PROTOCOL_VERSION,
  OPENAI_COMPAT_EXTENSION_URI,
  type Part,
  type TaskStatus as WireTaskStatus,
  type Message as WireMessage,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Message, TaskStatus } from '@a2x/sdk';
import { TaskState } from '@a2x/sdk';
import type { Registry, TaskBinding } from './registry.js';
import type { Sql } from './db.js';
import { hashToken } from './token.js';
import { logEvent, truncate } from './log.js';
import { isReservedAgentId } from './reserved-agent-ids.js';
import { resolveHelloAgentCard } from './card-resolver.js';
import { terminalErrorMessageFields } from './terminal-error.js';
import { resolveUsageResponse } from './usage-rpc.js';
import { parseX402Pricing } from './x402/pricing.js';

// Diagnostic (issue #414): is this `task.status` frame a tagged liveness
// heartbeat (non-terminal working status carrying
// `metadata[<URI>].heartbeat === true`)? Used to count beats forwarded per task.
function isHeartbeatStatusFrame(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false;
  const ext = (metadata as Record<string, unknown>)[OPENAI_COMPAT_EXTENSION_URI];
  if (typeof ext !== 'object' || ext === null) return false;
  return (ext as Record<string, unknown>).heartbeat === true;
}

interface ClientRow {
  id: string;
  client_id: string;
  owner_principal: string;
  owner_email: string | null;
  allowed_callers: string[];
  x402_pricing: unknown;
}

async function lookupByTokenHash(sql: Sql, hash: string): Promise<ClientRow | null> {
  // Agent registrations are hard-deleted by admin-api.deleteClientForOwner,
  // so token_hash lookup alone is sufficient: a stale token whose row was
  // deleted simply matches nothing and the daemon sees the 4005 "bad token"
  // path.
  const rows = await sql<ClientRow[]>`
    SELECT id, client_id, owner_principal, owner_email, allowed_callers, x402_pricing
    FROM agents
    WHERE token_hash = ${hash}
  `;
  return rows[0] ?? null;
}

export interface ServerWsOptions {
  db: Sql;
  registry: Registry;
}

// Largest WebSocket message the bridge will assemble at all, authenticated or
// not. See the `maxPayload` note in attachWsServer.
const MAX_INGRESS_BYTES = 16 * 1024 * 1024;

export function attachWsServer(server: Server, opts: ServerWsOptions): void {
  const wss = new WebSocketServer({
    noServer: true,
    // Ingress cap, enforced by `ws` while it assembles the frame rather than by
    // us once it already exists. Without it the library's 100 MiB default is
    // what an unauthenticated peer can make each connection hold before our own
    // pre-auth budget is ever consulted — several connections would be enough
    // to exhaust the deployment. Set well above any legitimate frame (the
    // client refuses to buffer one this large) and comfortably above the
    // pre-auth budget, so it bounds abuse without truncating real traffic.
    maxPayload: MAX_INGRESS_BYTES,
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/connect') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, opts);
    });
  });
}

type AuthResult =
  | {
      ok: true;
      clientId: string;
      cardName: string;
      cardSource: 'inline' | 'canonical';
      ownerPrincipal: string;
      ownerEmail: string | null;
    }
  | { ok: false; code: number; reason: string };

async function authenticateAndRegister(
  ws: WebSocket,
  frame: import('@vicoop-bridge/protocol').HelloFrame,
  opts: ServerWsOptions,
): Promise<AuthResult> {
  // Reserved agent ids (e.g. "admin") are owned by the bridge itself —
  // exposed at @admin@<host> via Mentionable. The SQL trigger
  // clients_assert_no_reserved_agent_ids covers every mutation path on the
  // `clients` table (wrapper functions, PostGraphile auto-mutations, direct
  // SQL), but a manually-inserted row from psql before the trigger landed,
  // or any future schema regression, must still be refused at the wire.
  // Belt and suspenders — and cheaper to deny here than after the DB lookup.
  if (isReservedAgentId(frame.agentId)) {
    logEvent('client_rejected', { reason: 'agent id reserved', agentId: frame.agentId });
    return { ok: false, code: 4011, reason: 'agent id reserved by the bridge' };
  }
  const hash = hashToken(frame.token);
  const client = await lookupByTokenHash(opts.db, hash);
  if (!client) {
    logEvent('client_rejected', { reason: 'bad token', agentId: frame.agentId });
    return { ok: false, code: 4005, reason: 'bad token' };
  }
  if (client.id !== frame.agentId) {
    logEvent('client_rejected', {
      reason: 'agent not allowed',
      agentId: frame.agentId,
      clientId: client.client_id,
      allowed: [client.id],
    });
    return { ok: false, code: 4008, reason: 'agent id not authorized for this client' };
  }
  const clientId = client.client_id;
  const ownerPrincipal = client.owner_principal;

  const resolvedCard = resolveHelloAgentCard(frame);
  if (!resolvedCard.ok) {
    logEvent('client_rejected', {
      reason: resolvedCard.reason,
      agentId: frame.agentId,
      clientId,
      ...(resolvedCard.backendKind
        ? { backendKind: truncate(resolvedCard.backendKind, 128) }
        : {}),
    });
    return { ok: false, code: resolvedCard.code, reason: resolvedCard.reason };
  }

  // A malformed pricing row must not take the agent offline — it would turn
  // an operator typo into an outage. Log it and connect the agent as free;
  // the gate is then never installed, so nobody is charged against a config
  // the server could not read.
  let x402Pricing;
  try {
    x402Pricing = parseX402Pricing(client.x402_pricing);
  } catch (err) {
    logEvent('x402_pricing_invalid', {
      agentId: frame.agentId,
      clientId,
      error: String(err),
    });
  }

  const result = opts.registry.registerAgent({
    agentId: frame.agentId,
    clientId,
    ownerPrincipal,
    ownerEmail: client.owner_email,
    backendKind: frame.backendKind,
    protocolCapabilities: frame.protocolCapabilities,
    agentCard: resolvedCard.agentCard,
    allowedCallers: client.allowed_callers,
    ...(x402Pricing !== undefined ? { x402Pricing } : {}),
    ws,
    connectedAt: Date.now(),
  });
  if (!result.ok) {
    logEvent('client_rejected', {
      reason: result.reason,
      agentId: frame.agentId,
      clientId,
    });
    return { ok: false, code: 4006, reason: result.reason };
  }

  return {
    ok: true,
    clientId,
    cardName: resolvedCard.agentCard.name,
    cardSource: resolvedCard.source,
    ownerPrincipal,
    ownerEmail: client.owner_email,
  };
}

function wireMessageToA2X(
  m: WireMessage | undefined,
  taskId: string,
  contextId: string,
): Message | undefined {
  if (!m) return undefined;
  return {
    messageId: m.messageId,
    role: m.role,
    // Wire parts use `{kind, ...}` shape; a2x's internal Part type uses
    // discriminator-by-field-presence. The v0.3 response mapper accepts
    // either (text-part guard hits on `'text' in part`; file/data fall
    // through to fallback that spreads). Cast keeps type-checker happy.
    parts: m.parts as unknown as Message['parts'],
    ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
    ...(m.extensions !== undefined ? { extensions: m.extensions } : {}),
    taskId,
    contextId,
  };
}

function wireStatusToA2X(
  status: WireTaskStatus,
  taskId: string,
  contextId: string,
): TaskStatus {
  return {
    state: status.state as unknown as TaskStatus['state'],
    timestamp: status.timestamp,
    message: wireMessageToA2X(status.message, taskId, contextId),
  };
}

function handleConnection(ws: WebSocket, _req: IncomingMessage, opts: ServerWsOptions): void {
  let agentId: string | null = null;
  let authed = false;
  let helloProcessing = false;

  // Resolve the binding a task frame targets, but only if this connection's
  // authenticated agent is the one that owns it. `getBinding` keys on taskId
  // alone, so without this check any authenticated client that learned another
  // agent's taskId could push status, artifacts, reported `usage`, or a forged
  // terminal into that agent's caller's stream.
  //
  // The reconnect grace hold (issue #474) is what makes the check load-bearing.
  // Before it, a binding vanished the instant its agent dropped; now it stays
  // resolvable for the whole grace window while its owner is offline and in no
  // position to contradict anything written in its name. Closing the gap here
  // rather than in the registry keeps `getBinding` a pure lookup and puts the
  // authorization next to the authenticated identity it is checked against.
  const ownedBinding = (taskId: string): TaskBinding | undefined => {
    const b = opts.registry.getBinding(taskId);
    if (!b) return undefined;
    if (b.agentId !== agentId) {
      // `taskId` comes straight off the frame, so a client can make this line
      // as long as it likes — and it can emit one per frame. Truncate like
      // every other client-controlled string we log.
      logEvent('binding_owner_mismatch', {
        agentId: agentId ?? undefined,
        taskId: truncate(taskId, 128),
        ownerAgentId: b.agentId,
        // Same event name as the executor's cancel guard and bindTask's
        // (issue #476), so all cross-agent attempts aggregate together;
        // `operation` is what tells an operator which door was tried.
        operation: 'frame',
      });
      return undefined;
    }
    return b;
  };

  const helloTimeout = setTimeout(() => {
    if (!authed) ws.close(4001, 'hello timeout');
  }, 10_000);

  // Frames that arrived after `hello` but before its async authentication
  // settled. A client replaying buffered work on reconnect pipelines them
  // immediately behind the hello, and the DB token lookup takes long enough
  // that they nearly always win the race — rejecting them would turn every
  // replay into a 4003 close and a reconnect loop. Bounded, and discarded
  // untouched if authentication fails.
  let preAuthQueue: UpFrame[] = [];
  let preAuthBytes = 0;
  // Must exceed the client's own replay buffer cap (DEFAULT_MAX_PENDING_FRAMES,
  // 2000, in packages/client/src/client.ts). The client flushes its whole
  // buffer immediately behind `hello` and clears it as it goes, so a server cap
  // BELOW that would close a perfectly normal replay with 4002 and destroy the
  // very frames this feature exists to preserve — and the client would
  // reconnect into a loop. Same relationship as the byte budget below; both
  // caps are deliberately the larger side of that pair.
  const MAX_PRE_AUTH_FRAMES = 4_096;
  // Byte budget alongside the frame count, measured on the RAW message rather
  // than the parsed object: the protocol puts no size limit on artifact or
  // status payloads, so a frame count alone bounds nothing. Without this an
  // unauthenticated peer could park hundreds of megabytes per connection for
  // the duration of the token lookup, across as many connections as it likes.
  //
  // Sized above the client's own replay budget (DEFAULT_MAX_PENDING_BYTES in
  // packages/client/src/client.ts) so a legitimate replay always fits; a client
  // that overshoots is closed rather than silently truncated.
  //
  // Enforced BEFORE parsing (see below): checking after `parseUpFrame` would
  // let a peer make us materialize an oversized payload through JSON and Zod
  // and only then reject it, which is most of the cost the cap exists to deny.
  const MAX_PRE_AUTH_BYTES = 8 * 1024 * 1024;

  ws.on('message', (raw) => {
    // `RawData` is Buffer | ArrayBuffer | Buffer[] depending on how the socket
    // was configured; measure all three rather than assume one.
    const rawBytes = Buffer.isBuffer(raw)
      ? raw.length
      : Array.isArray(raw)
        ? raw.reduce((n, chunk) => n + chunk.length, 0)
        : raw instanceof ArrayBuffer
          ? raw.byteLength
          : Buffer.byteLength(String(raw), 'utf8');

    // Everything an unauthenticated peer sends — the hello itself included —
    // counts against one budget, and it is charged here, before the bytes are
    // handed to the parser. There is no separate allowance for the hello: a
    // legitimate one is a few hundred bytes, so the shared budget is orders of
    // magnitude more than it needs while still capping what a peer can make us
    // allocate before it has proved anything.
    if (!authed) {
      if (preAuthBytes + rawBytes > MAX_PRE_AUTH_BYTES) {
        logEvent('pre_auth_overflow', {
          frames: preAuthQueue.length,
          bytes: preAuthBytes,
          frameBytes: rawBytes,
        });
        opts.registry.noteServerClose(ws);
        ws.close(4002, 'too much data before authentication');
        return;
      }
      preAuthBytes += rawBytes;
    }

    let frame;
    try {
      frame = parseUpFrame(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (err) {
      // A protocol violation is our verdict on this connection, so its
      // in-flight tasks must not earn a reconnect grace hold no matter what
      // close code we end up observing (see Registry.noteServerClose).
      opts.registry.noteServerClose(ws);
      ws.close(4002, `invalid frame: ${(err as Error).message}`);
      return;
    }

    if (!authed) {
      if (frame.type !== 'hello') {
        // The first frame must still be a hello — that guard is what keeps
        // unannounced peers out. Once a hello IS in flight, though, the
        // connection is claimed and further frames are just early, not
        // illegal.
        if (!helloProcessing) {
          ws.close(4003, 'expected hello');
          return;
        }
        if (preAuthQueue.length >= MAX_PRE_AUTH_FRAMES) {
          logEvent('pre_auth_overflow', { frames: preAuthQueue.length, bytes: preAuthBytes });
          opts.registry.noteServerClose(ws);
          ws.close(4002, 'too many frames before authentication');
          return;
        }
        preAuthQueue.push(frame);
        return;
      }
      if (frame.version !== PROTOCOL_VERSION) {
        ws.close(4004, 'protocol version mismatch');
        return;
      }
      if (helloProcessing) return;
      helloProcessing = true;

      authenticateAndRegister(ws, frame, opts).then((result) => {
        if (!result.ok) {
          ws.close(result.code, result.reason);
          return;
        }
        // The socket may have closed while authenticateAndRegister was
        // awaiting (token lookup, etc.). If so, the `close` handler already
        // ran with agentId still null and skipped cleanup — but registerAgent
        // has just put this now-dead ws into the registry. Reconcile here so we
        // don't leave a zombie agent that getAgent() reports as live and
        // sendToAgent() writes into a dead socket. unregisterAgent is idempotent
        // (no-ops unless the stored ws is this one), so racing a later close
        // event is safe. (#364)
        if (ws.readyState !== ws.OPEN) {
          opts.registry.unregisterAgent(frame.agentId, ws);
          return;
        }
        agentId = frame.agentId;
        authed = true;
        clearTimeout(helloTimeout);
        logEvent('client_connected', {
          agentId,
          clientId: result.clientId,
          email: result.ownerEmail ?? undefined,
          ownerPrincipal: result.ownerPrincipal,
          backend:
            result.cardSource === 'canonical'
              ? truncate(frame.backendKind ?? 'unknown', 64)
              : 'inline',
          name: result.cardName,
          cardSource: result.cardSource,
        });
        // Deliver anything the client pipelined behind its hello, in arrival
        // order, before any later frame is processed. This is what makes a
        // reconnecting client's replay land on the tasks its grace hold is
        // keeping alive (issue #474).
        const queued = preAuthQueue;
        preAuthQueue = [];
        preAuthBytes = 0;
        if (queued.length > 0) {
          logEvent('pre_auth_replayed', { agentId, frames: queued.length });
          for (const queuedFrame of queued) processAuthedFrame(queuedFrame);
        }
      }).catch((err) => {
        console.error('[server] auth error:', err);
        ws.close(1011, 'internal error');
      });
      return;
    }

    processAuthedFrame(frame);
  });

  function processAuthedFrame(frame: UpFrame): void {
    // Any task-scoped frame on an authenticated connection is proof that the
    // client is alive and still working this task, which is exactly the signal
    // that cancels a reconnect grace hold (issue #474). Doing it here rather
    // than in each handler means every task frame counts — including a bare
    // liveness heartbeat, and including any frame type added later — and that
    // resumption happens before the frame is processed, so a `task.complete`
    // arriving mid-hold resumes the binding and then completes it normally
    // instead of being discarded as a `dropped_terminal_frame`.
    //
    // No-op unless a hold is actually pending, which is the case for
    // essentially every frame the server ever sees.
    if (agentId !== null && 'taskId' in frame) {
      opts.registry.resumeBinding(frame.taskId, agentId);
    }

    switch (frame.type) {
      case 'task.status': {
        const b = ownedBinding(frame.taskId);
        if (!b) return;
        // Diagnostic (issue #414): count liveness-heartbeat beats forwarded for
        // this task (hop 2). A heartbeat is a non-terminal working status tagged
        // `metadata[<URI>].heartbeat === true`; other `task.status` frames don't
        // count. Surfaced on the terminal log below.
        if (isHeartbeatStatusFrame(frame.metadata)) {
          b.heartbeats = (b.heartbeats ?? 0) + 1;
        }
        b.sink.pushStatus({
          taskId: frame.taskId,
          contextId: b.contextId,
          final: false,
          status: wireStatusToA2X(frame.status, frame.taskId, b.contextId),
          // Pass the frame's metadata through verbatim onto the A2A
          // `TaskStatusUpdateEvent.metadata` (top-level — NOT
          // status.message.metadata). The oai2a2a codec reads the liveness
          // heartbeat marker off `event.metadata[<URI>].heartbeat` here
          // (planetarium/a2x-internal-router#95).
          ...(frame.metadata !== undefined ? { metadata: frame.metadata } : {}),
        });
        break;
      }
      case 'task.artifact': {
        const b = ownedBinding(frame.taskId);
        if (!b) return;
        b.sink.pushArtifact({
          taskId: frame.taskId,
          contextId: b.contextId,
          artifact: {
            artifactId: frame.artifact.artifactId,
            ...(frame.artifact.name !== undefined ? { name: frame.artifact.name } : {}),
            ...(frame.artifact.metadata !== undefined ? { metadata: frame.artifact.metadata } : {}),
            ...(frame.artifact.extensions !== undefined ? { extensions: frame.artifact.extensions } : {}),
            // Wire-shape parts; see wireMessageToA2X for the shape note.
            parts: frame.artifact.parts as unknown as Part[] as never,
          },
          append: frame.append,
          lastChunk: frame.lastChunk,
        });
        break;
      }
      case 'task.complete': {
        const b = ownedBinding(frame.taskId);
        if (!b) {
          // No live binding for this taskId — the terminal frame cannot be
          // delivered and the corresponding stream (if any) will not close via
          // this frame. Surface it: a dropped terminal is the signature of a
          // wedged SSE stream, and this path is otherwise silent.
          logEvent('dropped_terminal_frame', {
            agentId: agentId ?? undefined,
            taskId: truncate(frame.taskId, 128),
            kind: 'task.complete',
            state: frame.status.state,
          });
          return;
        }
        // Stash the reported token usage before the terminal status reaches
        // the sink: the executor prices the task off the binding when it
        // consumes that event, and pushStatus only enqueues, so setting it
        // first makes the ordering unconditional.
        if (frame.usage !== undefined) b.usage = frame.usage;
        b.sink.pushStatus({
          taskId: frame.taskId,
          contextId: b.contextId,
          final: true,
          status: wireStatusToA2X(frame.status, frame.taskId, b.contextId),
        });
        b.sink.finish();
        opts.registry.unbindTask(frame.taskId, b);
        logEvent('task_completed', {
          agentId: b.agentId,
          backend: opts.registry.getAgent(b.agentId)?.backendKind ?? 'inline',
          taskId: frame.taskId,
          contextId: b.contextId,
          state: frame.status.state,
          heartbeatsForwarded: b.heartbeats ?? 0,
          ...(b.principalId !== undefined ? { principalId: b.principalId } : {}),
        });
        break;
      }
      case 'task.fail': {
        const b = ownedBinding(frame.taskId);
        if (!b) {
          logEvent('dropped_terminal_frame', {
            agentId: agentId ?? undefined,
            taskId: truncate(frame.taskId, 128),
            kind: 'task.fail',
            errorCode: frame.error.code,
          });
          return;
        }
        b.sink.pushStatus({
          taskId: frame.taskId,
          contextId: b.contextId,
          final: true,
          status: {
            state: TaskState.FAILED,
            timestamp: new Date().toISOString(),
            message: {
              messageId: `${frame.taskId}-err`,
              role: 'agent',
              parts: [{ text: `${frame.error.code}: ${frame.error.message}` }],
              ...terminalErrorMessageFields(frame.error, b.requestedExtensions),
              taskId: frame.taskId,
              contextId: b.contextId,
            },
          },
        });
        b.sink.finish();
        opts.registry.unbindTask(frame.taskId, b);
        logEvent('task_failed_by_client', {
          agentId: b.agentId,
          backend: opts.registry.getAgent(b.agentId)?.backendKind ?? 'inline',
          taskId: frame.taskId,
          contextId: b.contextId,
          errorCode: frame.error.code,
          errorMessage: truncate(frame.error.message, 256),
          heartbeatsForwarded: b.heartbeats ?? 0,
          ...(b.principalId !== undefined ? { principalId: b.principalId } : {}),
        });
        break;
      }
      case 'usage.response':
        // Only the agent the request was issued to may resolve it.
        if (agentId) resolveUsageResponse(agentId, frame);
        break;
      case 'pong':
        break;
      case 'hello':
        opts.registry.noteServerClose(ws);
        ws.close(4007, 'duplicate hello');
        break;
    }
  }

  ws.on('close', (code: number, reason: Buffer) => {
    clearTimeout(helloTimeout);
    if (agentId) {
      // Look up the live connection BEFORE unregistering so the disconnect log
      // carries the same identifying detail as client_connected.
      const conn = opts.registry.getAgent(agentId);
      logEvent('client_disconnected', {
        agentId,
        // The close code decides whether in-flight tasks get a reconnect grace
        // hold (issue #474), so it belongs in the log the operator reads when
        // asking why a task did or didn't survive a drop. It was previously
        // discarded outright, which is why the 2026-08-20 incident left no
        // record of what the SERVER's socket saw — the 1012 in that report is
        // what the CLIENT observed, and the two ends need not agree.
        // `reason` is remote-supplied, so truncate it like every other
        // client-controlled string we log.
        closeCode: code,
        ...(reason.length > 0 ? { closeReason: truncate(reason.toString('utf8'), 128) } : {}),
        ...(conn
          ? {
              clientId: conn.clientId,
              email: conn.ownerEmail ?? undefined,
              ownerPrincipal: conn.ownerPrincipal,
              backend: conn.backendKind ?? 'inline',
              connectedMs: Date.now() - conn.connectedAt,
            }
          : {}),
      });
      opts.registry.unregisterAgent(agentId, ws, code);
    }
  });

  ws.on('error', (err) => {
    console.error('[server] ws error:', err);
  });
}
