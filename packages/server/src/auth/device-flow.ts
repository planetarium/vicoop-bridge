// RFC-8628 OAuth 2.0 Device Authorization Grant endpoints for vicoop-bridge.
// Exposes POST /oauth/device/code and POST /oauth/token. The UI approval path
// (that sets status='approved' and fills principal_id/email) is implemented
// separately in device-ui.ts.
//
// Three intents flow through the same approval pipeline (see issue #79):
//   * 'caller'          — issue a `vbc_caller_*` Bearer for an external A2A
//                         caller invoking somebody else's agent at
//                         /agents/:id (audience='caller').
//   * 'owner_session'   — issue a `vbc_owner_*` Bearer for the resource
//                         owner's self-service surface (admin chat,
//                         /graphql) (audience='owner_session'). PR D.
//   * 'client_register' — call register_client() on behalf of the approved
//                         principal and return the resulting CLIENT_TOKEN +
//                         client_id, no callers row created. This is the
//                         device-flow vicoop-client onboarding path.
//
// Token endpoint dispatches on `device_sessions.intent`. Approval UI surfaces
// the difference to the operator (device-ui.ts).

import { randomBytes, randomInt } from 'node:crypto';
import type { Hono, Context } from 'hono';
import type { Sql } from '../db.js';
import { issueSessionToken } from './caller-token.js';
import { findReservedAgentId } from '../reserved-agent-ids.js';

export type DeviceFlowIntent = 'caller' | 'owner_session' | 'client_register';

export interface DeviceFlowOptions {
  sql: Sql;
  publicUrl: string;
  sessionTtlMs?: number;
  tokenTtlMs?: number;
  pollIntervalSeconds?: number;
  minPollIntervalMs?: number;
}

const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_MIN_POLL_INTERVAL_MS = 5000;
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// Crockford Base32: no I, L, O, U — reduces ambiguity when users type codes.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_LENGTH = 8;
const USER_CODE_HYPHEN_AT = 4;
const MAX_USER_CODE_RETRIES = 5;

// Bound the size of intent_params so an attacker can't drive a DB into
// large-row territory on what is otherwise a transient session table.
const MAX_CLIENT_NAME_LEN = 256;
const MAX_AGENT_ID_LEN = 256;
const MAX_AGENT_IDS_COUNT = 32;

interface ClientRegisterParams {
  client_name: string;
  allowed_agent_ids: string[];
}

interface DeviceSessionRow {
  device_code: string;
  user_code: string;
  status: string;
  principal_id: string | null;
  email: string | null;
  intent: string;
  intent_params: ClientRegisterParams | null;
  expires_at: Date;
}

// Generate an 8-char Crockford Base32 user code with a hyphen at position 4:
// e.g. "WDJB-MJHT". Uses crypto.randomInt so each char is independently uniform.
export function generateUserCode(): string {
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    if (i === USER_CODE_HYPHEN_AT) out += '-';
    out += CROCKFORD_ALPHABET[randomInt(0, CROCKFORD_ALPHABET.length)];
  }
  return out;
}

// 32 bytes of entropy → 43 chars of unpadded base64url. Matches caller-token's format.
function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

// Parse RFC-6749 form-encoded bodies, falling back to JSON. Both shapes are
// accepted for ergonomics; CLI callers typically send form, JS SDKs send JSON.
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  try {
    const parsed = await c.req.parseBody();
    return parsed as Record<string, unknown>;
  } catch {
    // Fall back to JSON for clients that mislabel content-type.
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

// Coerce a body field into string[] tolerating both JSON arrays (JS SDKs)
// and CSV strings (curl/form). Strips empties.
function toStringArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return null;
}

