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

interface ClientRow {
  id: string;
  owner_wallet: string;
  allowed_agent_ids: string[];
}

async function lookupByTokenHash(sql: Sql, hash: string): Promise<ClientRow | null> {
  const rows = await sql<ClientRow[]>`
    SELECT id, owner_wallet, allowed_agent_ids FROM clients WHERE token_hash = ${hash} AND revoked = false
  `;
  return rows[0] ?? null;
}

interface PolicyRow {
  owner_wallet: string;
  allowed_callers: string[];
}

async function ensureAgentPolicy(
  sql: Sql,
  agentId: string,
  ownerWallet: string,
  clientId: string,
): Promise<{ ok: true; allowedCallers: string[] } | { ok: false; reason: string }> {
  // Refresh client_id on re-registration so cascade follows the currently
  // registering client. Case-insensitive compare mirrors the lowercase
  // normalization used elsewhere, so a legacy mixed-case row still matches;
  // the ownership check below still rejects cross-wallet attempts. The
  // IS DISTINCT FROM guard skips the write when nothing actually changed to
  // avoid WAL churn on frequent reconnects.
  await sql`
    INSERT INTO agent_policies (agent_id, owner_wallet, client_id)
    VALUES (${agentId}, ${ownerWallet.toLowerCase()}, ${clientId})
    ON CONFLICT (agent_id) DO UPDATE
      SET owner_wallet = EXCLUDED.owner_wallet,
          client_id = EXCLUDED.client_id,
          updated_at = now()
      WHERE lower(agent_policies.owner_wallet) = lower(EXCLUDED.owner_wallet)
        AND (
          agent_policies.client_id IS DISTINCT FROM EXCLUDED.client_id
          OR agent_policies.owner_wallet IS DISTINCT FROM EXCLUDED.owner_wallet
        )
  `;
  const rows = await sql<PolicyRow[]>`
    SELECT owner_wallet, allowed_callers FROM agent_policies WHERE agent_id = ${agentId}
  `;
  if (rows.length === 0) {
    return { ok: false, reason: 'failed to create agent policy' };
  }
  if (rows[0].owner_wallet.toLowerCase() !== ownerWallet.toLowerCase()) {
    return { ok: false, reason: 'agent id owned by a different wallet' };
  }
  return { ok: true, allowedCallers: rows[0].allowed_callers };
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
  | { ok: true; clientId: string }
  | { ok: false; code: number; reason: string };

async function authenticateAndRegister(
  ws: WebSocket,
  frame: import('@vicoop-bridge/protocol').HelloFrame,
  opts: ServerWsOptions,
): Promise<AuthResult> {
  const hash = hashToken(frame.token);
  const client = await lookupByTokenHash(opts.db, hash);
  if (!client) {
    logEvent('client_rejected', { reason: 'bad token', agentId: frame.agentId });
    return { ok: false, code: 4005, reason: 'bad token' };
  }
  if (!client.allowed_agent_ids.includes(frame.agentId)) {
    logEvent('client_rejected', {
      reason: 'agent not allowed',
      agentId: frame.agentId,
      clientId: client.id,
      allowed: client.allowed_agent_ids,
    });
    return { ok: false, code: 4008, reason: 'agent id not authorized for this client' };
  }
  const clientId = client.id;
  const ownerWallet = client.owner_wallet;

  const policyResult = await ensureAgentPolicy(opts.db, frame.agentId, ownerWallet, clientId);
  if (!policyResult.ok) {
    logEvent('client_rejected', {
      reason: policyResult.reason,
      agentId: frame.agentId,
      clientId,
    });
    return { ok: false, code: 4010, reason: policyResult.reason };
  }

  const result = opts.registry.registerAgent({
    agentId: frame.agentId,
    clientId,
    ownerWallet,
    agentCard: frame.agentCard,
    allowedCallers: policyResult.allowedCallers,
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

  return { ok: true, clientId };
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
          name: frame.agentCard.name,
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
            // Wire-shape parts; see wireMessageToA2X for the shape note.
            parts: frame.artifact.parts as unknown as Part[] as never,
          },
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
