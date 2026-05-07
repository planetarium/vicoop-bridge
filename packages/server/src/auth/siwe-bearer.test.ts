import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiweMessage } from 'siwe';
import { Wallet } from 'ethers';
import {
  decodeSiweBearerToken,
  verifySiweBearerToken,
  _resetSiweBearerCacheForTests,
} from './siwe-bearer.js';

// Anvil account #0 — well-known test key, never used for anything real.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS_LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266'.toLowerCase();

async function mintBearer(opts: {
  domain: string;
  uri: string;
  issuedAt?: Date;
  expirationTime?: Date;
}): Promise<string> {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const issuedAt = opts.issuedAt ?? new Date();
  const expirationTime = opts.expirationTime ?? new Date(Date.now() + 60 * 60 * 1000);
  const msg = new SiweMessage({
    domain: opts.domain,
    address: wallet.address,
    statement: 'siwe-bearer test',
    uri: opts.uri,
    version: '1',
    chainId: 1,
    nonce: crypto.randomUUID().replace(/-/g, ''),
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
  });
  const message = msg.prepareMessage();
  const signature = await wallet.signMessage(message);
  const json = JSON.stringify({ message, signature });
  return Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

test('decodeSiweBearerToken decodes a base64url JSON envelope', () => {
  const json = JSON.stringify({ message: 'hello', signature: '0xabc' });
  const token = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const decoded = decodeSiweBearerToken(token);
  assert.equal(decoded.message, 'hello');
  assert.equal(decoded.signature, '0xabc');
});

test('decodeSiweBearerToken rejects malformed envelopes', () => {
  assert.throws(() => decodeSiweBearerToken('!!!not base64!!!'));
  const noFields = Buffer.from('{}', 'utf-8').toString('base64url');
  assert.throws(() => decodeSiweBearerToken(noFields), /missing message or signature/);
});

test('verifySiweBearerToken recovers the signing address', async () => {
  _resetSiweBearerCacheForTests();
  const token = await mintBearer({ domain: 'bridge.example', uri: 'https://bridge.example' });
  const verified = await verifySiweBearerToken(token, { domain: 'bridge.example' });
  assert.equal(verified.address, TEST_ADDRESS_LOWER);
});

test('verifySiweBearerToken rejects domain mismatch', async () => {
  _resetSiweBearerCacheForTests();
  const token = await mintBearer({ domain: 'bridge.example', uri: 'https://bridge.example' });
  await assert.rejects(
    () => verifySiweBearerToken(token, { domain: 'attacker.example' }),
    /domain mismatch/i,
  );
});

test('verifySiweBearerToken rejects expired tokens', async () => {
  _resetSiweBearerCacheForTests();
  const past = new Date(Date.now() - 10 * 60 * 1000);
  const token = await mintBearer({
    domain: 'bridge.example',
    uri: 'https://bridge.example',
    issuedAt: new Date(past.getTime() - 60 * 1000),
    expirationTime: past,
  });
  await assert.rejects(() => verifySiweBearerToken(token, { domain: 'bridge.example' }));
});

test('verifySiweBearerToken caches verified results', async () => {
  _resetSiweBearerCacheForTests();
  const token = await mintBearer({ domain: 'bridge.example', uri: 'https://bridge.example' });
  const a = await verifySiweBearerToken(token, { domain: 'bridge.example' });
  const b = await verifySiweBearerToken(token, { domain: 'bridge.example' });
  assert.equal(a.address, b.address);
});
