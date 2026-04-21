import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import postgres from 'postgres';
import { generateUserCode, mountDeviceFlow } from './device-flow.js';
import { CALLER_TOKEN_PREFIX } from './caller-token.js';

// ---------- Pure unit tests (always run) ----------

test('generateUserCode has the shape XXXX-XXXX', () => {
  const code = generateUserCode();
  assert.equal(code.length, 9);
  assert.equal(code[4], '-');
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

test('generateUserCode only uses Crockford Base32 alphabet', () => {
  const allowed = new Set('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  for (let i = 0; i < 50; i++) {
    const code = generateUserCode();
    for (const ch of code.replace('-', '')) {
      assert.ok(allowed.has(ch), `unexpected char ${ch} in ${code}`);
    }
  }
});

test('generateUserCode produces distinct codes (10 unique in 10 tries)', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 10; i++) codes.add(generateUserCode());
  assert.equal(codes.size, 10);
});

// ---------- DB-gated integration tests ----------

const hasDb = !!process.env.DATABASE_URL;

function buildApp(sql: postgres.Sql) {
  const app = new Hono();
  mountDeviceFlow(app, {
    sql,
    publicUrl: 'https://example.test',
    // Drop slow_down window so sequential polls in tests don't trigger it.
    minPollIntervalMs: 0,
  });
  return app;
}

test(
  'POST /oauth/device/code returns expected shape and inserts DB row',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const res = await app.request('/oauth/device/code', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;

      assert.equal(typeof body.device_code, 'string');
      assert.equal((body.device_code as string).length, 43);
      assert.equal(typeof body.user_code, 'string');
      assert.match(body.user_code as string, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal(body.verification_uri, 'https://example.test/oauth/device');
      assert.equal(
        body.verification_uri_complete,
        `https://example.test/oauth/device?user_code=${encodeURIComponent(body.user_code as string)}`,
      );
      assert.equal(typeof body.expires_in, 'number');
      assert.equal(body.interval, 5);

      const rows = await sql<
        { device_code: string; user_code: string; status: string }[]
      >`SELECT device_code, user_code, status FROM device_sessions WHERE device_code = ${body.device_code as string}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'pending');
      assert.equal(rows[0]!.user_code, body.user_code);

      await sql`DELETE FROM device_sessions WHERE device_code = ${body.device_code as string}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'POST /oauth/token without device_code returns invalid_request',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const res = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
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
  'POST /oauth/token with wrong grant_type returns unsupported_grant_type',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        device_code: 'whatever',
      });
      const res = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'unsupported_grant_type');
    } finally {
      await sql.end();
    }
  },
);

test(
  'POST /oauth/token on pending session returns authorization_pending',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);

      const issueRes = await app.request('/oauth/device/code', { method: 'POST' });
      const issued = (await issueRes.json()) as { device_code: string };

      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: issued.device_code,
      });
      const res = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'authorization_pending');

      await sql`DELETE FROM device_sessions WHERE device_code = ${issued.device_code}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'POST /oauth/token on approved session returns access_token and deletes row',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const app = buildApp(sql);

      const issueRes = await app.request('/oauth/device/code', { method: 'POST' });
      const issued = (await issueRes.json()) as { device_code: string };

      const principalId = `google:device-${Date.now()}`;
      const email = 'device-flow@example.com';
      await sql`
        UPDATE device_sessions
        SET status = 'approved',
            principal_id = ${principalId},
            email = ${email},
            approved_at = now()
        WHERE device_code = ${issued.device_code}
      `;

      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: issued.device_code,
      });
      const res = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(typeof body.access_token, 'string');
      assert.ok((body.access_token as string).startsWith(CALLER_TOKEN_PREFIX));
      assert.equal(body.token_type, 'Bearer');
      assert.equal(typeof body.expires_in, 'number');
      assert.ok((body.expires_in as number) > 0);

      const remaining = await sql`
        SELECT 1 FROM device_sessions WHERE device_code = ${issued.device_code}
      `;
      assert.equal(remaining.length, 0);

      // Cleanup the caller row we just issued.
      await sql`DELETE FROM callers WHERE principal_id = ${principalId}`;
    } finally {
      await sql.end();
    }
  },
);
