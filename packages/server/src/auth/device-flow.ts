// RFC-8628 OAuth 2.0 Device Authorization Grant endpoints for vicoop-bridge.
// Exposes POST /oauth/device/code and POST /oauth/token. The UI approval path
// (that sets status='approved' and fills principal_id/email) is implemented
// separately in device-ui.ts.

import { randomBytes, randomInt } from 'node:crypto';
import type { Hono, Context } from 'hono';
import type { Sql } from '../db.js';
import { issueCallerToken } from './caller-token.js';

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

interface DeviceSessionRow {
  device_code: string;
  user_code: string;
  status: string;
  principal_id: string | null;
  email: string | null;
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
    // Body is deliberately ignored — we don't do external client registration yet.
    const deviceCode = generateDeviceCode();
    const expiresAt = new Date(Date.now() + sessionTtlMs);

    let userCode: string | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_USER_CODE_RETRIES; attempt++) {
      const candidate = generateUserCode();
      try {
        await sql`
          INSERT INTO device_sessions (device_code, user_code, status, expires_at)
          VALUES (${deviceCode}, ${candidate}, 'pending', ${expiresAt})
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
      SELECT device_code, user_code, status, principal_id, email, expires_at
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

      // Issue the caller token and delete the session atomically. The transaction
      // object from postgres.js is type-compatible with Sql, so issueCallerToken
      // participates in the same tx.
      const issued = await sql.begin(async (tx) => {
        const i = await issueCallerToken(tx as unknown as Sql, {
          principalId: row.principal_id!,
          provider: 'google',
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
      });
    }

    // Unknown status — conservative fallback.
    return c.json({ error: 'expired_token' }, 400);
  });
}
