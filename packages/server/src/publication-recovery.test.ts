import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDb } from './db.js';
import { configuredPublicationAuthority } from './index.js';
import { createPublicationTestDb } from './publication-test-db.js';
import { quarantineRestoredPublicationKeys } from './registration-recovery.js';
import type { Registration } from './outbound-signature.js';

test('a restored authority stays closed through key loss, rollback and manual reconciliation', {
  skip: !process.env.DATABASE_URL,
}, async t => {
  const db = await createPublicationTestDb(t);
  const dir = mkdtempSync(join(tmpdir(), 'recovered-publication-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secret = randomBytes(32);
  const file = join(dir, 'wrapping.key');
  writeFileSync(file, secret, { mode: 0o600 });
  const shared = join(dir, 'shared.pem');
  writeFileSync(shared, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const origin = 'https://agents.example';
  assert.ok(await configuredPublicationAuthority(db, origin, { VICOOP_OUTBOUND_KEY_FILE: shared }));
  const config = { VICOOP_OUTBOUND_WRAPPING_KEY_FILE: file };
  const authority = (await configuredPublicationAuthority(db, origin, config))!;
  await assert.rejects(configuredPublicationAuthority(db, origin, { VICOOP_OUTBOUND_KEY_FILE: shared }), /Shared publication signing/);
  const register = async (id: string) => {
    const [reg] = await db<Registration[]>`INSERT INTO agents (id, owner_principal, name, token_hash)
      VALUES (${id}, 'google:test', ${id}, ${id}) RETURNING id, client_id, publication_revision::text`;
    return reg;
  };
  const approved = await register('approved');
  const blocked = await register('blocked');
  const unused = await register('unused');
  const digest = createHash('sha256').update('probe').digest('base64');
  const req = { target: 'https://recipient.invalid/check', digest };
  await authority.signRequest(req, approved, approved.id);
  await authority.signRequest(req, blocked, blocked.id);
  const before = await authority.keysFor(approved);
  // A stale snapshot can contain both a retired private key and a grant
  // revoked later. Neither may be served just because the restore succeeded.
  await assert.rejects(quarantineRestoredPublicationKeys(db), /Pause/);
  assert.equal(await configuredPublicationAuthority(db, origin, {}), undefined);
  await db`UPDATE bridge_private.publication_control SET paused=true WHERE singleton`;
  const fresh = randomBytes(32);
  await quarantineRestoredPublicationKeys(db, fresh);
  await assert.rejects(configuredPublicationAuthority(db, origin, config), /does not match/);
  writeFileSync(file, fresh);
  const recovered = (await configuredPublicationAuthority(db, origin, config))!;
  for (const reg of [approved, blocked, unused]) {
    assert.deepEqual(await recovered.keysFor(reg), []);
    await assert.rejects(async () => recovered.signRequest(req, reg, reg.id));
  }
  await db`DELETE FROM bridge_private.publication_keys WHERE client_id=${approved.client_id}
    AND publication_revision=${approved.publication_revision} AND envelope IS NULL`;
  await db`UPDATE bridge_private.publication_control SET paused=false WHERE singleton`;
  await recovered.signRequest(req, approved, approved.id);
  assert.notDeepEqual(await recovered.keysFor(approved), before);
  for (const reg of [blocked, unused]) {
    await assert.rejects(async () => recovered.signRequest(req, reg, reg.id), /revoked/);
    assert.deepEqual(await recovered.keysFor(reg), []);
  }
});

test('release probe pins the approved subject and retired key, tests signing only on the local socket', async () => {
  const { checkPublication } = await import(new URL('../../../examples/outbound/check-publication.mjs', import.meta.url).href);
  const { signDirect } = await import(new URL('../../../examples/outbound/sign-direct.mjs', import.meta.url).href);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { crv, kty, x } = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
  const address = 'acct:current@agents.example';
  const subject = 'https://agents.example/publication-identities/current/epoch';
  const keys = [{ crv, kty, x, kid }];
  const jrd = { subject: address, links: [{ rel: 'https://mentionable.dev/ns/rel/publication-identity', href: subject }] };
  const read = (url: string) => url === subject ? { keys } : jrd;
  const opts = { address, subject };
  assert.equal(await checkPublication(opts, read), kid);
  await assert.rejects(checkPublication({ ...opts, 'deny-kid': [kid] }, read), /Retired/);
  await assert.rejects(checkPublication({ ...opts, subject: subject + 'other' }, read), /no longer matches/);
  await assert.rejects(checkPublication({ ...opts, absent: true }, read), /still advertised/);
  await checkPublication({ ...opts, absent: true }, (url: string) => url === subject ? null : { subject: address, links: [] });
  const signature = () => signDirect({ id: subject, endpoint: 'https://publication-check.invalid/probe',
    body: Buffer.from('{"check":"publication-signing"}'), privateKey });
  assert.equal(await checkPublication({ ...opts, socket: '/test/socket' }, read, signature), kid);
});

test('a separate runtime DB role can sign with column grants but cannot release tombstones or change the pause', {
  skip: !process.env.DATABASE_URL,
}, async t => {
  const admin = await createPublicationTestDb(t);
  await admin`GRANT USAGE ON SCHEMA bridge_private TO app_postgraphile`;
  await admin`GRANT SELECT, INSERT (client_id, publication_revision, envelope, public_x, public_mac),
    UPDATE (public_mac) ON bridge_private.publication_keys TO app_postgraphile`;
  await admin`GRANT SELECT, INSERT (singleton, wrapping_tag), UPDATE (singleton)
    ON bridge_private.publication_control TO app_postgraphile`;
  const [database] = await admin`SELECT current_database() AS name`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/' + database.name;
  url.searchParams.set('options', '-c role=app_postgraphile');
  const runtime = createDb(url.href);
  const dir = mkdtempSync(join(tmpdir(), 'publication-runtime-role-'));
  try {
    const [{ role }] = await runtime`SELECT current_user AS role`;
    assert.equal(role, 'app_postgraphile');
    const file = join(dir, 'wrapping.key');
    writeFileSync(file, randomBytes(32), { mode: 0o600 });
    const [reg] = await admin<Registration[]>`INSERT INTO agents (id, owner_principal, name, token_hash)
      VALUES ('runtime', 'google:test', 'runtime', 'token') RETURNING id, client_id, publication_revision::text`;
    const authority = (await configuredPublicationAuthority(runtime, 'https://agents.example', {
      VICOOP_OUTBOUND_WRAPPING_KEY_FILE: file,
    }))!;
    const req = { target: 'https://recipient.invalid/check', digest: createHash('sha256').update('probe').digest('base64') };
    await authority.signRequest(req, reg, 'token');
    await authority.signRequest(req, reg, 'token'); // exercise both INSERT and SELECT FOR UPDATE
    assert.equal((await authority.keysFor(reg)).length, 1);
    await assert.rejects(runtime`UPDATE bridge_private.publication_control SET paused=false`, /permission denied/);
    await assert.rejects(runtime`DELETE FROM bridge_private.publication_keys`, /permission denied/);
    await assert.rejects(runtime`UPDATE bridge_private.publication_keys SET envelope=NULL`, /permission denied/);
    await assert.rejects(runtime`UPDATE bridge_private.publication_keys SET client_id=client_id`, /permission denied/);
    // Revoke via the runbook's locked upsert and require stable denial.
    const result = await admin`INSERT INTO bridge_private.publication_keys (client_id, publication_revision)
      SELECT a.client_id, a.publication_revision FROM agents a WHERE a.client_id = ${reg.client_id}
        AND a.publication_revision = ${reg.publication_revision} AND a.id = ${reg.id}
      FOR NO KEY UPDATE ON CONFLICT (client_id, publication_revision) DO UPDATE
      SET envelope=NULL, public_x=NULL, public_mac=NULL`;
    assert.equal(result.count, 1);
    await assert.rejects(async () => authority.signRequest(req, reg, 'token'), /revoked/);
    const [grants] = await admin`SELECT
      has_schema_privilege('app_authenticated', 'bridge_private', 'USAGE') AS authenticated,
      has_schema_privilege('app_anonymous', 'bridge_private', 'USAGE') AS anonymous`;
    assert.deepEqual(grants, { authenticated: false, anonymous: false });
  } finally {
    await runtime.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
