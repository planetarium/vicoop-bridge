import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCard, OPENAI_COMPAT_EXTENSION_URI, TRACEABILITY_EXTENSION_URI } from '@vicoop-bridge/protocol';
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
    assert.deepEqual(isolated.defaultOutputModes, ['text/plain']);
    assert.equal(isolated.capabilities?.extensions?.some(e => e.uri === OPENAI_COMPAT_EXTENSION_URI || e.uri === TRACEABILITY_EXTENSION_URI), false);
    assert.doesNotMatch(isolated.description!, /persistent stdio|JSON data/);
    for (const skill of isolated.skills!) assert.doesNotMatch(skill.description!, /data.*parts|serialized/);
    assert.doesNotThrow(() => AgentCard.parse(isolated));
  }
});

test('custom cards retain service descriptions but cannot advertise only unsupported input modes', () => {
  const custom = AgentCard.parse({ name: 'service', version: '1', description: 'Weather service', defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['image/png'], skills: [{ id: 'files', name: 'files', description: 'service', tags: [], outputModes: ['application/pdf'] }] });
  const card = callerRuntimeCard(custom, 'codex', true);
  assert.match(card.description!, /Weather service/);
  assert.match(card.description!, /JSON data parts and URI files are unsupported/);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.deepEqual(card.defaultOutputModes, ['text/plain']);
  assert.throws(() => callerRuntimeCard({ ...custom, defaultInputModes: ['application/json'] }, 'codex', true), /must advertise supported/);
});

test('custom caller cards remove traceability without changing the original extension list', () => {
  const host = AgentCard.parse({ name: 'custom', version: '1',
    capabilities: { extensions: [{ uri: TRACEABILITY_EXTENSION_URI }] },
  });
  assert.deepEqual(callerRuntimeCard(host, 'claude', true).capabilities?.extensions, []);
  assert.equal(host.capabilities?.extensions?.length, 1);
});
