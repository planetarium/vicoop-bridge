import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from './device-ui.js';

const { buildState, verifyState, escapeHtml, normalizeUserCode } = __test__;

describe('escapeHtml', () => {
  it('escapes the five significant HTML characters', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
  });

  it('neutralizes a classic XSS script payload', () => {
    const out = escapeHtml('<script>alert("x")</script>');
    assert.ok(!out.includes('<script>'), `still contains <script>: ${out}`);
    assert.ok(!out.includes('</script>'), `still contains </script>: ${out}`);
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(out.includes('&quot;'));
  });

  it('neutralizes quoted attribute injections', () => {
    const out = escapeHtml(`" onerror="alert(1)`);
    assert.ok(!out.includes('"'), `raw quote left intact: ${out}`);
    assert.ok(out.startsWith('&quot;'));
  });

  it('handles ampersand ordering (does not double-escape)', () => {
    // Must escape '&' first so e.g. '&lt;' doesn't get turned into '&amp;lt;'
    // When passed literal text with '<' the single pass should produce '&lt;', not '&amp;lt;'.
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&<'), '&amp;&lt;');
  });
});

describe('normalizeUserCode', () => {
  it('uppercases and inserts hyphen at position 4 when 8 chars', () => {
    assert.equal(normalizeUserCode('wdjbmjht'), 'WDJB-MJHT');
    assert.equal(normalizeUserCode('WDJB-MJHT'), 'WDJB-MJHT');
    assert.equal(normalizeUserCode('  wdjb mjht  '), 'WDJB-MJHT');
    assert.equal(normalizeUserCode('wdjb-mjht'), 'WDJB-MJHT');
  });

  it('leaves non-8-char input uppercased but without forced hyphen', () => {
    assert.equal(normalizeUserCode('abc'), 'ABC');
    assert.equal(normalizeUserCode('abcdefghi'), 'ABCDEFGHI');
  });
});

describe('state build/parse round-trip', () => {
  const secret = 'test-secret-xyzzy';
  const deviceCode = 'device_abc123_!@#';

  it('builds a state that verifies back to the original device_code', () => {
    const state = buildState(secret, deviceCode);
    assert.match(state, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const decoded = verifyState(secret, state);
    assert.equal(decoded, deviceCode);
  });

  it('binds to the secret — wrong secret rejects', () => {
    const state = buildState(secret, deviceCode);
    assert.equal(verifyState('different-secret', state), null);
  });

  it('rejects a state whose HMAC was bit-flipped', () => {
    const state = buildState(secret, deviceCode);
    const dot = state.indexOf('.');
    const macB64 = state.slice(0, dot);
    const rest = state.slice(dot);

    // Decode, flip the first bit, re-encode — same length, bad HMAC.
    const macBytes = Buffer.from(macB64, 'base64url');
    macBytes[0] = (macBytes[0]! ^ 0x01) & 0xff;
    const tampered = macBytes.toString('base64url') + rest;

    assert.equal(verifyState(secret, tampered), null);
  });

  it('rejects a state whose device_code portion was swapped (HMAC mismatch)', () => {
    const state = buildState(secret, deviceCode);
    const dot = state.indexOf('.');
    const macPart = state.slice(0, dot);
    const otherDc = Buffer.from('other_device_code', 'utf8').toString('base64url');
    const tampered = `${macPart}.${otherDc}`;
    assert.equal(verifyState(secret, tampered), null);
  });

  it('rejects malformed states', () => {
    assert.equal(verifyState(secret, ''), null);
    assert.equal(verifyState(secret, 'no-dot-here'), null);
    assert.equal(verifyState(secret, '.foo'), null);
    assert.equal(verifyState(secret, 'foo.'), null);
  });

  it('rejects a truncated HMAC (length mismatch short-circuit)', () => {
    const state = buildState(secret, deviceCode);
    const dot = state.indexOf('.');
    const shortMac = state.slice(0, dot).slice(0, 8);
    const tampered = `${shortMac}${state.slice(dot)}`;
    assert.equal(verifyState(secret, tampered), null);
  });
});
