import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND_COMPAT, BACKENDS_MANIFEST, HOST_ONLY_BACKENDS } from './backends-manifest.js';

test('manifest lists only container-installable backends', () => {
  // Membership in the manifest is the contract — if a backend appears here,
  // it must have an `install-backend.sh` recipe (container/backends/<kind>.sh)
  // and full container-runtime creds/auth wiring (it's keyed by
  // InstallableBackendKind). echo / openclaw / vicoop-codex are valid daemon
  // backends but don't run under `--runtime container`; they intentionally
  // don't appear here.
  const expected = new Set(['claude', 'codex']);
  const actual = new Set(Object.keys(BACKENDS_MANIFEST));
  assert.deepEqual(actual, expected);
});

test('host-only backends are disjoint from the container manifest', () => {
  // The two sets must not overlap — a backend is either container-installable
  // (BACKENDS_MANIFEST) or host-only (HOST_ONLY_BACKENDS), never both.
  for (const kind of Object.keys(HOST_ONLY_BACKENDS)) {
    assert.ok(!(kind in BACKENDS_MANIFEST), `${kind} must not also be in BACKENDS_MANIFEST`);
  }
});

test('info advertises the union of container + host-only backends', () => {
  // `vicoop-client info` reports BACKEND_COMPAT, which must surface
  // vicoop-codex alongside the container-installable claude / codex.
  const expected = new Set(['claude', 'codex', 'vicoop-codex']);
  const actual = new Set(Object.keys(BACKEND_COMPAT));
  assert.deepEqual(actual, expected);
});

test('every compat entry has a non-empty supportedRange', () => {
  for (const [kind, entry] of Object.entries(BACKEND_COMPAT)) {
    assert.equal(typeof entry.supportedRange, 'string', `${kind}: range must be string`);
    assert.notEqual(entry.supportedRange.trim(), '', `${kind}: range must be non-empty`);
  }
});
