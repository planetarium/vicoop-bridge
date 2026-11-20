import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from './db.js';
import { createHttpApp } from './http.js';
import { Registry } from './registry.js';
import { loadOutboundSigner, type Registration } from './outbound-signature.js';
import { loadRegistrationSigner } from './registration-signing.js';

test('registration keys survive restart and isolate rotation, revocation and transfer', { skip: !process.env.DATABASE_URL }, async t => {
  const db = createDb(process.env.DATABASE_URL!);
  const suffix = randomUUID();
  const origin = 'https://agents.example';
  const dir = mkdtempSync(join(tmpdir(), 'publication-keys-'));
  const path = join(dir, 'wrapping.key');
  writeFileSync(path, randomBytes(32), { mode: 0o600 });
  t.after(async () => {
    try { await db`DELETE FROM agents WHERE token_hash IN (${'a-' + suffix}, ${'b-' + suffix})`; }
    finally { await db.end(); rmSync(dir, { recursive: true, force: true }); }
  });
  async function register(prefix: string) {
    const id = prefix + '-' + suffix;
    const [reg] = await db<Registration[]>`INSERT INTO agents (id, owner_principal, name, token_hash)
      VALUES (${id}, 'google:test', ${id}, ${id}) RETURNING id, client_id, owner_revision::text`;
    return reg!;
  }
  const a = await register('a');
  const b = await register('b');
  const authority = loadRegistrationSigner(db, path, origin);
  const app = createHttpApp({ db, publicUrl: origin, registry: new Registry(), publicationAuthority: authority });
  const legacyPath = join(dir, 'legacy.pem');
  writeFileSync(legacyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const legacy = loadOutboundSigner(legacyPath, origin);
  const subject = legacy.identity(a)!;
  assert.deepEqual(authority.identity(a), subject);
  const body = Buffer.from('daily report');
  const endpoint = 'https://receiver.example/api/publications';
  const request = { target: endpoint, digest: createHash('sha256').update(body).digest('base64') };
  const [keysA, again, keysB, signed] = await Promise.all([
    authority.keysFor(a), authority.keysFor(a), authority.keysFor(b), authority.signRequest(request, a),
  ]);
  assert.deepEqual(keysA, again);
  assert.equal(keysA.length, 1);
  assert.equal(keysB.length, 1);
  assert.notEqual(keysA[0].kid, keysB[0].kid);
  const restart = loadRegistrationSigner(db, path, origin);
  assert.deepEqual(await restart.keysFor(a), keysA);
  const { verifyPublication } = await import(new URL('../../../examples/outbound/verify.mjs', import.meta.url).href);
  const msg = { method: 'POST', url: endpoint, body, headers: new Headers(signed) };
  const loadJson = async (url: string) => (await app.request(url)).json();
  const policy = { endpoint, grant: subject, allowedOrigins: new Set([origin]), loadJson, consumeNonce: () => true };
  assert.deepEqual(await verifyPublication(msg, policy), subject);
  await assert.rejects(verifyPublication({ ...msg, headers: new Headers(legacy.signRequest(request, a)) }, policy));
  await assert.rejects(verifyPublication(msg, { ...policy, loadJson: (url: string) =>
    url === subject.id ? { keys: keysB } : loadJson(url) }));
  await db`DELETE FROM bridge_private.publication_keys WHERE client_id = ${a.client_id}`;
  const rotated = await authority.keysFor(a);
  assert.notEqual(rotated[0].kid, keysA[0].kid);
  await assert.rejects(verifyPublication(msg, policy));
  await db`UPDATE bridge_private.publication_keys SET envelope = NULL WHERE client_id = ${a.client_id}`;
  assert.deepEqual(await authority.keysFor(a), []);
  await assert.rejects(async () => authority.signRequest(request, a));
  assert.equal((await app.request(subject.id)).status, 404);
  const [successor] = await db<Registration[]>`UPDATE agents SET owner_principal = 'google:successor' WHERE id = ${a.id}
    RETURNING id, client_id, owner_revision::text`;
  assert.notEqual(authority.identity(successor!)!.id, subject.id);
  assert.notEqual((await authority.keysFor(successor!))[0].kid, rotated[0].kid);
  assert.deepEqual(await authority.keysFor(a), []);
  await db`DELETE FROM agents WHERE id = ${a.id}`;
  const replacement = await register('a');
  assert.notEqual(replacement.client_id, a.client_id);
  assert.notDeepEqual(authority.identity(replacement), subject);
  assert.notEqual((await authority.keysFor(replacement))[0].kid, keysA[0].kid);
  assert.deepEqual(await authority.keysFor(b), keysB);
});
