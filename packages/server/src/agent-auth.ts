import type { Context, Next } from 'hono';
import type { ClientConnection, Registry } from './registry.js';
import type { Sql } from './db.js';
import { verifySiweToken } from './siwe-token.js';
import { CALLER_TOKEN_PREFIX, verifyCallerToken } from './auth/caller-token.js';
import { matchPrincipal, type VerifiedCaller } from './auth/principal.js';

export function getAgentConn(c: Context): ClientConnection {
  return c.get('agentConn') as ClientConnection;
}

export function getCaller(c: Context): VerifiedCaller | undefined {
  return c.get('caller') as VerifiedCaller | undefined;
}

export interface AgentAuthOptions {
  sql: Sql;
  domain?: string;
}

export function agentAuthMiddleware(registry: Registry, opts: AgentAuthOptions) {
  return async (c: Context, next: Next) => {
    const agentId = c.req.param('id')!;
    const conn = registry.getAgent(agentId);
    if (!conn) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Agent not connected' },
      }, 404);
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
        error: { code: -32001, message: 'Authentication required (Bearer SIWE or caller token)' },
      }, 401);
    }

    let caller: VerifiedCaller;
    try {
      if (bearerToken.startsWith(CALLER_TOKEN_PREFIX)) {
        caller = await verifyCallerToken(opts.sql, bearerToken);
      } else {
        const wallet = await verifySiweToken(bearerToken, { domain: opts.domain });
        caller = { principalId: `eth:${wallet.toLowerCase()}` };
      }
    } catch (err) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: `Invalid bearer token: ${(err as Error).message}` },
      }, 401);
    }

    const allowed = conn.allowedCallers.some((entry) => matchPrincipal(entry, caller));
    if (!allowed) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Caller not authorized for this agent' },
      }, 403);
    }

    c.set('caller', caller);
    return next();
  };
}
