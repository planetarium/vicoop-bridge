import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCard, OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { resolveBundledCard } from './bundled-cards.js';
import { callerRuntimeCard } from './caller-runtime-card.js';

test('container cards advertise supported inline inputs without changing host cards', () => {
  for (const kind of ['claude', 'codex']) {
    const host = AgentCard.parse(resolveBundledCard(kind));
    const before = JSON.stringify(host);
    const isolated = callerRuntimeCard(host, kind);
    assert.equal(JSON.stringify(host), before);
    if (kind === 'codex') assert.ok(host.defaultInputModes?.includes('application/json'));
    assert.ok(!isolated.defaultInputModes?.includes('application/json'));
    assert.equal(isolated.defaultInputModes?.includes('application/pdf'), kind === 'claude');
    assert.ok(isolated.defaultInputModes?.includes('text/plain'));
    assert.equal(isolated.capabilities?.extensions?.some(e => e.uri === OPENAI_COMPAT_EXTENSION_URI), false);
    assert.doesNotMatch(isolated.description!, /persistent stdio|JSON data/);
    for (const skill of isolated.skills!) assert.doesNotMatch(skill.description!, /data.*parts|serialized/);
    assert.doesNotThrow(() => AgentCard.parse(isolated));
  }
});

test('custom cards retain service descriptions but cannot advertise only unsupported input modes', () => {
  const custom = AgentCard.parse({ name: 'service', version: '1', description: 'Weather service', defaultInputModes: ['text/plain', 'application/json'] });
  const card = callerRuntimeCard(custom, 'codex', true);
  assert.match(card.description!, /Weather service/);
  assert.match(card.description!, /JSON data parts and URI files are unsupported/);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.throws(() => callerRuntimeCard({ ...custom, defaultInputModes: ['application/json'] }, 'codex', true), /must advertise supported/);
});
