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
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::127.0.0.1',
    '64:ff9b:1::a9fe:a9fe',
    '2001:0000:4136:e378:8000:63bf:5601:5601',
    '2001:2::1',
    '2001:10::1',
    '2002:a9fe:a9fe::',
    '3ffe::1',
    '3fff::1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
  ]) {
    assert.equal(isDisallowedIpAddress(address), true, address);
  }
  assert.equal(isDisallowedIpAddress('8.8.8.8'), false);
  assert.equal(isDisallowedIpAddress('2606:4700:4700::1111'), false);
  assert.equal(isDisallowedIpAddress('2001:1::1'), false, 'PCP anycast is globally reachable');
  assert.equal(isDisallowedIpAddress('2001:3::1'), false, 'AMT is globally reachable');
  assert.equal(isDisallowedIpAddress('2001:4:112::1'), false, 'AS112-v6 is globally reachable');
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
  let currentTime = 0;
  const resolver = new SafeDidWebResolver({
    now: () => currentTime,
    cacheTtlMs: 60_000,
    refreshCooldownMs: 5_000,
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
  await Promise.all(
    Array.from({ length: 20 }, () =>
      resolver.resolve('did:web:issuer.example', { refresh: true }),
    ),
  );
  assert.equal(requests, 2);
  await resolver.resolve('did:web:issuer.example', { refresh: true });
  assert.equal(requests, 2, 'sequential refreshes are bounded during the cooldown');
  currentTime += 5_001;
  await resolver.resolve('did:web:issuer.example', { refresh: true });
  assert.equal(requests, 3, 'rotation refresh resumes after the cooldown');
});

test('resolver deadline includes DNS resolution', async () => {
  const resolver = new SafeDidWebResolver({
    timeoutMs: 10,
    resolveAddresses: (() => new Promise(() => {})) as never,
  });
  await assert.rejects(
    () => resolver.resolve('did:web:issuer.example'),
    /resolution timed out/u,
  );
});

test('resolver rejects malformed DID relationship containers', async () => {
  for (const malformed of [
    { id: 'did:web:issuer.example', verificationMethod: {} },
    { id: 'did:web:issuer.example', assertionMethod: 'key-1' },
  ]) {
    const resolver = new SafeDidWebResolver({
      resolveAddresses: (async () => [{ address: '8.8.8.8', family: 4 }]) as never,
      requestDocument: async () => malformed,
    });
    await assert.rejects(
      () => resolver.resolve('did:web:issuer.example'),
      /relationships are malformed/u,
    );
  }
});

test('resolver bounds sequential failures and retries after a cooldown', async () => {
  let currentTime = 0;
  let resolutions = 0;
  let requests = 0;
  const resolver = new SafeDidWebResolver({
    now: () => currentTime,
    failureCooldownMs: 5_000,
    resolveAddresses: (async () => {
      resolutions += 1;
      return [{ address: '8.8.8.8', family: 4 }];
    }) as never,
    requestDocument: async () => {
      requests += 1;
      throw new Error('upstream unavailable');
    },
  });

  const issuer = 'did:web:issuer.example';
  const firstWave = await Promise.allSettled(
    Array.from({ length: 20 }, () => resolver.resolve(issuer)),
  );
  assert.equal(firstWave.every(({ status }) => status === 'rejected'), true);
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(() => resolver.resolve(issuer), /cooling down/u);
  }
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);

  currentTime += 5_001;
  await assert.rejects(() => resolver.resolve(issuer), /upstream unavailable/u);
  assert.equal(resolutions, 2);
  assert.equal(requests, 2);
});
