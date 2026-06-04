import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import {
  parseUpFrame,
  PROTOCOL_VERSION,
  type Part,
  type TaskStatus as WireTaskStatus,
  type Message as WireMessage,
} from '@vicoop-bridge/protocol';
import type { Message, TaskStatus } from '@a2x/sdk';
import { TaskState } from '@a2x/sdk';
import type { Registry } from './registry.js';
import type { Sql } from './db.js';
import { hashToken } from './token.js';
import { logEvent, truncate } from './log.js';
import { isReservedAgentId } from './reserved-agent-ids.js';
import { resolveHelloAgentCard } from './card-resolver.js';
import { terminalErrorMessageFields } from './terminal-error.js';

interface ClientRow {
  id: string;
  client_id: string;
  owner_principal: string;
  allowed_callers: string[];
}

async function lookupByTokenHash(sql: Sql, hash: string): Promise<ClientRow | null> {
  // Agent registrations are hard-deleted by admin-api.deleteClientForOwner,
  // so token_hash lookup alone is sufficient: a stale token whose row was
  // deleted simply matches nothing and the daemon sees the 4005 "bad token"
  // path.
  const rows = await sql<ClientRow[]>`
    SELECT id, client_id, owner_principal, allowed_callers
    FROM agents
    WHERE token_hash = ${hash}
  `;
  return rows[0] ?? null;
}

export interface ServerWsOptions {
  db: Sql;
  registry: Registry;
}

export function attachWsServer(server: Server, opts: ServerWsOptions): void {
  const wss = new WebSocketServer({ noServer: true });

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
  | { ok: true; clientId: string; cardName: string; cardSource: 'inline' | 'canonical' }
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

  const result = opts.registry.registerAgent({
    agentId: frame.agentId,
    clientId,
    ownerPrincipal,
    agentCard: resolvedCard.agentCard,
    allowedCallers: client.allowed_callers,
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

  const helloTimeout = setTimeout(() => {
    if (!authed) ws.close(4001, 'hello timeout');
  }, 10_000);

  ws.on('message', (raw) => {
    let frame;
    try {
      frame = parseUpFrame(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (err) {
      ws.close(4002, `invalid frame: ${(err as Error).message}`);
      return;
    }

    if (!authed) {
      if (frame.type !== 'hello') {
        ws.close(4003, 'expected hello');
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
        agentId = frame.agentId;
        authed = true;
        clearTimeout(helloTimeout);
        logEvent('client_connected', {
          agentId,
          clientId: result.clientId,
          name: result.cardName,
          cardSource: result.cardSource,
        });
      }).catch((err) => {
        console.error('[server] auth error:', err);
        ws.close(1011, 'internal error');
      });
      return;
    }

    switch (frame.type) {
      case 'task.status': {
        const b = opts.registry.getBinding(frame.taskId);
        if (!b) return;
        b.sink.pushStatus({
          taskId: frame.taskId,
          contextId: b.contextId,
          final: false,
          status: wireStatusToA2X(frame.status, frame.taskId, b.contextId),
        });
        break;
      }
      case 'task.artifact': {
        const b = opts.registry.getBinding(frame.taskId);
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
        const b = opts.registry.getBinding(frame.taskId);
        if (!b) return;
        b.sink.pushStatus({
          taskId: frame.taskId,
          contextId: b.contextId,
          final: true,
          status: wireStatusToA2X(frame.status, frame.taskId, b.contextId),
        });
        b.sink.finish();
        opts.registry.unbindTask(frame.taskId);
        logEvent('task_completed', {
          agentId: b.agentId,
          taskId: frame.taskId,
          state: frame.status.state,
          ...(b.principalId !== undefined ? { principalId: b.principalId } : {}),
        });
        break;
      }
      case 'task.fail': {
        const b = opts.registry.getBinding(frame.taskId);
        if (!b) return;
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
        opts.registry.unbindTask(frame.taskId);
        logEvent('task_failed_by_client', {
          agentId: b.agentId,
          taskId: frame.taskId,
          errorCode: frame.error.code,
          errorMessage: truncate(frame.error.message, 256),
          ...(b.principalId !== undefined ? { principalId: b.principalId } : {}),
        });
        break;
      }
      case 'pong':
        break;
      case 'hello':
        ws.close(4007, 'duplicate hello');
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimeout);
    if (agentId) {
      logEvent('client_disconnected', { agentId });
      opts.registry.unregisterAgent(agentId, ws);
    }
  });

  ws.on('error', (err) => {
    console.error('[server] ws error:', err);
  });
}
