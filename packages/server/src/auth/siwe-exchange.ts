// POST /auth/siwe/exchange — issues an opaque caller token in exchange for a
// verified SIWE (message, signature) pair.
//
// This unifies SIWE with the bridge's opaque token model: after exchange, the
// SIWE signature is never presented to the server again. The caller presents
// the opaque `vbc_caller_*` token on subsequent requests (admin GraphQL, A2A
// /agents/:id, root POST /). Revocation, audit (`last_used_at`, `label`), and
// admin tooling (`list_caller_tokens` / `revoke_caller_token`) all apply.
//
// TTL is inherited from the SIWE message's `expirationTime` rather than the
// 90-day caller-token default; SIWE messages cap at 7 days by convention.
//
// See issue #31 for the design rationale.

import type { Hono } from 'hono';
import { SiweMessage } from 'siwe';
import type { Sql } from '../db.js';
import { MAX_TOKEN_TTL_MS, verifySiweMessage } from '../siwe-token.js';
import { issueCallerToken } from './caller-token.js';

export interface SiweExchangeOptions {
  sql: Sql;
  domain?: string;
}

interface ExchangeBody {
  message?: unknown;
  signature?: unknown;
}

export function mountSiweExchange(app: Hono, opts: SiweExchangeOptions): void {
  app.post('/auth/siwe/exchange', async (c) => {
    let body: ExchangeBody;
    try {
      body = (await c.req.json()) as ExchangeBody;
    } catch {
      return c.json({ error: 'invalid_request', error_description: 'Body must be JSON' }, 400);
    }

    const message = typeof body.message === 'string' ? body.message : undefined;
    const signature = typeof body.signature === 'string' ? body.signature : undefined;
    if (!message || !signature) {
      return c.json(
        { error: 'invalid_request', error_description: 'message and signature are required' },
        400,
      );
    }

    let walletAddress: string;
    let expiresAtMs: number;
    let nonce: string;
    try {
      walletAddress = await verifySiweMessage(message, signature, { domain: opts.domain });
      // Re-parse only to read expirationTime + nonce; verifySiweMessage
      // already validated expirationTime exists and is a valid date, and
      // siwe itself enforces a well-formed nonce on construction.
      const parsed = new SiweMessage(message);
      expiresAtMs = new Date(parsed.expirationTime!).getTime();
      nonce = parsed.nonce;
    } catch (err) {
      return c.json(
        { error: 'invalid_grant', error_description: (err as Error).message },
        401,
      );
    }

    // Clamp against the SIWE max TTL as a defense-in-depth measure alongside
    // verifySiweMessage's issuedAt check. Without clamping, a SIWE verified
    // with a relaxed skew could still mint a caller token whose absolute
    // lifetime (relative to now) exceeds MAX_TOKEN_TTL_MS.
    const ttlMs = Math.min(MAX_TOKEN_TTL_MS, Math.max(0, expiresAtMs - Date.now()));
    if (ttlMs <= 0) {
      return c.json(
        { error: 'invalid_grant', error_description: 'SIWE message has already expired' },
        401,
      );
    }

    const principalId = `eth:${walletAddress.toLowerCase()}`;

    // Single-use nonce enforcement. Without this, an attacker who intercepted
    // a valid SIWE (message, signature) could mint fresh vbc_caller_* tokens
    // until the SIWE expirationTime, defeating per-token revocation. The
    // primary key is (principal_id, nonce) — a bogus signature producing a
    // different recovered address only burns its own nonce row, so a valid
    // signer's nonce cannot be pre-burned by an attacker.
    const nonceInsert = await opts.sql`
      INSERT INTO used_siwe_nonces (principal_id, nonce, expires_at)
      VALUES (${principalId}, ${nonce}, ${new Date(expiresAtMs)})
      ON CONFLICT DO NOTHING
      RETURNING principal_id
    `;
    if (nonceInsert.length === 0) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'SIWE nonce already used — sign a fresh message',
        },
        401,
      );
    }

    const issued = await issueCallerToken(opts.sql, {
      principalId,
      provider: 'siwe',
      ttlMs,
    });

    const expiresInSec = Math.max(
      0,
      Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000),
    );
    return c.json({
      access_token: issued.rawToken,
      token_type: 'Bearer',
      expires_in: expiresInSec,
    });
  });
}
