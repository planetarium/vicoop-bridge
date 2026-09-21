import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCallerRuntimeVersion } from './caller-runtime-version.js';

test('init and daemon share supported backend version gates', () => {
  assert.equal(assertCallerRuntimeVersion('claude', '2.1.267 (Claude Code)'), '2.1.267');
  assert.equal(assertCallerRuntimeVersion('codex', 'codex-cli 0.153.4'), '0.153.4');
  for (const [kind, output] of [['claude', '1.9.0'], ['claude', 'unknown'], ['codex', '0.100.0'], ['codex', '0.153.4-beta.1']] as const)
    assert.throws(() => assertCallerRuntimeVersion(kind, output), /unsupported or missing/);
});
