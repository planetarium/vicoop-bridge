// POST /oauth/revoke — RFC 7009 OAuth 2.0 Token Revocation.
//
// Lives in its own module rather than inside device-flow.ts because revocation
// is independent of how the token was originally issued: a `vbc_caller_*` or
// `vbc_owner_*` token obtained via the SIWE exchange (auth/siwe-exchange.ts)
// is just as revocable here as one issued via the device flow
// (auth/device-flow.ts). Co-locating with device-flow would imply otherwise.
//
// Security model: possession of a valid bridge-issued opaque bearer is itself
// sufficient to revoke it. RFC 7009 §2.1 allows this for public clients with
// bearer tokens; vicoop-client is not a confidential OAuth client. The lookup
// is by token_hash, so an attacker who doesn't already hold the token can't
// enumerate or invalidate someone else's session.
//
// Unknown / malformed / already-revoked tokens all return 200 per RFC 7009
// §2.2 — leaking validity here would turn /oauth/revoke into an oracle for
// guessed tokens.

import type { Hono, Context } from 'hono';
import type { Sql } from '../db.js';
import { revokeSessionTokenByRaw } from './caller-token.js';

export interface RevocationOptions {
  sql: Sql;
}

// Accept both form-encoded (RFC 6749 / 7009 default) and JSON bodies, matching
// the same ergonomics device-flow.ts uses for /oauth/token. We deliberately
// don't share a helper across the two modules — readBody is local and small,
// and a shared one would invite either module to grow features the other
// doesn't need.
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
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

export function mountTokenRevocation(app: Hono, opts: RevocationOptions): void {
  app.post('/oauth/revoke', async (c) => {
    const body = await readBody(c);
    const token = typeof body.token === 'string' ? body.token : undefined;
    if (!token) {
      return c.json({ error: 'invalid_request', error_description: 'token is required' }, 400);
    }
    // token_type_hint is accepted but ignored — the prefix on the token
    // already identifies the audience.
    await revokeSessionTokenByRaw(opts.sql, token);
    return c.body(null, 200);
  });
}