// Validate a client_register intent's params. Returns either the canonicalized
// params object or an error string suitable for invalid_request error_description.
function parseClientRegisterParams(
  body: Record<string, unknown>,
): { ok: true; params: ClientRegisterParams } | { ok: false; reason: string } {
  const clientName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
  if (!clientName) {
    return { ok: false, reason: 'client_name is required for intent=client_register' };
  }
  if (clientName.length > MAX_CLIENT_NAME_LEN) {
    return { ok: false, reason: `client_name exceeds ${MAX_CLIENT_NAME_LEN} chars` };
  }

  const ids = toStringArray(body.allowed_agent_ids);
  if (!ids || ids.length === 0) {
    return {
      ok: false,
      reason: 'allowed_agent_ids is required for intent=client_register (CSV or JSON array)',
    };
  }
  if (ids.length > MAX_AGENT_IDS_COUNT) {
    return { ok: false, reason: `allowed_agent_ids exceeds ${MAX_AGENT_IDS_COUNT} entries` };
  }
  for (const id of ids) {
    if (id.length > MAX_AGENT_ID_LEN) {
      return { ok: false, reason: `agent id exceeds ${MAX_AGENT_ID_LEN} chars` };
    }
  }
  const reserved = findReservedAgentId(ids);
  if (reserved) {
    return { ok: false, reason: `agent id "${reserved}" is reserved by the bridge` };
  }

  return { ok: true, params: { client_name: clientName, allowed_agent_ids: ids } };
}

interface RegisterClientResult {
  id: string;
  owner_principal: string;
  client_name: string;
  allowed_agent_ids: string[];
  revoked: boolean;
  created_at: Date;
  token: string;
}

