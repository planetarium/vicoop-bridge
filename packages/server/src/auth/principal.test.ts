import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrincipal, validatePrincipal, matchPrincipal } from './principal.js';

// ---------- parsePrincipal ----------

test('parsePrincipal: eth lowercase address', () => {
  assert.deepEqual(
    parsePrincipal('eth:0xaabbccddeeff00112233445566778899aabbccdd'),
    { kind: 'eth', address: '0xaabbccddeeff00112233445566778899aabbccdd' },
  );
});

test('parsePrincipal: eth mixed-case normalizes to lowercase', () => {
  assert.deepEqual(
    parsePrincipal('eth:0xAaBbCcDdEeFf00112233445566778899AaBbCcDd'),
    { kind: 'eth', address: '0xaabbccddeeff00112233445566778899aabbccdd' },
  );
});

test('parsePrincipal: eth invalid length', () => {
  assert.equal(parsePrincipal('eth:0xabc'), null);
});

test('parsePrincipal: eth invalid non-hex', () => {
  assert.equal(parsePrincipal('eth:0xgggggggggggggggggggggggggggggggggggggggg'), null);
});

test('parsePrincipal: eth missing 0x prefix', () => {
  assert.equal(parsePrincipal('eth:aabbccddeeff00112233445566778899aabbccdd'), null);
});

test('parsePrincipal: google:sub valid', () => {
  assert.deepEqual(
    parsePrincipal('google:sub:1234567890'),
    { kind: 'google-sub', sub: '1234567890' },
  );
});

test('parsePrincipal: google:sub opaque string preserved', () => {
  assert.deepEqual(
    parsePrincipal('google:sub:abc-XYZ_123'),
    { kind: 'google-sub', sub: 'abc-XYZ_123' },
  );
});

test('parsePrincipal: google:sub empty', () => {
  assert.equal(parsePrincipal('google:sub:'), null);
});

test('parsePrincipal: google:email valid lowercase', () => {
  assert.deepEqual(
    parsePrincipal('google:email:alice@example.com'),
    { kind: 'google-email', email: 'alice@example.com' },
  );
});

test('parsePrincipal: google:email normalizes to lowercase', () => {
  assert.deepEqual(
    parsePrincipal('google:email:Alice@Example.COM'),
    { kind: 'google-email', email: 'alice@example.com' },
  );
});

test('parsePrincipal: google:email missing @', () => {
  assert.equal(parsePrincipal('google:email:noatsign'), null);
});

test('parsePrincipal: google:email two @', () => {
  assert.equal(parsePrincipal('google:email:a@b@c'), null);
});

test('parsePrincipal: google:email empty local', () => {
  assert.equal(parsePrincipal('google:email:@example.com'), null);
});

test('parsePrincipal: google:email empty domain', () => {
  assert.equal(parsePrincipal('google:email:alice@'), null);
});

test('parsePrincipal: google:domain valid', () => {
  assert.deepEqual(
    parsePrincipal('google:domain:example.com'),
    { kind: 'google-domain', domain: 'example.com' },
  );
});

test('parsePrincipal: google:domain uppercase normalized', () => {
  assert.deepEqual(
    parsePrincipal('google:domain:Example.COM'),
    { kind: 'google-domain', domain: 'example.com' },
  );
});

test('parsePrincipal: google:domain no dot', () => {
  assert.equal(parsePrincipal('google:domain:localhost'), null);
});

test('parsePrincipal: google:domain empty', () => {
  assert.equal(parsePrincipal('google:domain:'), null);
});

test('parsePrincipal: google:domain invalid chars', () => {
  assert.equal(parsePrincipal('google:domain:foo_bar.com'), null);
});

test('parsePrincipal: unknown prefix', () => {
  assert.equal(parsePrincipal('facebook:123'), null);
});

test('parsePrincipal: empty string', () => {
  assert.equal(parsePrincipal(''), null);
});

test('parsePrincipal: plain 0x address (no prefix) is not valid', () => {
  assert.equal(parsePrincipal('0xaabbccddeeff00112233445566778899aabbccdd'), null);
});

// ---------- validatePrincipal ----------

test('validatePrincipal: plain 0x auto-prefix', () => {
  assert.equal(
    validatePrincipal('0xaabbccddeeff00112233445566778899aabbccdd'),
    'eth:0xaabbccddeeff00112233445566778899aabbccdd',
  );
});

test('validatePrincipal: plain 0x uppercase normalized', () => {
  assert.equal(
    validatePrincipal('0xAABBCCDDEEFF00112233445566778899AABBCCDD'),
    'eth:0xaabbccddeeff00112233445566778899aabbccdd',
  );
});

test('validatePrincipal: trims whitespace', () => {
  assert.equal(
    validatePrincipal('   0xaabbccddeeff00112233445566778899aabbccdd  '),
    'eth:0xaabbccddeeff00112233445566778899aabbccdd',
  );
});

test('validatePrincipal: eth: prefixed, mixed case normalizes', () => {
  assert.equal(
    validatePrincipal('eth:0xAABBccddEEFF00112233445566778899aabbccdd'),
    'eth:0xaabbccddeeff00112233445566778899aabbccdd',
  );
});

test('validatePrincipal: google:sub normalizes (sub opaque)', () => {
  assert.equal(
    validatePrincipal('google:sub:1234567890'),
    'google:sub:1234567890',
  );
});

