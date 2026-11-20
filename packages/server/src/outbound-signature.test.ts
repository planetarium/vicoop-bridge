import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOutboundSigner } from './outbound-signature.js';

test('v1 receiver verifies body, identity, audience, purpose, rotation and single-use nonce', async (t) => {
  const fixture = new URL('../../../examples/outbound/verify.mjs', import.meta.url);
  const { trustedKeys, verifyPublication } = await import(fixture.href);
  const dir = mkdtempSync(join(tmpdir(), 'bridge-outbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function keypair(name: string) {
    const pair = generateKeyPairSync('ed25519');
    const path = join(dir, name);
    writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return { sign: loadOutboundSigner(path), pub: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  const old = keypair('old');
  const active = keypair('active');
  const body = Buffer.from('{"messageId":"one","destination":"ops","replyTo":"parent"}');
  const request = { target: 'https://receiver.example/a2a', recipient: 'ops',
    digest: createHash('sha256').update(body).digest('base64') };
  const registration = { id: 'agent-a', client_id: 'registration-1', owner_revision: '0' };
  function signed(signer = old.sign) {
    return { method: 'POST', url: request.target, body, headers: new Headers(signer(request, registration)) };
  }
  const consumed = new Set<string>();
  const policy = { recipient: 'ops', keys: trustedKeys([old.pub, active.pub]), consumeNonce(n: string) {
    if (consumed.has(n)) return false;
    consumed.add(n);
    return true;
  } };
  const msg = signed();
  const check = (overrides = {}, config = {}) => verifyPublication({ ...msg, ...overrides }, { ...policy, ...config });
  await assert.rejects(check({}, { keys: trustedKeys([active.pub]) }));
  await assert.rejects(check({}, { recipient: 'other' }));
  await assert.rejects(check({}, { now: Math.floor(Date.now() / 1000) + 70 }));
  await assert.rejects(check({ url: request.target + '/other' }));
  for (const [before, after] of [['ops', 'elsewhere'], ['parent', 'other']]) {
    await assert.rejects(check({ body: Buffer.from(body.toString().replace(before, after)) }));
  }
  for (const [field, value] of [
    ['vicoop-sender', Buffer.from('["agent-b","registration-2","0"]').toString('base64url')],
    ['signature-input', msg.headers.get('signature-input')!.replace('publish-v1', 'another-v1')],
  ]) {
    const headers = new Headers(msg.headers);
    headers.set(field, value);
    await assert.rejects(check({ headers }));
  }
  const results = await Promise.allSettled([check(), check()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const result = await verifyPublication(signed(active.sign), policy);
  assert.deepEqual(result, { agentId: 'agent-a', clientId: 'registration-1', ownerRevision: '0' });
});
