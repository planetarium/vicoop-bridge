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
  'exchanging twice for the same SIWE yields two distinct tokens tied to same principal',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const { message, signature, address } = await buildSignedSiwe();

      const resA = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      const bodyA = (await resA.json()) as { access_token: string };

      const resB = await app.request('/auth/siwe/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      const bodyB = (await resB.json()) as { access_token: string };

      assert.notEqual(bodyA.access_token, bodyB.access_token);

      const callerA = await verifyCallerToken(sql, bodyA.access_token);
      const callerB = await verifyCallerToken(sql, bodyB.access_token);
      assert.equal(callerA.principalId, `eth:${address.toLowerCase()}`);
      assert.equal(callerB.principalId, callerA.principalId);

      await sql`DELETE FROM callers WHERE principal_id = ${`eth:${address.toLowerCase()}`}`;
    } finally {
      await sql.end();
    }
  },
);
