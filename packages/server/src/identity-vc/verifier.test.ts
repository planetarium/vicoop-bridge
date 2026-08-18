import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DidDocumentResolver,
  IdentityReplayStore,
  ResolvedDidDocument,
} from './types.js';
import { createIdentityVcFixture } from './test-fixtures.js';
import { PlatformIdentityVerifier } from './verifier.js';

class MemoryReplayStore implements IdentityReplayStore {
  readonly keys = new Set<string>();
  async consume(input: {
    issuer: string;
    domain: string;
    challenge: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const key = JSON.stringify([input.issuer, input.domain, input.challenge]);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

function resolverFor(doc: ResolvedDidDocument, onResolve?: (refresh: boolean) => void): DidDocumentResolver {
  return {
    async resolve(_issuer, options) {
      onResolve?.(options?.refresh === true);
      return doc;
    },
  };
}

const binding = { expectedDomain: '@agent@bridge.example', messageId: 'message-1' };
const now = () => new Date('2026-08-18T14:00:00.000Z');

test('valid credential becomes a minimal allowlisted presented identity', async () => {
  const { credential, didDocument } = await createIdentityVcFixture();
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: resolverFor(didDocument),
    replayStore: new MemoryReplayStore(),
    now,
  });
  const result = await verifier.verify(credential, binding);
  assert.deepEqual(result, {
    ok: true,
    identity: {
      credentialId: credential.id,
      issuer: credential.issuer,
      subject: 'slack:T123/U456',
      method: 'urn:mentionable:auth:slack-workspace-member:v0.1',
      assurance: 'platform',
      platform: { provider: 'slack', workspaceId: 'T123' },
      observedInvocation: { target: '@agent@bridge.example' },
      profile: { displayName: 'Alice', username: 'alice' },
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('proofValue'), false);
  assert.equal(serialized.includes('channelId'), false);
  assert.equal(serialized.includes('threadId'), false);
  assert.equal(serialized.includes('avatar'), false);
  assert.equal(serialized.includes('source'), false);
});

test('exact receiver trust is checked before any resolution', async () => {
  const { credential } = await createIdentityVcFixture();
  let resolutions = 0;
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: ['did:web:other.example'],
    resolver: { async resolve() { resolutions += 1; throw new Error('must not run'); } },
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.deepEqual(await verifier.verify(credential, binding), {
    ok: false,
    rejection: { code: 'untrusted_issuer' },
  });
  assert.equal(resolutions, 0);
});

test('trusted non-did:web issuer is rejected without a fetch', async () => {
  const { credential } = await createIdentityVcFixture();
  const altered = structuredClone(credential);
  altered.issuer = 'https://issuer.example';
  let resolutions = 0;
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [altered.issuer],
    resolver: { async resolve() { resolutions += 1; throw new Error('must not run'); } },
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.deepEqual(await verifier.verify(altered, binding), {
    ok: false,
    rejection: { code: 'unsupported_issuer_method' },
  });
  assert.equal(resolutions, 0);
});

test('domain and outer messageId are exact pre-fetch bindings', async () => {
  const { credential } = await createIdentityVcFixture();
  let resolutions = 0;
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: { async resolve() { resolutions += 1; throw new Error('must not run'); } },
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.equal((await verifier.verify(credential, { ...binding, expectedDomain: '@other@bridge.example' })).ok, false);
  assert.deepEqual(await verifier.verify(credential, { ...binding, messageId: 'json-rpc-id' }), {
    ok: false,
    rejection: { code: 'challenge_mismatch' },
  });
  assert.equal(resolutions, 0);
});

test('time window and TTL policy reject before resolution', async () => {
  for (const [validFrom, validUntil, code] of [
    ['2026-08-18T14:01:00.000Z', '2026-08-18T14:05:00.000Z', 'not_yet_valid'],
    ['2026-08-18T13:50:00.000Z', '2026-08-18T13:59:00.000Z', 'expired'],
    ['2026-08-18T13:00:00.000Z', '2026-08-18T14:01:00.000Z', 'limit_exceeded'],
  ] as const) {
    const { credential } = await createIdentityVcFixture({ validFrom, validUntil });
    const verifier = new PlatformIdentityVerifier({
      trustedIssuers: [credential.issuer],
      resolver: { async resolve() { throw new Error('must not run'); } },
      replayStore: new MemoryReplayStore(),
      limits: { clockSkewMs: 0 },
      now,
    });
    assert.deepEqual(await verifier.verify(credential, binding), {
      ok: false,
      rejection: { code },
    });
  }
});

test('non-dateTimeStamp and impossible calendar values are malformed', async () => {
  for (const validFrom of ['August 18, 2026', '2026-02-30T13:55:00Z', '2026-08-18 13:55:00Z']) {
    const { credential } = await createIdentityVcFixture({ validFrom });
    const verifier = new PlatformIdentityVerifier({
      trustedIssuers: [credential.issuer],
      resolver: { async resolve() { throw new Error('must not run'); } },
      replayStore: new MemoryReplayStore(),
      now,
    });
    assert.deepEqual(await verifier.verify(credential, binding), {
      ok: false,
      rejection: { code: 'malformed' },
    });
  }
});

test('known presentation fields with invalid shapes are not silently normalized', async () => {
  const { credential } = await createIdentityVcFixture();
  credential.credentialSubject.platform = { provider: ['slack'] };
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: { async resolve() { throw new Error('must not run'); } },
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.deepEqual(await verifier.verify(credential, binding), {
    ok: false,
    rejection: { code: 'malformed' },
  });
});

test('modified payload fails signature verification', async () => {
  const { credential, didDocument } = await createIdentityVcFixture();
  credential.credentialSubject.id = 'slack:T123/ATTACKER';
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: resolverFor(didDocument),
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.deepEqual(await verifier.verify(credential, binding), {
    ok: false,
    rejection: { code: 'invalid_signature' },
  });
});

test('controller and assertionMethod linkage are required, with one rotation refresh', async () => {
  const { credential, didDocument } = await createIdentityVcFixture();
  const bad = structuredClone(didDocument);
  bad.verificationMethod = (bad.verificationMethod ?? []).map((entry) => ({
    ...(entry as Record<string, unknown>),
    controller: 'did:web:other.example',
  }));
  let calls = 0;
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: resolverFor(bad, () => { calls += 1; }),
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.deepEqual(await verifier.verify(credential, binding), {
    ok: false,
    rejection: { code: 'issuer_controller_mismatch' },
  });
  assert.equal(calls, 1, 'known but unauthorized key does not trigger rotation refresh');

  calls = 0;
  const missing = { ...didDocument, verificationMethod: [], assertionMethod: [] };
  const refreshVerifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: resolverFor(missing, () => { calls += 1; }),
    replayStore: new MemoryReplayStore(),
    now,
  });
  assert.equal((await refreshVerifier.verify(credential, binding)).ok, false);
  assert.equal(calls, 2, 'unknown key triggers exactly one refresh');
});

test('concurrent replay accepts exactly one proof', async () => {
  const { credential, didDocument } = await createIdentityVcFixture();
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: resolverFor(didDocument),
    replayStore: new MemoryReplayStore(),
    now,
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => verifier.verify(credential, binding)));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) => !result.ok && result.rejection.code === 'replayed').length,
    7,
  );
});

test('replay storage failure rejects the identity without throwing', async () => {
  const { credential, didDocument } = await createIdentityVcFixture();
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [credential.issuer],
    resolver: resolverFor(didDocument),
    replayStore: { async consume() { throw new Error('database unavailable'); } },
    now,
  });
  assert.deepEqual(await verifier.verify(credential, binding), {
    ok: false,
    rejection: { code: 'replay_store_failed' },
  });
});
