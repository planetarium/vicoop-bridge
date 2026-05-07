import type { Context, Next } from 'hono';
import type { ClientConnection, Registry } from './registry.js';
import type { Sql } from './db.js';
import { CALLER_TOKEN_PREFIX, verifyCallerToken } from './auth/caller-token.js';
import { matchPrincipal, type VerifiedCaller } from './auth/principal.js';
import { verifySiweBearerToken } from './auth/siwe-bearer.js';
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
  // SIWE domain for the bridge — used to validate raw SIWE bearer tokens
  // (siwe-bearer-auth/v0.1). When undefined, the SIWE bearer fast-path is
  // disabled and only opaque vbc_caller_* tokens are accepted.
  siweDomain?: string;
}

export function agentAuthMiddleware(registry: Registry, opts: AgentAuthOptions) {
  // /agents/:id accepts two bearer shapes (issue #31 + siwe-bearer-auth/v0.1):
  //   1. Opaque vbc_caller_* (issued by /auth/siwe/exchange or /oauth/token)
  //   2. base64url-encoded SIWE bearer (self-verifying per siwe-bearer-auth/v0.1) —
  //      only when opts.siweDomain is set; otherwise the fast-path is disabled.
  // Owner-session tokens (vbc_owner_*) are for self-service surfaces and
  // explicitly rejected here even if they belong to a principal in
  // allowed_callers.
  const siweEnabled = Boolean(opts.siweDomain);
  const exchangeHint = '/auth/siwe/exchange (SIWE, intent=caller)';
  const deviceHint = opts.deviceFlowEnabled
    ? '/oauth/token (device flow, intent=caller)'
    : null;
  const siweBearerHint = siweEnabled ? 'a base64url SIWE bearer per siwe-bearer-auth/v0.1' : null;
  const acquisitionHint = [exchangeHint, deviceHint, siweBearerHint]
    .filter((h): h is string => h !== null)
    .join(', ');
  const missingBearerMessage = siweEnabled
    ? `Authentication required (Bearer ${CALLER_TOKEN_PREFIX}* or SIWE bearer)`
    : `Authentication required (Bearer ${CALLER_TOKEN_PREFIX}*)`;

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
          message: missingBearerMessage,
        },
      }, 401);
    }

    let caller: VerifiedCaller;
    if (bearerToken.startsWith(CALLER_TOKEN_PREFIX)) {
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
    } else if (opts.siweDomain) {
      // Stateless SIWE bearer per siwe-bearer-auth/v0.1. No callers row is
      // created — revocation is at the principal level (remove from
      // allowed_callers) rather than the token level.
      try {
        const verified = await verifySiweBearerToken(bearerToken, { domain: opts.siweDomain });
        caller = { principalId: `eth:${verified.address}` };
      } catch (err) {
        logEvent('agent_request_rejected', {
          agentId,
          reason: 'invalid_siwe_bearer',
          detail: truncate((err as Error).message, 256),
        });
        return c.json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: `Invalid bearer token: ${(err as Error).message}. Acquire one via ${acquisitionHint}.`,
          },
        }, 401);
      }
    } else {
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
