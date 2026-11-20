import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistrationSigner } from './registration-signing.js';
import { rewrapPublications } from './rewrap-publications.js';
import type { Registration } from './outbound-signature.js';
import { randomBytes } from 'node:crypto';
import { createPublicationTestDb } from './publication-test-db.js';
import { initializePublicationControl, publicationEnabled } from './registration-signing-control.js';

test('only one KEK may initialize a database; restart preserves pause and rejects a different key', { skip: !process.env.DATABASE_URL }, async t => {
  const db = await createPublicationTestDb(t);
  const keys = [randomBytes(32), randomBytes(32)];
  const starts = await Promise.allSettled(keys.map(key => initializePublicationControl(db, key)));
  assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1);
  const winner = starts.findIndex(r => r.status === 'fulfilled');
  const right = keys[winner], wrong = keys[1 - winner];
  assert.equal(await publicationEnabled(db, right), true);
  await assert.rejects(initializePublicationControl(db, wrong), /does not match/);
  await db`UPDATE bridge_private.publication_control SET paused = TRUE`;
  await initializePublicationControl(db, right);
  assert.equal(await publicationEnabled(db, right), false);
  await assert.rejects(publicationEnabled(db, wrong), /does not match/);
});

test('offline rewrap preserves grants and tombstones, rolls back on error and fences stale processes', { skip: !process.env.DATABASE_URL }, async t => {
  const db = await createPublicationTestDb(t);
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const keyDir = mkdtempSync(join(tmpdir(), 'rewrap-test-'));
  t.after(() => rmSync(keyDir, { recursive: true, force: true }));
  const oldPath = join(keyDir, 'old'), newPath = join(keyDir, 'new');
  writeFileSync(oldPath, oldKey, { mode: 0o600 });
  writeFileSync(newPath, newKey, { mode: 0o600 });
  const origin = 'https://agents.example';
  const old = await loadRegistrationSigner(db, oldPath, origin);
  const [a, b, c] = await db<Registration[]>`
    INSERT INTO agents (id, client_id, owner_principal, name, token_hash)
    VALUES ('a','a','alpha','a','tok-a'), ('b','b','bravo','b','tok-b'), ('c','c','charlie','c','tok-c')
    RETURNING id, client_id, publication_revision::text`;
  for (const reg of [a,b,c]) await old.prepareRegistration!(reg, 'tok-' + reg.id);
  const before = await old.keysFor(a);
  assert.equal(before.length, 1);
  await db`UPDATE bridge_private.publication_keys SET envelope=NULL, public_x=NULL, public_mac=NULL WHERE client_id=${c.client_id}`;
  await assert.rejects(rewrapPublications(db, oldKey, newKey), /Pause/);
  await db`UPDATE bridge_private.publication_control SET paused=TRUE`;
  assert.deepEqual(await old.keysFor(a), []);
  const [{ public_mac: goodMac }] = await db`SELECT public_mac FROM bridge_private.publication_keys WHERE client_id=${b.client_id}`;
  await db`UPDATE bridge_private.publication_keys SET public_mac='invalid' WHERE client_id=${b.client_id}`;
  await assert.rejects(rewrapPublications(db, oldKey, newKey), /public key/);
  assert.equal(await publicationEnabled(db, oldKey), false);
  await db`UPDATE bridge_private.publication_keys SET public_mac=${goodMac} WHERE client_id=${b.client_id}`;
  assert.equal(await rewrapPublications(db, oldKey, newKey), 2);
  await assert.rejects(initializePublicationControl(db, oldKey), /does not match/);
  const fresh = await loadRegistrationSigner(db, newPath, origin);
  assert.deepEqual(await fresh.keysFor(a), []);
  await db`UPDATE bridge_private.publication_control SET paused=FALSE`;
  await assert.rejects(old.prepareRegistration!(a, 'tok-a'), /does not match/);
  assert.deepEqual(await fresh.keysFor(a), before);
  assert.deepEqual(await fresh.keysFor(c), []);
  await assert.rejects(fresh.prepareRegistration!(c, 'tok-c'), /revoked/);
});
