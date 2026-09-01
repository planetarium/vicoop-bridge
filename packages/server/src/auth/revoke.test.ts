import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import postgres from 'postgres';
import { mountTokenRevocation } from './revoke.js';
import { hashCallerToken, issueSessionToken } from './caller-token.js';

const hasDb = !!process.env.DATABASE_URL;

function buildApp(sql: postgres.Sql) {
  const app = new Hono();
  mountTokenRevocation(app, { sql });
  return app;
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

test('POST /oauth/revoke dispatches vbc_fed tokens to the federation store', async () => {
  let statement = '';
  const sql = (async (strings: TemplateStringsArray) => {
    statement = strings.join('?');
    return [];
  }) as unknown as postgres.Sql;
  const app = buildApp(sql);
  const response = await app.request('/oauth/revoke', {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({ token: 'vbc_fed_test-token' }),
  });
  assert.equal(response.status, 200);
  assert.match(statement, /UPDATE infra\.oauth_federation_access_tokens/);
});

test(
  'POST /oauth/revoke without token returns invalid_request',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const res = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: '',
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
  'POST /oauth/revoke with valid owner_session token flips revoked=true',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const principalId = `google:revoke-${Date.now()}`;
      const issued = await issueSessionToken(sql, {
        principalId,
        provider: 'google',
        audience: 'owner_session',
      });

      const form = new URLSearchParams({ token: issued.rawToken });
      const res = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form.toString(),
      });
      assert.equal(res.status, 200);

      const rows = await sql<{ revoked: boolean }[]>`
        SELECT revoked FROM callers WHERE token_hash = ${hashCallerToken(issued.rawToken)}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.revoked, true);

      await sql`DELETE FROM callers WHERE principal_id = ${principalId}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'POST /oauth/revoke also revokes caller-audience tokens (independent of issuance path)',
  { skip: !hasDb },
  async () => {
    // Asserts the "revocation is independent of how the token was issued"
    // contract that motivated splitting this out of device-flow.ts. The
    // caller-audience token is issued the same way a SIWE-issued one would
    // be — just with the audience that the SIWE path defaults to.
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const principalId = `eth:0xrevoke-caller-${Date.now()}`;
      const issued = await issueSessionToken(sql, {
        principalId,
        provider: 'siwe',
        audience: 'caller',
      });

      const form = new URLSearchParams({ token: issued.rawToken });
      const res = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form.toString(),
      });
      assert.equal(res.status, 200);

      const rows = await sql<{ revoked: boolean }[]>`
        SELECT revoked FROM callers WHERE token_hash = ${hashCallerToken(issued.rawToken)}
      `;
      assert.equal(rows[0]!.revoked, true);

      await sql`DELETE FROM callers WHERE principal_id = ${principalId}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'POST /oauth/revoke with unknown/malformed token still returns 200 (RFC 7009)',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);

      // Looks plausible but doesn't exist in DB.
      const looksValid = new URLSearchParams({ token: 'vbc_owner_does_not_exist' });
      const r1 = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: looksValid.toString(),
      });
      assert.equal(r1.status, 200);

      // No recognised prefix — RFC 7009 still says 200 (no oracle).
      const malformed = new URLSearchParams({ token: 'not-a-bridge-token' });
      const r2 = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: malformed.toString(),
      });
      assert.equal(r2.status, 200);
    } finally {
      await sql.end();
    }
  },
);

test(
  'POST /oauth/revoke is idempotent: revoking twice still returns 200',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const principalId = `google:revoke-idem-${Date.now()}`;
      const issued = await issueSessionToken(sql, {
        principalId,
        provider: 'google',
        audience: 'owner_session',
      });

      const form = new URLSearchParams({ token: issued.rawToken });

      const r1 = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form.toString(),
      });
      assert.equal(r1.status, 200);
      const r2 = await app.request('/oauth/revoke', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form.toString(),
      });
      assert.equal(r2.status, 200);

      await sql`DELETE FROM callers WHERE principal_id = ${principalId}`;
    } finally {
      await sql.end();
    }
  },
);
