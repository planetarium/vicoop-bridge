import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS_MANIFEST } from './backends-manifest.js';

test('manifest covers every backend kind referenced in cli pickBackend', () => {
  // Mirrors the switch in cli.ts:pickBackend. If a new backend is added there
  // without a manifest entry, the entrypoint's compat check would silently
  // skip it.
  const expected = ['echo', 'openclaw', 'claude', 'codex', 'vicoop-codex'] as const;
  for (const kind of expected) {
    assert.ok(BACKENDS_MANIFEST[kind], `${kind} missing from manifest`);
  }
});

test('every entry has a non-empty supportedRange', () => {
  for (const [kind, entry] of Object.entries(BACKENDS_MANIFEST)) {
    assert.equal(typeof entry.supportedRange, 'string', `${kind}: range must be string`);
    assert.notEqual(entry.supportedRange.trim(), '', `${kind}: range must be non-empty`);
  }
});

test('installable backends are agent CLIs the image can install', () => {
  // `echo` runs entirely in-process, `vicoop-codex` is bridge-internal —
  // neither has an install-backend.sh recipe. Catching a regression here is
  // cheaper than discovering an empty recipe at container boot.
  assert.equal(BACKENDS_MANIFEST.echo.installable, false);
  assert.equal(BACKENDS_MANIFEST['vicoop-codex'].installable, false);
  assert.equal(BACKENDS_MANIFEST.claude.installable, true);
  assert.equal(BACKENDS_MANIFEST.codex.installable, true);
  assert.equal(BACKENDS_MANIFEST.openclaw.installable, true);
});