test('validatePrincipal: google:email normalizes to lowercase', () => {
  assert.equal(
    validatePrincipal('google:email:Alice@Example.COM'),
    'google:email:alice@example.com',
  );
});

test('validatePrincipal: google:domain normalizes to lowercase', () => {
  assert.equal(
    validatePrincipal('google:domain:Example.COM'),
    'google:domain:example.com',
  );
});

test('validatePrincipal: empty string', () => {
  assert.equal(validatePrincipal(''), null);
});

test('validatePrincipal: only whitespace', () => {
  assert.equal(validatePrincipal('   '), null);
});

test('validatePrincipal: malformed eth', () => {
  assert.equal(validatePrincipal('eth:0xnotvalid'), null);
});

test('validatePrincipal: unknown prefix', () => {
  assert.equal(validatePrincipal('facebook:123'), null);
});

test('validatePrincipal: malformed email', () => {
  assert.equal(validatePrincipal('google:email:notanemail'), null);
});

// ---------- matchPrincipal ----------

test('matchPrincipal: eth exact match with mixed case on both sides', () => {
  const caller = {
    principalId: 'eth:0xAABBCCDDEEFF00112233445566778899AABBCCDD',
  };
  assert.equal(
    matchPrincipal('eth:0xaabbccddeeff00112233445566778899aabbccdd', caller),
    true,
  );
});

test('matchPrincipal: eth mismatch', () => {
  const caller = {
    principalId: 'eth:0x1111111111111111111111111111111111111111',
  };
  assert.equal(
    matchPrincipal('eth:0xaabbccddeeff00112233445566778899aabbccdd', caller),
    false,
  );
});

test('matchPrincipal: eth entry but caller is google', () => {
  const caller = { principalId: 'google:1234567890' };
  assert.equal(
    matchPrincipal('eth:0xaabbccddeeff00112233445566778899aabbccdd', caller),
    false,
  );
});

test('matchPrincipal: google:sub hit', () => {
  const caller = { principalId: 'google:1234567890' };
  assert.equal(matchPrincipal('google:sub:1234567890', caller), true);
});

test('matchPrincipal: google:sub miss (different sub)', () => {
  const caller = { principalId: 'google:9999999999' };
  assert.equal(matchPrincipal('google:sub:1234567890', caller), false);
});

test('matchPrincipal: google:sub miss (eth caller)', () => {
  const caller = { principalId: 'eth:0xaabbccddeeff00112233445566778899aabbccdd' };
  assert.equal(matchPrincipal('google:sub:1234567890', caller), false);
});

test('matchPrincipal: google:email hit', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'Alice@Example.com',
    emailVerified: true,
  };
  assert.equal(matchPrincipal('google:email:alice@example.com', caller), true);
});

test('matchPrincipal: google:email miss when emailVerified=false', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@example.com',
    emailVerified: false,
  };
  assert.equal(matchPrincipal('google:email:alice@example.com', caller), false);
});

test('matchPrincipal: google:email miss when emailVerified undefined', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@example.com',
  };
  assert.equal(matchPrincipal('google:email:alice@example.com', caller), false);
});

test('matchPrincipal: google:email miss on different email', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'bob@example.com',
    emailVerified: true,
  };
  assert.equal(matchPrincipal('google:email:alice@example.com', caller), false);
});

test('matchPrincipal: google:domain hit via hostedDomain', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@example.com',
    emailVerified: true,
    hostedDomain: 'Example.com',
  };
  assert.equal(matchPrincipal('google:domain:example.com', caller), true);
});

test('matchPrincipal: google:domain hit via email suffix when hostedDomain missing', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@Example.COM',
    emailVerified: true,
  };
  assert.equal(matchPrincipal('google:domain:example.com', caller), true);
});

test('matchPrincipal: google:domain miss when emailVerified=false', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@example.com',
    emailVerified: false,
    hostedDomain: 'example.com',
  };
  assert.equal(matchPrincipal('google:domain:example.com', caller), false);
});

test('matchPrincipal: google:domain miss when domain differs', () => {
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@other.com',
    emailVerified: true,
    hostedDomain: 'other.com',
  };
  assert.equal(matchPrincipal('google:domain:example.com', caller), false);
});

test('matchPrincipal: google:domain miss when email suffix is a subdomain (not exact)', () => {
  // alice@mail.example.com ends with "@mail.example.com", which does not end
  // with "@example.com" literally — so this should not match.
  const caller = {
    principalId: 'google:1234567890',
    email: 'alice@mail.example.com',
    emailVerified: true,
  };
  assert.equal(matchPrincipal('google:domain:example.com', caller), false);
});

test('matchPrincipal: unparseable entry returns false', () => {
  const caller = { principalId: 'eth:0xaabbccddeeff00112233445566778899aabbccdd' };
  assert.equal(matchPrincipal('garbage', caller), false);
});

test('matchPrincipal: legacy plain 0x entry matches eth principal (backward compat)', () => {
  const caller = { principalId: 'eth:0xaabbccddeeff00112233445566778899aabbccdd' };
  assert.equal(
    matchPrincipal('0xAABBCCDDEEFF00112233445566778899AABBCCDD', caller),
    true,
  );
});
