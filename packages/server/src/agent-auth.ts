import type { Context, Next } from 'hono';
import type { ClientConnection, Registry } from './registry.js';
import { verifySiweToken } from './siwe-token.js';

export function getAgentConn(c: Context): ClientConnection {
  return c.get('agentConn') as ClientConnection;
}

export interface AgentAuthOptions {
  domain?: string;
}

export function agentAuthMiddleware(registry: Registry, opts?: AgentAuthOptions) {
  return async (c: Context, next: Next) => {
    const agentId = c.req.param('id')!;
    const conn = registry.getAgent(agentId);
    if (!conn) {
      return c.json({ error: 'agent not connected' }, 404);
    }

    c.set('agentConn', conn);

    if (conn.allowedCallers.length === 0) {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (!bearerToken) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Authentication required (Bearer SIWE token)' },
      }, 401);
    }

    let walletAddress: string;
    try {
      walletAddress = await verifySiweToken(bearerToken, { domain: opts?.domain });
    } catch (err) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: `Invalid SIWE token: ${(err as Error).message}` },
      }, 401);
    }

    if (!conn.allowedCallers.includes(walletAddress.toLowerCase())) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Wallet not authorized for this agent' },
      }, 403);
    }

    return next();
  };
}
