import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFederatedPrincipal, parseFederatedPrincipal, executionScopePolicy, executionScopePreimage } from './federated-principal.js';

test('canonical tuple roundtrips Unicode and separators without aliases or truncation', () => {
  const tuple = { issuer: 'did:web:example:connector', method: 'urn:slack:workspace', subject: 'slack:T/사용자😀' };
  const key = formatFederatedPrincipal(tuple)!;
  assert.deepEqual(parseFederatedPrincipal(key), tuple);
  assert.equal(executionScopePolicy(key), 'federated-principal-v1');
  for (const invalid of [key + 'x', key.replace('federated:v1:', 'federated:v1:0'), 'federated:v1:0:', key.slice(0, -1)]) assert.equal(parseFederatedPrincipal(invalid), null);
  assert.equal(formatFederatedPrincipal({ ...tuple, subject: 'x'.repeat(512) }), null);
  assert.equal(formatFederatedPrincipal({ ...tuple, subject: ' trailing ' }), null);
});
test('direct scope preimage remains byte-for-byte compatible', () => {
  assert.equal(executionScopePreimage('agent', 'apikey:alice'), JSON.stringify(['vicoop-execution-scope', 'direct-principal-v1', 'agent', 'apikey:alice']));
});
