import type { Context, Next } from 'hono';
import type { ClientConnection, Registry } from './registry.js';
import type { Sql } from './db.js';
import {
  CALLER_TOKEN_PREFIX,
  OWNER_SESSION_PREFIX,
  verifyCallerToken,
} from './auth/caller-token.js';
import { matchPrincipal, type VerifiedCaller } from './auth/principal.js';
import { verifySiweBearerToken } from './auth/siwe-bearer.js';
import { logEvent, truncate } from './log.js';
import { TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX } from './oauth/token-exchange/types.js';
import { verifyTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import { selectCallerContextVersion } from './caller-context.js';

export function getAgentConn(c: Context): ClientConnection {
  return c.get('agentConn') as ClientConnection;
}

export function getCaller(c: Context): VerifiedCaller | undefined {
  return c.get('caller') as VerifiedCaller | undefined;
}

const WWW_AUTH_REALM = 'vicoop-bridge';

// Short opaque correlation id stamped into both the structured rejection log
// and the JSON-RPC error body's `data` field so a caller transcript line
// like "Caller not authorized for this agent (rejectionId=rej_a1b2c3d4)" can
// be grepped 1:1 against the bridge's `agent_request_rejected` log. 32 bits
// of randomness is short enough to be useful in transcripts and large enough
// that nearby-in-time collisions are vanishingly unlikely.
//
// Exported for unit tests.
export function newRejectionId(): string {
  return `rej_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

interface RejectionBody {
  rejectionId: string;
}

function rejectionErrorBody(
  code: number,
  message: string,
  rejectionId: string,
): {
  jsonrpc: '2.0';
  id: null;
  error: { code: number; message: string; data: RejectionBody };
} {
  return {
    jsonrpc: '2.0',
    id: null,
    error: {
      code,
      message,
      data: { rejectionId },
    },
  };
}

// Issue #352 — a bare 404 is reserved for agent ids the bridge has never
// heard of (unknown / unrouteable / misconfigured). A row in `agents` with no
// live WebSocket route means the agent is registered but currently offline
// (operator stopped it, mid-restart) — a transient condition that downstream
// routers should retry shortly, signaled as 503 + Retry-After instead.
//
// On a DB error we can't tell the two apart; report 'offline' (503) so a
// bridge-side outage reads as transient to consumers rather than parking
// known-good agents in a long misconfiguration cooldown.
export async function classifyMissingAgent(
  sql: Sql,
  agentId: string,
): Promise<'unknown' | 'offline'> {
  try {
    const rows = await sql`SELECT 1 FROM agents WHERE id = ${agentId}`;
    return rows.length > 0 ? 'offline' : 'unknown';
  } catch (err) {
    logEvent('agent_lookup_failed', {
      agentId,
      detail: truncate((err as Error).message, 256),
    });
    return 'offline';
  }
}

// Hint for consumers sizing their retry backoff when an agent is registered
// but offline. Operator restarts typically complete within a minute.
export const AGENT_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

// Cap the error_description so a long upstream err.message can't push the
// WWW-Authenticate header past common proxy/server limits (often ~8KB total).
const ERROR_DESCRIPTION_MAX_LEN = 200;

// RFC 6749 §4.1.2.1 restricts error_description to %x20-21 / %x23-5B / %x5D-7E,
// i.e. printable ASCII excluding `"` and `\`. Anything outside that range is
// dropped so the header stays a valid quoted-string without escape handling.
// Output is also length-capped to keep total header size bounded.
//
// Exported for direct unit testing — all call sites inside this module feed
// it stable, hand-authored strings (never raw upstream err.message) to avoid
// leaking internal SQL/verifier details via WWW-Authenticate (often captured
// by access logs). The sanitize + cap remains as defense-in-depth.
export function sanitizeErrorDescription(value: string): string {
  let out = '';
  for (const ch of value) {
    if (out.length >= ERROR_DESCRIPTION_MAX_LEN) break;
    const code = ch.charCodeAt(0);
    if (
      code === 0x20 ||
      code === 0x21 ||
      (code >= 0x23 && code <= 0x5b) ||
      (code >= 0x5d && code <= 0x7e)
    ) {
      out += ch;
    }
  }
  return out;
}

function setWWWAuthenticate(
  c: Context,
  opts: {
    error?: 'invalid_token' | 'insufficient_scope';
    description?: string;
  } = {},
): void {
  const parts = [`realm="${WWW_AUTH_REALM}"`];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.description) {
    parts.push(`error_description="${sanitizeErrorDescription(opts.description)}"`);
  }
  c.header('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
}

export interface AgentAuthOptions {
  sql: Sql;
  deviceFlowEnabled?: boolean;
  responseFormat?: 'jsonrpc' | 'http-json';
  // SIWE domain for the bridge — used to validate raw SIWE bearer tokens
  // (siwe-bearer-auth/v0.1). When undefined, the SIWE bearer fast-path is
  // disabled and only opaque vbc_caller_* tokens are accepted.
  siweDomain?: string;
}

export function rejectAgentRequest(
  c: Context,
  responseFormat: 'jsonrpc' | 'http-json',
  status: 401 | 403 | 404 | 503,
  jsonRpcCode: number,
  message: string,
  rejectionId: string,
) {
  if (responseFormat !== 'http-json') {
    return c.json(rejectionErrorBody(jsonRpcCode, message, rejectionId), status);
  }
  const statusName = {
    401: 'UNAUTHENTICATED',
    403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND',
    503: 'UNAVAILABLE',
  }[status];
  return c.body(
    JSON.stringify({
      error: {
        code: status,
        status: statusName,
        message,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: statusName,
            domain: 'vicoop-bridge',
            metadata: { rejectionId },
          },
        ],
      },
    }),
    status,
    { 'Content-Type': 'application/a2a+json' },
  );
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

  function reject(
    c: Context,
    status: 401 | 403 | 404 | 503,
    jsonRpcCode: number,
    message: string,
    rejectionId: string,
  ) {
    return rejectAgentRequest(
      c,
      opts.responseFormat ?? 'jsonrpc',
      status,
      jsonRpcCode,
      message,
      rejectionId,
    );
  }

  return async (c: Context, next: Next) => {
    const agentId = c.req.param('id')!;
    const conn = registry.getAgent(agentId);
    if (!conn) {
      const rejectionId = newRejectionId();
      if ((await classifyMissingAgent(opts.sql, agentId)) === 'offline') {
        logEvent('agent_request_rejected', {
          agentId,
          reason: 'agent_unavailable',
          rejectionId,
        });
        c.header('Retry-After', String(AGENT_UNAVAILABLE_RETRY_AFTER_SECONDS));
        return reject(
          c,
          503,
          -32000,
          'Agent temporarily unavailable (registered but not connected)',
          rejectionId,
        );
      }
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'agent_not_connected',
        rejectionId,
      });
      return reject(c, 404, -32000, 'Agent not connected', rejectionId);
    }

    c.set('agentConn', conn);

    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    // Empty allowed_callers keeps its historical public-agent meaning, but a
    // A presented token-exchange token must still be validated. Otherwise removing
    // the final exact tuple would turn an already-issued vbc_oauth_* token into
    // an anonymous public request and bypass immediate revocation.
    if (
      conn.allowedCallers.length === 0 &&
      !bearerToken?.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)
    ) {
      return next();
    }

    if (!bearerToken) {
      const rejectionId = newRejectionId();
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'missing_bearer',
        rejectionId,
      });
      // Per RFC 6750 §3.1, no error code when the request lacks any
      // authentication information — only the challenge realm.
      setWWWAuthenticate(c);
      return reject(c, 401, -32001, missingBearerMessage, rejectionId);
    }

    let caller: VerifiedCaller;
    if (bearerToken.startsWith(TOKEN_EXCHANGE_ACCESS_TOKEN_PREFIX)) {
      try {
        if (selectCallerContextVersion(conn.protocolCapabilities) !== 'v2') {
          throw new Error('connected agent does not support caller-context-v2');
        }
        const token = await verifyTokenExchangeAccessToken(opts.sql, bearerToken, agentId);
        caller = {
          principalId: token.principalId,
          ...(token.actorId !== token.principalId
            ? { actorId: token.actorId }
            : {}),
          tokenExchange: {
            tokenId: token.tokenId,
            profileId: token.profileId,
            agentId: token.agentId,
            resource: token.resource,
            actorId: token.actorId,
            scopes: token.scopes,
            allowedCaller: token.allowedCaller,
            ...(token.taskId !== undefined ? { taskId: token.taskId } : {}),
            ...(token.attestation !== undefined
              ? { attestations: [token.attestation] }
              : {}),
          },
        };
      } catch (err) {
        const rejectionId = newRejectionId();
        logEvent('agent_request_rejected', {
          agentId,
          reason: 'invalid_token_exchange_token',
          rejectionId,
          detail: truncate((err as Error).message, 256),
        });
        setWWWAuthenticate(c, {
          error: 'invalid_token',
          description: 'invalid OAuth token-exchange token',
        });
        return reject(c, 401, -32001, 'Invalid bearer token.', rejectionId);
      }
    } else if (bearerToken.startsWith(CALLER_TOKEN_PREFIX)) {
      try {
        caller = await verifyCallerToken(opts.sql, bearerToken);
      } catch (err) {
        const rejectionId = newRejectionId();
        logEvent('agent_request_rejected', {
          agentId,
          reason: 'invalid_token',
          rejectionId,
          detail: truncate((err as Error).message, 256),
        });
        // Don't surface raw err.message in either WWW-Authenticate (commonly
        // captured by proxy access logs) or the JSON-RPC body (returned to
        // unauthenticated callers) — the verifyCallerToken path can throw
        // SQL/connection errors. Detailed cause stays in the structured
        // logEvent above for diagnostics.
        setWWWAuthenticate(c, {
          error: 'invalid_token',
          description: 'invalid bearer token',
        });
        return reject(
          c,
          401,
          -32001,
          `Invalid bearer token. Acquire one via ${acquisitionHint}.`,
          rejectionId,
        );
      }
    } else if (bearerToken.startsWith(OWNER_SESSION_PREFIX)) {
      // Owner-session tokens are for self-service surfaces (admin agent /
      // /graphql) and explicitly not accepted here, even when the principal
      // is in allowed_callers. Reject up front with a clear message — without
      // this, the SIWE-bearer branch below would try to decode the opaque
      // owner-session token as base64url JSON and fail with the misleading
      // "SIWE bearer token is not valid JSON".
      const rejectionId = newRejectionId();
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'owner_session_on_caller_route',
        rejectionId,
      });
      setWWWAuthenticate(c, {
        error: 'invalid_token',
        description: `${OWNER_SESSION_PREFIX}* tokens are not accepted on /agents/:id`,
      });
      return reject(
        c,
        401,
        -32001,
        `Invalid bearer token: ${OWNER_SESSION_PREFIX}* (owner-session) tokens are not accepted on /agents/:id. Acquire one via ${acquisitionHint}.`,
        rejectionId,
      );
    } else if (opts.siweDomain) {
      // Stateless SIWE bearer per siwe-bearer-auth/v0.1. No callers row is
      // created — revocation is at the principal level (remove from
      // allowed_callers) rather than the token level.
      try {
        const verified = await verifySiweBearerToken(bearerToken, { domain: opts.siweDomain });
        caller = { principalId: `eth:${verified.address}` };
      } catch (err) {
        const rejectionId = newRejectionId();
        logEvent('agent_request_rejected', {
          agentId,
          reason: 'invalid_siwe_bearer',
          rejectionId,
          detail: truncate((err as Error).message, 256),
        });
        // Stable public strings in both the header and the JSON body —
        // siwe-bearer verification can surface low-level library/parse
        // errors that we don't want to echo into a header that proxies
        // routinely log, nor into a body returned to unauthenticated callers.
        // Detailed cause stays in the structured logEvent above.
        setWWWAuthenticate(c, {
          error: 'invalid_token',
          description: 'invalid SIWE bearer',
        });
        return reject(
          c,
          401,
          -32001,
          `Invalid bearer token. Acquire one via ${acquisitionHint}.`,
          rejectionId,
        );
      }
    } else {
      const rejectionId = newRejectionId();
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'bad_token_prefix',
        rejectionId,
      });
      setWWWAuthenticate(c, {
        error: 'invalid_token',
        description: `expected ${CALLER_TOKEN_PREFIX}* prefix`,
      });
      return reject(
        c,
        401,
        -32001,
        `Invalid bearer token: expected ${CALLER_TOKEN_PREFIX}* prefix. Acquire one via ${acquisitionHint}.`,
        rejectionId,
      );
    }

    // Token-exchange tokens were already bound to this exact resource and, for
    // message tokens, rechecked against the live exact tuple in Postgres.
    // Task-only tokens recover and recheck the exact tuple from the target
    // task after the route operation is parsed. Other tokens retain
    // the ordinary in-memory allowed-caller match.
    const allowed =
      caller.tokenExchange !== undefined
        ? true
        : conn.allowedCallers.some((entry) => matchPrincipal(entry, caller));
    if (!allowed) {
      const rejectionId = newRejectionId();
      logEvent('agent_request_rejected', {
        agentId,
        reason: 'caller_not_authorized',
        rejectionId,
        principalId: caller.principalId,
      });
      setWWWAuthenticate(c, {
        error: 'insufficient_scope',
        description: 'caller not in allowed list',
      });
      return reject(c, 403, -32001, 'Caller not authorized for this agent', rejectionId);
    }

    c.set('caller', caller);
    return next();
  };
}
