// Browser-facing Device Authorization flow: a user enters a user_code printed
// by a CLI, signs in with Google via our OAuth client, and the callback marks
// the underlying device_code session as approved.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';

import {
  buildAuthorizeUrl,
  exchangeCode,
  type GoogleConfig,
} from './google-oauth.js';
import type { Sql } from '../db.js';

export interface DeviceUiOptions {
  sql: Sql;
  google: GoogleConfig;
  stateSecret: string;
  publicUrl: string;
}

// ---- small helpers ----------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0b0b; color: #e5e5e5;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 2rem; }
  .card { max-width: 28rem; width: 100%; background: #1a1a1a;
          border: 1px solid #2a2a2a; border-radius: 0.75rem; padding: 2rem; }
  h1 { margin: 0 0 1rem 0; font-size: 1.25rem; }
  .code { font-family: ui-monospace, monospace; font-size: 1.5rem;
          letter-spacing: 0.1em; background: #0b0b0b; padding: 0.75rem 1rem;
          border-radius: 0.5rem; display: inline-block; margin: 0.5rem 0 1rem; }
  .btn { display: inline-block; background: #3b82f6; color: white;
         padding: 0.75rem 1.25rem; border-radius: 0.5rem;
         text-decoration: none; font-weight: 600; }
  .btn:hover { background: #2563eb; }
  input { background: #0b0b0b; color: #e5e5e5; border: 1px solid #2a2a2a;
          padding: 0.5rem 0.75rem; border-radius: 0.375rem; width: 100%;
          box-sizing: border-box; margin-bottom: 0.75rem; font-size: 1rem; }
  p { color: #a3a3a3; line-height: 1.5; }
  .error { color: #f87171; }
</style></head><body><div class="card">${body}</div></body></html>`;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function hmacOf(secret: string, deviceCode: string): Buffer {
  return createHmac('sha256', secret).update(deviceCode).digest();
}

// state = base64url(HMAC) + '.' + base64url(device_code)
function buildState(secret: string, deviceCode: string): string {
  const mac = hmacOf(secret, deviceCode);
  return `${b64urlEncode(mac)}.${b64urlEncode(Buffer.from(deviceCode, 'utf8'))}`;
}

// Returns the decoded device_code on success, or null on any failure.
// Uses timingSafeEqual with equal-length buffers.
function verifyState(secret: string, state: string): string | null {
  if (typeof state !== 'string' || state.length === 0) return null;
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const macPart = state.slice(0, dot);
  const dcPart = state.slice(dot + 1);
  if (!macPart || !dcPart) return null;

  let presented: Buffer;
  let deviceCodeBuf: Buffer;
  try {
    presented = b64urlDecode(macPart);
    deviceCodeBuf = b64urlDecode(dcPart);
  } catch {
    return null;
  }
  const deviceCode = deviceCodeBuf.toString('utf8');
  if (deviceCode.length === 0) return null;

  const expected = hmacOf(secret, deviceCode);
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  return deviceCode;
}

// Normalize "wdjb mjht" / "wdjb-mjht" / "WDJBMJHT" → "WDJB-MJHT"
function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[\s-]+/g, '');
  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
  }
  return cleaned;
}

// ---- route handlers --------------------------------------------------------

interface DeviceRow {
  device_code: string;
  user_code: string;
  status: string;
  expires_at: Date;
}

export function mountDeviceUi(app: Hono, opts: DeviceUiOptions): void {
  app.get('/oauth/device', async (c) => {
    const raw = c.req.query('user_code');
    if (!raw || raw.trim() === '') {
      const body = `
        <h1>Enter device code</h1>
        <form method="GET">
          <input name="user_code" placeholder="Enter code (e.g. WDJB-MJHT)" autofocus>
          <button class="btn" type="submit">Continue</button>
        </form>
      `;
      return c.html(page('Device authorization', body));
    }

    const normalized = normalizeUserCode(raw);
    const rows = await opts.sql<DeviceRow[]>`
      SELECT device_code, user_code, status, expires_at
      FROM device_sessions
      WHERE user_code = ${normalized}
        AND status = 'pending'
        AND expires_at > now()
      LIMIT 1
    `;

    if (rows.length === 0) {
      const body = `
        <h1 class="error">Invalid or expired code</h1>
        <p>The code you entered is not recognized or has expired.</p>
        <p><a class="btn" href="/oauth/device">Try again</a></p>
      `;
      return c.html(page('Invalid code', body), 400);
    }

    const safeCode = escapeHtml(normalized);
    const href = `/oauth/google/start?user_code=${encodeURIComponent(normalized)}`;
    const body = `
      <h1>Authorize device</h1>
      <div class="code">${safeCode}</div>
      <p>You'll be asked to sign in to Google to authorize device <strong>${safeCode}</strong>.</p>
      <p><a class="btn" href="${escapeHtml(href)}">Continue with Google</a></p>
    `;
    return c.html(page('Authorize device', body));
  });

  app.get('/oauth/google/start', async (c) => {
    const raw = c.req.query('user_code');
    if (!raw) {
      return c.html(
        page(
          'Invalid code',
          `<h1 class="error">Invalid or expired code</h1><p><a class="btn" href="/oauth/device">Back</a></p>`,
        ),
        400,
      );
    }
    const normalized = normalizeUserCode(raw);
    const rows = await opts.sql<{ device_code: string }[]>`
      SELECT device_code
      FROM device_sessions
      WHERE user_code = ${normalized}
        AND status = 'pending'
        AND expires_at > now()
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return c.html(
        page(
          'Invalid code',
          `<h1 class="error">Invalid or expired code</h1><p><a class="btn" href="/oauth/device">Back</a></p>`,
        ),
        400,
      );
    }

    const state = buildState(opts.stateSecret, row.device_code);
    const url = buildAuthorizeUrl(opts.google, state);
    return c.redirect(url, 302);
  });

  app.get('/oauth/google/callback', async (c) => {
    const error = c.req.query('error');
    if (error) {
      const body = `
        <h1 class="error">Authorization denied</h1>
        <p>${escapeHtml(error)}</p>
        <p>You may close this window.</p>
      `;
      return c.html(page('Authorization denied', body));
    }

    const state = c.req.query('state') ?? '';
    const deviceCode = verifyState(opts.stateSecret, state);
    if (!deviceCode) {
      return c.html(
        page(
          'Invalid state',
          `<h1 class="error">Invalid state</h1><p>The authorization request could not be verified.</p>`,
        ),
        400,
      );
    }

    const code = c.req.query('code');
    if (!code) {
      return c.html(
        page(
          'Invalid request',
          `<h1 class="error">Invalid request</h1><p>Missing authorization code.</p>`,
        ),
        400,
      );
    }

    const rows = await opts.sql<{ status: string; expires_at: Date }[]>`
      SELECT status, expires_at
      FROM device_sessions
      WHERE device_code = ${deviceCode}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return c.html(
        page(
          'Session expired',
          `<h1 class="error">Session expired</h1><p>Your device session was not found.</p>`,
        ),
        400,
      );
    }
    if (row.status !== 'pending' || row.expires_at.getTime() <= Date.now()) {
      return c.html(
        page(
          'Session expired',
          `<h1 class="error">Session expired or already completed</h1><p>You may close this window.</p>`,
        ),
        400,
      );
    }

    let user;
    try {
      user = await exchangeCode(opts.google, code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      const body = `
        <h1 class="error">Google verification failed</h1>
        <p>${escapeHtml(msg)}</p>
      `;
      return c.html(page('Verification failed', body), 400);
    }

    const principalId = `google:${user.sub}`;
    const updated = await opts.sql`
      UPDATE device_sessions
      SET status = 'approved',
          principal_id = ${principalId},
          email = ${user.email},
          approved_at = now()
      WHERE device_code = ${deviceCode}
        AND status = 'pending'
    `;

    // postgres.js returns a result with a `count` field for non-SELECT.
    const affected = (updated as unknown as { count?: number }).count ?? 0;
    if (affected === 0) {
      return c.html(
        page(
          'No longer pending',
          `<h1 class="error">Session was no longer pending</h1><p>You may close this window.</p>`,
        ),
        400,
      );
    }

    const body = `
      <h1>Approved</h1>
      <p>Approved as <strong>${escapeHtml(user.email)}</strong>.</p>
      <p>You may close this window.</p>
    `;
    return c.html(page('Approved', body));
  });
}

// Test-only exports. Not part of the public API.
export const __test__ = {
  buildState,
  verifyState,
  escapeHtml,
  normalizeUserCode,
  page,
};
