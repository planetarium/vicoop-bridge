import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@optique/core/parser';
import { containerCmd } from './container-init.js';
import { callerStateCmd, runCallerState } from './caller-runtime-admin.js';

test('container commands default config and select caller scopes rather than legacy names', () => {
  for (const verb of ['list', 'validate']) {
    const result = parse(containerCmd, ['container', verb]);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.value.action, 'caller-state');
      assert.equal('config' in result.value ? result.value.config : null, undefined);
      if (verb === 'validate') assert.equal('validate' in result.value && result.value.validate, true);
    }
  }
  for (const verb of ['remove', 'recreate']) {
    const id = 'a'.repeat(64);
    const result = parse(containerCmd, ['container', verb, id, '--config', '/agent.json', '--backend', 'codex']);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.value.action, 'caller-state');
      assert.equal('config' in result.value && result.value.config, '/agent.json');
      assert.equal('backend' in result.value && result.value.backend, 'codex');
      assert.equal(verb === 'remove'
        ? 'deleteScope' in result.value && result.value.deleteScope
        : 'recreateScope' in result.value && result.value.recreateScope, id);
    }
    assert.equal(parse(containerCmd, ['container', verb]).success, false);
  }
});

test('legacy tools require the explicit legacy namespace and caller-state remains compatible', () => {
  for (const [argv, action] of [
    [['list'], 'container-list'],
    [['remove', 'old-name', '--preserve-volumes'], 'container-remove'],
    [['validate', 'claude', '--name', 'old-name'], 'container-validate'],
  ] as const) {
    const result = parse(containerCmd, ['container', 'legacy', ...argv]);
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.value.action, action);
  }
  assert.equal(parse(containerCmd, ['container', 'remove', 'old-name', '--preserve-volumes']).success, false);
  const compatibility = parse(callerStateCmd, ['caller-state', '--config', '/agent.json', '--recreate-scope', 'a'.repeat(64)]);
  assert.equal(compatibility.success, true);
});


test('empty and malformed scope selectors fail before config or Docker access', async () => {
  for (const value of ['', 'old-name', 'a'.repeat(63), 'A'.repeat(64)]) {
    for (const operation of ['remove', 'recreate']) {
      const parsed = parse(containerCmd, ['container', operation, value]);
      assert.ok(parsed.success);
      if (parsed.value.action === 'caller-state') await assert.rejects(runCallerState({ ...parsed.value, config: '/nonexistent-config' }), /scope must be/);
    }
    for (const flag of ['--delete-scope', '--recreate-scope']) {
      const parsed = parse(callerStateCmd, ['caller-state', flag, value]);
      assert.ok(parsed.success);
      await assert.rejects(runCallerState({ ...parsed.value, config: '/nonexistent-config' }), /scope must be/);
    }
  }
  await assert.rejects(runCallerState({ config: '/nonexistent-config', deleteScope: 'a'.repeat(64), recreateScope: 'b'.repeat(64) }), /select either/);
});
