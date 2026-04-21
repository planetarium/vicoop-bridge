import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  CALLER_TOKEN_PREFIX,
  generateCallerToken,
  hashCallerToken,
  issueCallerToken,
  verifyCallerToken,
  revokeCallerToken,
  listCallerTokens,
} from './caller-token.js';

// ---------- Pure unit tests (always run) ----------

test('generateCallerToken has vbc_caller_ prefix', () => {
  const t = generateCallerToken();
  assert.ok(t.startsWith(CALLER_TOKEN_PREFIX));
});

test('generateCallerToken produces base64url (no +/= chars) with 32 bytes of entropy', () => {
  const t = generateCallerToken();
  const body = t.slice(CALLER_TOKEN_PREFIX.length);
  // 32 bytes -> 43 chars in unpadded base64url
  assert.equal(body.length, 43);
  assert.match(body, /^[A-Za-z0-9_-]+$/);
});

test('generateCallerToken produces distinct tokens', () => {
  const a = generateCallerToken();
  const b = generateCallerToken();
  assert.notEqual(a, b);
});

test('hashCallerToken is deterministic', () => {
  const t = 'vbc_caller_abc';
  assert.equal(hashCallerToken(t), hashCallerToken(t));
});

test('hashCallerToken returns 64-char sha256 hex', () => {
  const h = hashCallerToken('vbc_caller_abc');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]+$/);
});

test('different tokens produce different hashes', () => {
  assert.notEqual(hashCallerToken('a'), hashCallerToken('b'));
});

// ---------- DB-gated tests ----------

const hasDb = !!process.env.DATABASE_URL;

test('verifyCallerToken rejects bad prefix without hitting DB', async () => {
  // We pass a dummy sql stub that would throw if actually used.
  const sqlStub = (() => {
    throw new Error('should not touch DB');
  }) as unknown as Parameters<typeof verifyCallerToken>[0];
  await assert.rejects(
    () => verifyCallerToken(sqlStub, 'not-a-caller-token'),
    /Invalid caller token format/,
  );
});

test(
  'issue and verify roundtrip',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const issued = await issueCallerToken(sql, {
        principalId: `google:test-${Date.now()}`,
        provider: 'google',
        email: 'alice@example.com',
        label: 'test',
      });
      assert.ok(issued.rawToken.startsWith(CALLER_TOKEN_PREFIX));
      assert.ok(issued.callerId);
      assert.ok(issued.expiresAt instanceof Date);
      assert.ok(issued.expiresAt.getTime() > Date.now());

      const caller = await verifyCallerToken(sql, issued.rawToken);
      assert.match(caller.principalId, /^google:test-/);
      assert.equal(caller.email, 'alice@example.com');
      assert.equal(caller.emailVerified, true);

      // Cleanup
      await sql`DELETE FROM callers WHERE id = ${issued.callerId}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'verifyCallerToken throws on revoked token',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const issued = await issueCallerToken(sql, {
        principalId: `google:revoke-${Date.now()}`,
        provider: 'google',
        email: 'bob@example.com',
      });

      await revokeCallerToken(sql, issued.callerId);

      // Revocation is idempotent
      await revokeCallerToken(sql, issued.callerId);

      // The caller token shouldn't be cached (we never verified before
      // revoking), so this should hit the DB and see revoked=true.
      // Use a fresh token string variant to sidestep any prior cache.
      await assert.rejects(
        () => verifyCallerToken(sql, issued.rawToken),
        /Caller token revoked/,
      );

      await sql`DELETE FROM callers WHERE id = ${issued.callerId}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'verifyCallerToken throws on expired token',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      // Issue with a 1ms TTL so it's immediately in the past.
      const issued = await issueCallerToken(sql, {
        principalId: `google:expired-${Date.now()}`,
        provider: 'google',
        ttlMs: 1,
      });
      // Ensure clock moves past expiry.
      await new Promise((r) => setTimeout(r, 10));
      await assert.rejects(
        () => verifyCallerToken(sql, issued.rawToken),
        /Caller token expired/,
      );
      await sql`DELETE FROM callers WHERE id = ${issued.callerId}`;
    } finally {
      await sql.end();
    }
  },
);

test(
  'listCallerTokens filters by principalId and hides revoked by default',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const principalId = `google:list-${Date.now()}`;
      const a = await issueCallerToken(sql, { principalId, provider: 'google' });
      const b = await issueCallerToken(sql, { principalId, provider: 'google' });
      await revokeCallerToken(sql, b.callerId);

      const listed = await listCallerTokens(sql, { principalId });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.id, a.callerId);

      const listedAll = await listCallerTokens(sql, { principalId, includeRevoked: true });
      assert.equal(listedAll.length, 2);

      await sql`DELETE FROM callers WHERE id IN (${a.callerId}, ${b.callerId})`;
    } finally {
      await sql.end();
    }
  },
);
