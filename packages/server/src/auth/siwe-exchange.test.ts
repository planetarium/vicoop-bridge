import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import postgres from 'postgres';
import { SiweMessage } from 'siwe';
import { Wallet } from 'ethers';
import { mountSiweExchange } from './siwe-exchange.js';
import { CALLER_TOKEN_PREFIX, verifyCallerToken } from './caller-token.js';

const TEST_DOMAIN = 'example.test';

interface SignedSiwe {
  message: string;
  signature: string;
  address: string;
}

async function buildSignedSiwe(opts?: {
  domain?: string;
  expirationSecondsFromNow?: number;
}): Promise<SignedSiwe> {
  const wallet = Wallet.createRandom();
  const expSecs = opts?.expirationSecondsFromNow ?? 300;
  const siwe = new SiweMessage({
    domain: opts?.domain ?? TEST_DOMAIN,
    address: wallet.address,
    statement: 'Test.',
    uri: `https://${opts?.domain ?? TEST_DOMAIN}`,
    version: '1',
    chainId: 1,
    nonce: 'abcdef1234567890abcdef1234567890',
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + expSecs * 1000).toISOString(),
  });
  const message = siwe.prepareMessage();
  const signature = await wallet.signMessage(message);
  return { message, signature, address: wallet.address };
}

function buildApp(sql: postgres.Sql): Hono {
  const app = new Hono();
  mountSiweExchange(app, { sql, domain: TEST_DOMAIN });
  return app;
}

const hasDb = !!process.env.DATABASE_URL;

test(
  'happy path: valid SIWE returns opaque caller token bound to eth:<addr>',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const { message, signature, address } = await buildSignedSiwe();

      const res = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;

      assert.equal(typeof body.access_token, 'string');
      assert.ok((body.access_token as string).startsWith(CALLER_TOKEN_PREFIX));
      assert.equal(body.token_type, 'Bearer');
      assert.equal(typeof body.expires_in, 'number');
      assert.ok((body.expires_in as number) > 0);

      const caller = await verifyCallerToken(sql, body.access_token as string);
      assert.equal(caller.principalId, `eth:${address.toLowerCase()}`);

      const rows = await sql<
        { provider: string; principal_id: string }[]
      >`SELECT provider, principal_id FROM callers WHERE principal_id = ${`eth:${address.toLowerCase()}`}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.provider, 'siwe');

      await sql`DELETE FROM callers WHERE principal_id = ${`eth:${address.toLowerCase()}`}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'expired SIWE is rejected with 401',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      // SIWE with expirationTime already in the past.
      const wallet = Wallet.createRandom();
      const past = new Date(Date.now() - 60_000).toISOString();
      const issued = new Date(Date.now() - 120_000).toISOString();
      const siwe = new SiweMessage({
        domain: TEST_DOMAIN,
        address: wallet.address,
        statement: 'Test.',
        uri: `https://${TEST_DOMAIN}`,
        version: '1',
        chainId: 1,
        nonce: 'abcdef1234567890abcdef1234567890',
        issuedAt: issued,
        expirationTime: past,
      });
      const message = siwe.prepareMessage();
      const signature = await wallet.signMessage(message);

      const res = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'invalid_grant');
    } finally {
      await sql.end();
    }
  },
);

test(
  'domain mismatch is rejected with 401',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const { message, signature } = await buildSignedSiwe({ domain: 'malicious.example' });

      const res = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'invalid_grant');
    } finally {
      await sql.end();
    }
  },
);

test(
  'missing message or signature returns 400 invalid_request',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const res = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'invalid_request');
    } finally {
      await sql.end();
    }
  },
);

test(
  'SIWE with issuedAt far in the future is rejected with 401',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      // Craft a SIWE where expirationTime - issuedAt stays under the 7-day cap
      // (so the per-message TTL check passes) but issuedAt is far in the future,
      // which would otherwise let the caller token's absolute lifetime exceed
      // the 7-day max. verifySiweMessage's issuedAt-vs-now check must reject it.
      const wallet = Wallet.createRandom();
      const issued = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const expires = new Date(Date.now() + (365 + 3) * 24 * 60 * 60 * 1000).toISOString();
      const siwe = new SiweMessage({
        domain: TEST_DOMAIN,
        address: wallet.address,
        statement: 'Future.',
        uri: `https://${TEST_DOMAIN}`,
        version: '1',
        chainId: 1,
        nonce: 'futurefuture0123456789abcdef',
        issuedAt: issued,
        expirationTime: expires,
      });
      const message = siwe.prepareMessage();
      const signature = await wallet.signMessage(message);

      const res = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'invalid_grant');
      assert.match(String(body.error_description), /issuedAt is in the future/);

      const rows = await sql`SELECT count(*)::int AS n FROM callers WHERE principal_id = ${`eth:${wallet.address.toLowerCase()}`}`;
      assert.equal((rows[0] as { n: number }).n, 0);
    } finally {
      await sql.end();
    }
  },
);

test(
  'replaying the same SIWE is rejected on the second exchange',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const { message, signature, address } = await buildSignedSiwe();
      const principalId = `eth:${address.toLowerCase()}`;

      const resA = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      assert.equal(resA.status, 200);
      const bodyA = (await resA.json()) as { access_token: string };

      // Second attempt with the same (message, signature) must be rejected:
      // the nonce has been consumed. Without this guard, an attacker who
      // intercepted the SIWE could mint fresh tokens after the first one
      // was revoked, defeating per-token revocation.
      const resB = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      assert.equal(resB.status, 401);
      const bodyB = (await resB.json()) as Record<string, unknown>;
      assert.equal(bodyB.error, 'invalid_grant');
      assert.match(String(bodyB.error_description), /nonce/i);

      // The first token must still be valid — replay protection doesn't
      // invalidate legitimately issued tokens.
      const caller = await verifyCallerToken(sql, bodyA.access_token);
      assert.equal(caller.principalId, principalId);

      const callerRows = await sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM callers WHERE principal_id = ${principalId}`;
      assert.equal(callerRows[0]!.n, 1);

      await sql`DELETE FROM callers WHERE principal_id = ${principalId}`;
      await sql`DELETE FROM used_siwe_nonces WHERE principal_id = ${principalId}`;
    } finally {
      await sql.end();
    }
  },
);
