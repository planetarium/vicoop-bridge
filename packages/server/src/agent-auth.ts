import type { Context, Next } from 'hono';
import type { ClientConnection, Registry } from './registry.js';
import type { Sql } from './db.js';
import { CALLER_TOKEN_PREFIX, verifyCallerToken } from './auth/caller-token.js';
import { matchPrincipal, type VerifiedCaller } from './auth/principal.js';
import { logEvent, truncate } from './log.js';

export function getAgentConn(c: Context): ClientConnection {
  return c.get('agentConn') as ClientConnection;
}

export function getCaller(c: Context): VerifiedCaller | undefined {
  return c.get('caller') as VerifiedCaller | undefined;
}

export interface AgentAuthOptions {
  sql: Sql;
  deviceFlowEnabled?: boolean;
}

export function agentAuthMiddleware(registry: Registry, opts: AgentAuthOptions) {
  // /agents/:id only accepts caller-audience tokens. Owner-session tokens
  // (vbc_owner_*) are for self-service surfaces and explicitly rejected
  // here even if they belong to a principal in allowed_callers.
  const acquisitionHint = opts.deviceFlowEnabled
    ? '/auth/siwe/exchange (SIWE, intent=caller) or /oauth/token (device flow, intent=caller)'
    : '/auth/siwe/exchange (SIWE, intent=caller)';

  return async (c: Context, next: Next) => {
    const agentId = c.req.param('id')!;
    const conn = registry.getAgent(agentId);
    if (!conn) {
      logEvent('agent_request_rejected', { agentId, reason: 'agent_not_connected' });
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
      logEvent('agent_request_rejected', { agentId, reason: 'missing_bearer' });
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: `Authentication required (Bearer ${CALLER_TOKEN_PREFIX}* token)`,
        },
      }, 401);
    }

    if (!bearerToken.startsWith(CALLER_TOKEN_PREFIX)) {
      logEvent('agent_request_rejected', { agentId, reason: 'bad_token_prefix' });
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: `Invalid bearer token: expected ${CALLER_TOKEN_PREFIX}* prefix. Acquire one via ${acquisitionHint}.`,
        },
      }, 401);
    }

    let caller: VerifiedCaller;
    try {
      caller = await verifyCallerToken(opts.sql, bearerToken);
    } catch (err) {
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'invalid_token',
        detail: truncate((err as Error).message, 256),
      });
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: `Invalid bearer token: ${(err as Error).message}` },
      }, 401);
    }

    const allowed = conn.allowedCallers.some((entry) => matchPrincipal(entry, caller));
    if (!allowed) {
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'caller_not_authorized',
        principalId: caller.principalId,
      });
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
