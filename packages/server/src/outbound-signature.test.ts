import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOutboundSigner } from './outbound-signature.js';
import { createHttpApp } from './http.js';
import { Registry } from './registry.js';
import type { Sql } from './db.js';

const verifier = new URL('../../../examples/outbound/verify.mjs', import.meta.url);
const origin = 'https://agents.example';

test('receiver resolves bridge authorization through WebFinger and the current registration', async t => {
  const { verifyPublication } = await import(verifier.href);
  const dir = mkdtempSync(join(tmpdir(), 'bridge-outbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function keypair(name: string) {
    const pair = generateKeyPairSync('ed25519');
    const path = join(dir, name);
    writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return { path, pem: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  const old = keypair('old');
  const next = keypair('next');
  const overlap = join(dir, 'public.json');
  writeFileSync(overlap, JSON.stringify([old.pem]));
  let authority = loadOutboundSigner(old.path, origin);
  const body = Buffer.from('{"messageId":"one","destination":"ops","replyTo":"parent"}');
  const request = { target: 'https://receiver.example/a2a', digest: createHash('sha256').update(body).digest('base64') };
  let registration = { id: 'agent-a', client_id: 'registration-1', publication_revision: '0' };
  const db = (async (_: unknown, local: string) => local === registration.id ? [registration] : []) as unknown as Sql;
  function app() {
    return createHttpApp({ registry: new Registry(), publicUrl: origin, publicationAuthority: authority, db });
  }
  let server = app();
  function signed() {
    return { method: 'POST', url: request.target, body, headers: new Headers(authority.signRequest(request, registration)) };
  }
  const seen = new Set<string>();
  const approved = authority.identity(registration)!;
  const policy = { grant: approved, endpoint: request.target, allowedOrigins: new Set([origin]), async loadJson(url: string) {
    const response = await server.request(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }, consumeNonce(id: string, nonce: string) {
    const key = JSON.stringify([id, nonce]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  } };
  const msg = signed();
  const check = (overrides = {}, config = {}) => verifyPublication({ ...msg, ...overrides }, { ...policy, ...config });
  await assert.rejects(check({}, { allowedOrigins: new Set() }));
  await assert.rejects(check({}, { endpoint: request.target + '/other' }));
  await assert.rejects(check({}, { now: Math.floor(Date.now() / 1000) + 70 }));
  await assert.rejects(check({ body: Buffer.from(body.toString().replace('parent', 'other')) }));
  for (const [field, value] of [
    ['signature-agent', 'sig1="' + origin + '/id/other"'],
    ['signature-agent', '"' + approved.id + '"'],
    ['signature-agent', 'sig2="' + approved.id + '"'],
    ['signature-agent', 'sig1="' + approved.id + '";extra=1'],
    ['signature-input', msg.headers.get('signature-input')!.replace('web-bot-auth', 'other')],
  ]) {
    const headers = new Headers(msg.headers);
    headers.set(field, value);
    await assert.rejects(check({ headers }));
  }
  const results = await Promise.allSettled([check(), check()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const grant = await verifyPublication(signed(), policy);
  assert.deepEqual(grant, authority.identity(registration));
  assert.ok(grant);

  const beforeRotation = signed();
  authority = loadOutboundSigner(next.path, origin, overlap);
  server = app();
  assert.deepEqual(await verifyPublication(beforeRotation, policy), grant);
  assert.deepEqual(await verifyPublication(signed(), policy), grant);
  authority = loadOutboundSigner(next.path, origin);
  server = app();
  await assert.rejects(verifyPublication(msg, { ...policy, consumeNonce: () => true }));
  for (const updated of [{ ...registration, publication_revision: '1' },
    { ...registration, client_id: 'replacement', publication_revision: '0' }]) {
    const previous = signed();
    registration = updated;
    await assert.rejects(verifyPublication(previous, policy));
    const successor = signed();
    await assert.rejects(verifyPublication(successor, policy));
    const reapproved = authority.identity(registration)!;
    assert.notDeepEqual(reapproved, grant);
    assert.deepEqual(await verifyPublication(successor, { ...policy, grant: reapproved }), reapproved);
    assert.equal((await server.request(grant.id)).status, 404);
  }
});

test('direct signer uses the same receiver, scoped to the discovered key for its agent ID', async () => {
  const { verifyPublication } = await import(verifier.href);
  const direct = new URL('../../../examples/outbound/sign-direct.mjs', import.meta.url);
  const { signDirect } = await import(direct.href);
  const data = JSON.parse(readFileSync(new URL('../../../examples/outbound/fixture.json', import.meta.url), 'utf8'));
  const pair = generateKeyPairSync('ed25519');
  const endpoint = data.audience;
  const subject = data.grant;
  const body = Buffer.from('{"messageId":"direct"}');
  const headers = signDirect({ ...subject, endpoint, body, privateKey: pair.privateKey });
  const msg = { method: 'POST', url: endpoint, body, headers };
  const policy = { grant: subject, endpoint, allowedOrigins: new Set([origin]), consumeNonce: () => true,
    loadJson: (url: string) => url === subject.id ? data.discovery.identity.document : data.discovery.webfinger.document };
  await assert.rejects(verifyPublication(msg, policy));
  data.discovery.identity.document.keys = [{ ...pair.publicKey.export({ format: 'jwk' }) }];
  assert.deepEqual(await verifyPublication(msg, policy), subject);
});

test('independent draft-01 publication vectors cover the labeled member and authorized JWK thumbprint', async () => {
  const { verifyPublication } = await import(verifier.href);
  const data = JSON.parse(readFileSync(new URL('../../../examples/outbound/fixture.json', import.meta.url), 'utf8'));
  const { webfinger, identity } = data.discovery;
  const records = new Map([[webfinger.url, webfinger.document], [identity.url, identity.document]]);
  const policy = { grant: data.grant, endpoint: data.audience, now: data.now, allowedOrigins: new Set([origin]),
    loadJson: (url: string) => records.get(url), consumeNonce: () => true };
  for (const { request, expected } of [...data.valid, ...data.invalid]) {
    const msg = { ...request, headers: new Headers(request.headers), body: Buffer.from(request.body) };
    const verified = verifyPublication(msg, policy);
    if (expected) assert.deepEqual(await verified, expected);
    else await assert.rejects(verified);
  }
});
