import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { parseUpFrame, PROTOCOL_VERSION } from '@vicoop-bridge/protocol';
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

function handleConnection(ws: WebSocket, _req: IncomingMessage, opts: RelayWsOptions): void {
  let agentId: string | null = null;
  let authed = false;

  const helloTimeout = setTimeout(() => {
    if (!authed) {
      ws.close(4001, 'hello timeout');
    }
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
      case 'task.status':
        opts.registry.updateTaskStatus(frame.taskId, frame.status);
        break;
      case 'task.artifact':
        opts.registry.addArtifact(frame.taskId, frame.artifact);
        break;
      case 'task.complete':
        opts.registry.completeTask(frame.taskId, frame.status);
        break;
      case 'task.fail':
        opts.registry.failTask(frame.taskId, frame.error.code, frame.error.message);
        break;
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
