import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DidResolutionError,
  SafeDidWebResolver,
  didWebToHttpsUrl,
  isDisallowedIpAddress,
} from './did-web.js';

test('did:web conversion follows root and path forms', () => {
  assert.equal(
    didWebToHttpsUrl('did:web:issuer.example').href,
    'https://issuer.example/.well-known/did.json',
  );
  assert.equal(
    didWebToHttpsUrl('did:web:issuer.example:connectors:slack').href,
    'https://issuer.example/connectors/slack/did.json',
  );
  assert.equal(
    didWebToHttpsUrl('did:web:issuer.example%3A8443').href,
    'https://issuer.example:8443/.well-known/did.json',
  );
});

test('IP policy rejects private, loopback, link-local and documentation networks', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.2',
    '192.0.2.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
  ]) {
    assert.equal(isDisallowedIpAddress(address), true, address);
  }
  assert.equal(isDisallowedIpAddress('8.8.8.8'), false);
  assert.equal(isDisallowedIpAddress('2606:4700:4700::1111'), false);
});

test('resolver blocks unsafe DNS before issuing HTTPS', async () => {
  let requests = 0;
  const resolver = new SafeDidWebResolver({
    resolveAddresses: (async () => [{ address: '169.254.169.254', family: 4 }]) as never,
    requestDocument: async () => {
      requests += 1;
      return {};
    },
  });
  await assert.rejects(() => resolver.resolve('did:web:issuer.example'), DidResolutionError);
  assert.equal(requests, 0);
});

test('resolver single-flights and caches one safe request', async () => {
  let requests = 0;
  const resolver = new SafeDidWebResolver({
    resolveAddresses: (async () => [{ address: '8.8.8.8', family: 4 }]) as never,
    requestDocument: async (_url, _ip, signal) => {
      requests += 1;
      assert.equal(signal.aborted, false);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: 'did:web:issuer.example', assertionMethod: [] };
    },
  });
  const [a, b] = await Promise.all([
    resolver.resolve('did:web:issuer.example'),
    resolver.resolve('did:web:issuer.example'),
  ]);
  assert.equal(a, b);
  assert.equal(requests, 1);
  await resolver.resolve('did:web:issuer.example');
  assert.equal(requests, 1);
  await resolver.resolve('did:web:issuer.example', { refresh: true });
  assert.equal(requests, 2);
});
