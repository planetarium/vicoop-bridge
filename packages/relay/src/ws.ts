import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { parseUpFrame, PROTOCOL_VERSION, type Part, type TaskStatus } from '@vicoop-bridge/protocol';
import type { Registry } from './registry.js';

export interface RelayWsOptions {
  adapterToken: string;
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
      if (frame.token !== opts.adapterToken) {
        ws.close(4005, 'bad token');
        return;
      }
      const result = opts.registry.registerAgent({
        agentId: frame.agentId,
        agentCard: frame.agentCard,
        ws,
        connectedAt: Date.now(),
      });
      if (!result.ok) {
        ws.close(4006, result.reason);
        return;
      }
      agentId = frame.agentId;
      authed = true;
      clearTimeout(helloTimeout);
      console.log(`[relay] adapter connected: ${agentId} (${frame.agentCard.name})`);
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
      console.log(`[relay] adapter disconnected: ${agentId}`);
      opts.registry.unregisterAgent(agentId, ws);
    }
  });

  ws.on('error', (err) => {
    console.error('[relay] ws error:', err);
  });
}
