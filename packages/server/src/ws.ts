import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { parseUpFrame, PROTOCOL_VERSION, type Part, type TaskStatus } from '@vicoop-bridge/protocol';
import type { Registry } from './registry.js';
import type { Sql } from './db.js';
import { hashToken } from './token.js';

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
  // registering client. The WHERE guards against a different wallet silently
  // taking over an existing policy — the ownership check below still rejects.
  await sql`
    INSERT INTO agent_policies (agent_id, owner_wallet, client_id)
    VALUES (${agentId}, ${ownerWallet.toLowerCase()}, ${clientId})
    ON CONFLICT (agent_id) DO UPDATE
      SET client_id = EXCLUDED.client_id, updated_at = now()
      WHERE agent_policies.owner_wallet = EXCLUDED.owner_wallet
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
  return { ok: true, allowedCallers: rows[0].allowed_callers.map((a) => a.toLowerCase()) };
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
    console.log(JSON.stringify({
      event: 'client_rejected',
      reason: 'bad token',
      agentId: frame.agentId,
      ts: new Date().toISOString(),
    }));
    return { ok: false, code: 4005, reason: 'bad token' };
  }
  if (!client.allowed_agent_ids.includes(frame.agentId)) {
    console.log(JSON.stringify({
      event: 'client_rejected',
      reason: 'agent not allowed',
      agentId: frame.agentId,
      clientId: client.id,
      allowed: client.allowed_agent_ids,
      ts: new Date().toISOString(),
    }));
    return { ok: false, code: 4008, reason: 'agent id not authorized for this client' };
  }
  const clientId = client.id;
  const ownerWallet = client.owner_wallet;

  const policyResult = await ensureAgentPolicy(opts.db, frame.agentId, ownerWallet, clientId);
  if (!policyResult.ok) {
    console.log(JSON.stringify({
      event: 'client_rejected',
      reason: policyResult.reason,
      agentId: frame.agentId,
      clientId,
      ts: new Date().toISOString(),
    }));
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
    console.log(JSON.stringify({
      event: 'client_rejected',
      reason: result.reason,
      agentId: frame.agentId,
      clientId,
      ts: new Date().toISOString(),
    }));
    return { ok: false, code: 4006, reason: result.reason };
  }

  return { ok: true, clientId };
}

function toA2AMessage(
  status: TaskStatus,
  taskId: string,
  contextId: string,
): TaskStatus['message'] extends undefined ? undefined : object | undefined {
  if (!status.message) return undefined;
  const m = status.message;
  return {
    kind: 'message' as const,
    role: m.role,
    messageId: m.messageId,
    parts: m.parts as Part[],
    taskId,
    contextId,
  } as never;
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
        console.log(JSON.stringify({
          event: 'client_connected',
          agentId,
          clientId: result.clientId,
          name: frame.agentCard.name,
          ts: new Date().toISOString(),
        }));
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
        b.eventBus.publish({
          kind: 'status-update',
          taskId: frame.taskId,
          contextId: b.contextId,
          final: false,
          status: {
            ...frame.status,
            message: toA2AMessage(frame.status, frame.taskId, b.contextId) as never,
          },
        });
        break;
      }
      case 'task.artifact': {
        const b = opts.registry.getBinding(frame.taskId);
        if (!b) return;
        b.eventBus.publish({
          kind: 'artifact-update',
          taskId: frame.taskId,
          contextId: b.contextId,
          artifact: frame.artifact as never,
          lastChunk: frame.lastChunk,
        });
        break;
      }
      case 'task.complete': {
        const b = opts.registry.getBinding(frame.taskId);
        if (!b) return;
        b.eventBus.publish({
          kind: 'status-update',
          taskId: frame.taskId,
          contextId: b.contextId,
          final: true,
          status: {
            ...frame.status,
            message: toA2AMessage(frame.status, frame.taskId, b.contextId) as never,
          },
        });
        b.eventBus.finished();
        opts.registry.unbindTask(frame.taskId);
        break;
      }
      case 'task.fail': {
        const b = opts.registry.getBinding(frame.taskId);
        if (!b) return;
        b.eventBus.publish({
          kind: 'status-update',
          taskId: frame.taskId,
          contextId: b.contextId,
          final: true,
          status: {
            state: 'failed',
            timestamp: new Date().toISOString(),
            message: {
              kind: 'message',
              role: 'agent',
              messageId: `${frame.taskId}-err`,
              parts: [{ kind: 'text', text: `${frame.error.code}: ${frame.error.message}` }],
              taskId: frame.taskId,
              contextId: b.contextId,
            } as never,
          },
        });
        b.eventBus.finished();
        opts.registry.unbindTask(frame.taskId);
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
      console.log(JSON.stringify({ event: 'client_disconnected', agentId, ts: new Date().toISOString() }));
      opts.registry.unregisterAgent(agentId, ws);
    }
  });

  ws.on('error', (err) => {
    console.error('[server] ws error:', err);
  });
}