export function mountDeviceFlow(app: Hono, opts: DeviceFlowOptions): void {
  const sql = opts.sql;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const tokenTtlMs = opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const pollIntervalSeconds = opts.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const minPollIntervalMs = opts.minPollIntervalMs ?? DEFAULT_MIN_POLL_INTERVAL_MS;

  // Per-device last-poll timestamp for slow_down enforcement. Kept in-memory
  // to avoid schema churn; bounded via prune() (see below).
  const lastPoll = new Map<string, number>();

  function prunePollMap(): void {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [k, v] of lastPoll) {
      if (v < cutoff) lastPoll.delete(k);
    }
  }

  app.post('/oauth/device/code', async (c) => {
    const body = await readBody(c);
    const intentRaw = typeof body.intent === 'string' ? body.intent : 'caller';
    let intent: DeviceFlowIntent;
    let intentParams: ClientRegisterParams | null = null;

    if (intentRaw === 'caller' || intentRaw === '') {
      intent = 'caller';
    } else if (intentRaw === 'owner_session') {
      intent = 'owner_session';
    } else if (intentRaw === 'client_register') {
      intent = 'client_register';
      const parsed = parseClientRegisterParams(body);
      if (!parsed.ok) {
        return c.json({ error: 'invalid_request', error_description: parsed.reason }, 400);
      }
      intentParams = parsed.params;
    } else {
      return c.json(
        { error: 'invalid_request', error_description: `unknown intent: ${intentRaw}` },
        400,
      );
    }

    const deviceCode = generateDeviceCode();
    const expiresAt = new Date(Date.now() + sessionTtlMs);

    let userCode: string | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_USER_CODE_RETRIES; attempt++) {
      const candidate = generateUserCode();
      try {
        await sql`
          INSERT INTO device_sessions (device_code, user_code, status, expires_at, intent, intent_params)
          VALUES (
            ${deviceCode},
            ${candidate},
            'pending',
            ${expiresAt},
            ${intent},
            ${intentParams ? sql.json(JSON.parse(JSON.stringify(intentParams))) : null}
          )
        `;
        userCode = candidate;
        break;
      } catch (err) {
        lastErr = err;
        // Collision on user_code unique index — retry with a new code.
        continue;
      }
    }

    if (!userCode) {
      // Surface a 500 without leaking the raw DB error.
      console.error('[device-flow] failed to allocate user_code', lastErr);
      return c.json({ error: 'server_error' }, 500);
    }

    prunePollMap();

    const verificationUri = `${opts.publicUrl}/oauth/device`;
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;

    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: Math.floor(sessionTtlMs / 1000),
      interval: pollIntervalSeconds,
    });
  });

  app.post('/oauth/token', async (c) => {
    const body = await readBody(c);
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : undefined;
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : undefined;

    if (grantType !== DEVICE_CODE_GRANT_TYPE) {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }
    if (!deviceCode) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // Slow-down enforcement *before* DB lookup to bound load from noisy pollers.
    const now = Date.now();
    const prev = lastPoll.get(deviceCode);
    if (prev !== undefined && now - prev < minPollIntervalMs) {
      return c.json({ error: 'slow_down' }, 400);
    }
    lastPoll.set(deviceCode, now);

    const rows = await sql<DeviceSessionRow[]>`
      SELECT device_code, user_code, status, principal_id, email, intent, intent_params, expires_at
      FROM device_sessions
      WHERE device_code = ${deviceCode}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      lastPoll.delete(deviceCode);
      return c.json({ error: 'expired_token' }, 400);
    }

    if (row.expires_at.getTime() <= Date.now()) {
      // Best-effort status bump for observability; ignore failures.
      await sql`
        UPDATE device_sessions SET status = 'expired'
        WHERE device_code = ${deviceCode} AND status <> 'expired'
      `;
      lastPoll.delete(deviceCode);
      return c.json({ error: 'expired_token' }, 400);
    }

    if (row.status === 'pending') {
      return c.json({ error: 'authorization_pending' }, 400);
    }

    if (row.status === 'expired') {
      lastPoll.delete(deviceCode);
      return c.json({ error: 'expired_token' }, 400);
    }

    if (row.status === 'approved') {
      if (!row.principal_id) {
        // Defensive: approved rows must have principal_id. Treat as expired.
        lastPoll.delete(deviceCode);
        return c.json({ error: 'expired_token' }, 400);
      }

      if (row.intent === 'client_register') {
        const params = row.intent_params;
        if (!params) {
          // Approved client_register session must have intent_params; if it
          // doesn't, the session is unusable. Treat as expired so the CLI
          // restarts with a fresh request.
          lastPoll.delete(deviceCode);
          return c.json({ error: 'expired_token' }, 400);
        }

        const principalId = row.principal_id;
        const email = row.email;

        const issued = await sql.begin(async (tx) => {
          // SECURITY INVOKER on register_client(); set the session principal
          // so RLS WITH CHECK passes and the new row's owner_principal is
          // correct without us needing to pass it as the explicit override
          // (which would require admin scope).
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.principal_id', ${principalId}, true)`;
          // app.admin_addresses left empty — non-admin path is what we want
          // here; the function falls through to current_principal().
          await tx`SELECT set_config('app.admin_addresses', '', true)`;

          const result = await tx<RegisterClientResult[]>`
            SELECT * FROM register_client(
              ${params.client_name},
              ${params.allowed_agent_ids}::text[],
              NULL
            )
          `;
          const r = result[0];
          if (!r) throw new Error('register_client returned no row');

          // Stamp owner_email so admin tooling can render a human-readable
          // identity for Google-onboarded clients (sub is opaque).
          if (email) {
            await tx`UPDATE clients SET owner_email = ${email} WHERE id = ${r.id}`;
          }

          await tx`DELETE FROM device_sessions WHERE device_code = ${deviceCode}`;
          return r;
        });

        lastPoll.delete(deviceCode);
        prunePollMap();

        return c.json({
          intent: 'client_register' as const,
          client_id: issued.id,
          client_token: issued.token,
          owner_principal: issued.owner_principal,
          owner_email: email ?? null,
          client_name: issued.client_name,
          allowed_agent_ids: issued.allowed_agent_ids,
        });
      }

      // intent === 'caller' or 'owner_session' — issue a session token of
      // the matching audience. The two paths are otherwise identical
      // (single principal, persisted to callers, returned via OAuth-style
      // access_token response). Audience selects the prefix
      // (`vbc_caller_*` vs `vbc_owner_*`) and constrains downstream usage.
      const audience = row.intent === 'owner_session' ? 'owner_session' : 'caller';
      const issued = await sql.begin(async (tx) => {
        const i = await issueSessionToken(tx as unknown as Sql, {
          principalId: row.principal_id!,
          provider: 'google',
          audience,
          email: row.email ?? undefined,
          ttlMs: tokenTtlMs,
        });
        await tx`DELETE FROM device_sessions WHERE device_code = ${deviceCode}`;
        return i;
      });

      lastPoll.delete(deviceCode);
      prunePollMap();

      const expiresInSec = Math.max(
        0,
        Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000),
      );
      return c.json({
        access_token: issued.rawToken,
        token_type: 'Bearer',
        expires_in: expiresInSec,
        // The token's principal/email aren't carried in the opaque token
        // itself, so we surface them here. The CLI uses these to confirm
        // (and persist) which identity the operator is logged in as.
        principal_id: row.principal_id,
        email: row.email ?? null,
      });
    }

    // Unknown status — conservative fallback.
    return c.json({ error: 'expired_token' }, 400);
  });
}
