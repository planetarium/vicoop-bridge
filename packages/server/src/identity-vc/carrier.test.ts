import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAndStripIdentityCarrier } from './carrier.js';

test('extracts v0.2 credentials and strips both raw identity carriers', () => {
  const raw = { id: 'secret-vc', proof: { proofValue: 'secret' } };
  const result = extractAndStripIdentityCarrier({
    keep: true,
    mentionable: {
      verifiable_credentials: [raw],
      identity_evidence: [{ legacy: 'secret' }],
      policy: { keep: true },
    },
  });
  assert.deepEqual(result.credentials, [raw]);
  assert.deepEqual(result.metadata, {
    keep: true,
    mentionable: { policy: { keep: true } },
  });
  assert.equal(JSON.stringify(result.metadata).includes('secret'), false);
});

test('fails closed on count and byte limits while still returning sanitized metadata', () => {
  const result = extractAndStripIdentityCarrier(
    { mentionable: { verifiable_credentials: [{ large: 'x'.repeat(20) }] } },
    { maxCarrierBytes: 1_000, maxCredentialBytes: 8, maxCredentials: 1 },
  );
  assert.deepEqual(result.credentials, []);
  assert.deepEqual(result.rejections, [{ code: 'limit_exceeded' }]);
  assert.equal(result.metadata, undefined);

  const tooMany = extractAndStripIdentityCarrier(
    { mentionable: { verifiable_credentials: [{}, {}] } },
    { maxCarrierBytes: 1_000, maxCredentialBytes: 1_000, maxCredentials: 1 },
  );
  assert.deepEqual(tooMany.credentials, []);
  assert.deepEqual(tooMany.rejections, [{ code: 'limit_exceeded' }]);
});

test('malformed carrier is removed and never forwarded', () => {
  const result = extractAndStripIdentityCarrier({
    mentionable: { verifiable_credentials: { proof: 'secret' } },
  });
  assert.deepEqual(result, {
    credentials: [],
    metadata: undefined,
    rejections: [{ code: 'malformed' }],
  });
});

test('malformed mentionable containers are removed with all nested secrets', () => {
  const secret = {
    verifiable_credentials: [
      {
        proof: { proofValue: 'zSECRET' },
        credentialSubject: { profile: { email: 'victim@example.com' } },
      },
    ],
    identity_evidence: [{ token: 'legacy-secret' }],
  };

  for (const mentionable of [[secret], JSON.stringify(secret), null]) {
    const result = extractAndStripIdentityCarrier({ keep: true, mentionable });
    assert.deepEqual(result, {
      credentials: [],
      metadata: { keep: true },
      rejections: [{ code: 'malformed' }],
    });
    const serialized = JSON.stringify(result.metadata);
    assert.equal(serialized.includes('zSECRET'), false);
    assert.equal(serialized.includes('victim@example.com'), false);
    assert.equal(serialized.includes('legacy-secret'), false);
  }
});
