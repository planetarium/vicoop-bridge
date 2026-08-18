import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  PostgresIdentityReplayStore,
  identityReplayDigest,
  sweepExpiredIdentityReplays,
} from './replay-store.js';

test('tuple digest is unambiguous and fixed-size', () => {
  const a = identityReplayDigest('ab', 'c', 'd');
  const b = identityReplayDigest('a', 'bc', 'd');
  assert.equal(a.length, 32);
  assert.equal(a.equals(b), false);
});

test('Postgres replay consume is atomic across instances', { skip: !process.env.DATABASE_URL }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const challenge = `identity-vc-test-${Date.now()}-${Math.random()}`;
  const input = {
    issuer: 'did:web:issuer.example',
    domain: '@agent@bridge.example',
    challenge,
    expiresAt: new Date(Date.now() + 60_000),
  };
  try {
    const stores = Array.from({ length: 8 }, () => new PostgresIdentityReplayStore(sql));
    const results = await Promise.all(stores.map((store) => store.consume(input)));
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    const digest = identityReplayDigest(input.issuer, input.domain, input.challenge);
    await sql`DELETE FROM identity_vc_replays WHERE digest = ${digest}`;
    await sql.end();
  }
});

test('expired replay rows can be swept', { skip: !process.env.DATABASE_URL }, async () => {
  const sql = postgres(process.env.DATABASE_URL!);
  const challenge = `identity-vc-sweep-${Date.now()}-${Math.random()}`;
  const digest = identityReplayDigest('did:web:issuer.example', '@agent@bridge.example', challenge);
  try {
    await sql`
      INSERT INTO identity_vc_replays (digest, expires_at)
      VALUES (${digest}, ${new Date(Date.now() - 1_000)})
    `;
    assert.ok((await sweepExpiredIdentityReplays(sql)) >= 1);
    const rows = await sql`SELECT 1 FROM identity_vc_replays WHERE digest = ${digest}`;
    assert.equal(rows.length, 0);
  } finally {
    await sql`DELETE FROM identity_vc_replays WHERE digest = ${digest}`;
    await sql.end();
  }
});
