import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { parseUpFrame, PROTOCOL_VERSION, type Part, type TaskStatus } from '@vicoop-bridge/protocol';
import type { Registry } from './registry.js';
import { hashToken, lookupByTokenHash, type Sql } from './db.js';

export interface RelayWsOptions {
  db: Sql;
  registry: Registry;
}

export function attachWsServer(server: Server, opts: RelayWsOptions): void {
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
  | { ok: true; connectorId: string }
  | { ok: false; code: number; reason: string };

async function authenticateAndRegister(
  ws: WebSocket,
  frame: import('@vicoop-bridge/protocol').HelloFrame,
  opts: RelayWsOptions,
): Promise<AuthResult> {
  const hash = hashToken(frame.token);
  const connector = await lookupByTokenHash(opts.db, hash);
  if (!connector) {
    console.log(JSON.stringify({
      event: 'connector_rejected',
      reason: 'bad token',
      agentId: frame.agentId,
      ts: new Date().toISOString(),
    }));
    return { ok: false, code: 4005, reason: 'bad token' };
  }
  if (!connector.allowed_agent_ids.includes(frame.agentId)) {
    console.log(JSON.stringify({
      event: 'connector_rejected',
      reason: 'agent not allowed',
      agentId: frame.agentId,
      connectorId: connector.id,
      allowed: connector.allowed_agent_ids,
      ts: new Date().toISOString(),
    }));
    return { ok: false, code: 4008, reason: 'agent id not authorized for this connector' };
  }
  const connectorId = connector.id;

  const result = opts.registry.registerAgent({
    agentId: frame.agentId,
    connectorId,
    agentCard: frame.agentCard,
    ws,
    connectedAt: Date.now(),
  });
  if (!result.ok) {
    console.log(JSON.stringify({
      event: 'connector_rejected',
      reason: result.reason,
      agentId: frame.agentId,
      connectorId,
      ts: new Date().toISOString(),
    }));
    return { ok: false, code: 4006, reason: result.reason };
  }

  return { ok: true, connectorId };
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

function handleConnection(ws: WebSocket, _req: IncomingMessage, opts: RelayWsOptions): void {
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
          event: 'connector_connected',
          agentId,
          connectorId: result.connectorId,
          name: frame.agentCard.name,
          ts: new Date().toISOString(),
        }));
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
      console.log(JSON.stringify({ event: 'connector_disconnected', agentId, ts: new Date().toISOString() }));
      opts.registry.unregisterAgent(agentId, ws);
    }
  });

  ws.on('error', (err) => {
    console.error('[relay] ws error:', err);
  });
}
