import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS_MANIFEST } from './backends-manifest.js';

test('manifest lists only image-installable backends', () => {
  // Membership in the manifest is the contract — if a backend appears here,
  // it must have an `install-backend.sh` recipe. echo / openclaw /
  // vicoop-codex are valid daemon backends but the image doesn't ship a
  // recipe for them today; they intentionally don't appear.
  const expected = new Set(['claude', 'codex']);
  const actual = new Set(Object.keys(BACKENDS_MANIFEST));
  assert.deepEqual(actual, expected);
});

test('every entry has a non-empty supportedRange', () => {
  for (const [kind, entry] of Object.entries(BACKENDS_MANIFEST)) {
    assert.equal(typeof entry.supportedRange, 'string', `${kind}: range must be string`);
    assert.notEqual(entry.supportedRange.trim(), '', `${kind}: range must be non-empty`);
  }
});
