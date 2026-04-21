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
import { verifySiweToken, encodeSiweToken } from '../siwe-token.js';
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
    try {
      // verifySiweToken expects the base64url-packed form used as a bearer
      // today. Encode here so we share exactly one verification path (sig,
      // domain, TTL cap, exp/iat sanity) with the existing agent-auth flow.
      const packed = encodeSiweToken(message, signature);
      walletAddress = await verifySiweToken(packed, { domain: opts.domain });
      // Parse again only to read expirationTime for TTL — verifySiweToken
      // already validated it exists and is a valid date.
      const parsed = new SiweMessage(message);
      expiresAtMs = new Date(parsed.expirationTime!).getTime();
    } catch (err) {
      return c.json(
        { error: 'invalid_grant', error_description: (err as Error).message },
        401,
      );
    }

    const ttlMs = Math.max(0, expiresAtMs - Date.now());
    if (ttlMs <= 0) {
      return c.json(
        { error: 'invalid_grant', error_description: 'SIWE message has already expired' },
        401,
      );
    }

    const issued = await issueCallerToken(opts.sql, {
      principalId: `eth:${walletAddress.toLowerCase()}`,
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
