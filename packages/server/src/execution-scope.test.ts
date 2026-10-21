import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_SCOPE_V1_CAPABILITY,
  CALLER_CONTEXT_V2_CAPABILITY,
  TASK_REPLAY_CAPABILITY,
  ExecutionScopeV1,
  FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY,
  formatFederatedPrincipal,
  TaskAssignFrame,
} from '@vicoop-bridge/protocol';
import { resolveExecutionScope } from './execution-scope.js';

const capabilities = [EXECUTION_SCOPE_V1_CAPABILITY, CALLER_CONTEXT_V2_CAPABILITY, TASK_REPLAY_CAPABILITY];
const input = { agentId: 'agent', principalId: 'apikey:alice', capabilities };

test('direct scope is stable and separated by agent and exact principal', () => {
  const scope = resolveExecutionScope(input)!;
  assert.ok(ExecutionScopeV1.safeParse(scope).success);
  assert.deepEqual(resolveExecutionScope({ ...input }), scope);
  assert.notEqual(resolveExecutionScope({ ...input, agentId: 'other' })!.id, scope.id);
  assert.notEqual(resolveExecutionScope({ ...input, principalId: 'apikey:bob' })!.id, scope.id);
  assert.notEqual(
    resolveExecutionScope({ ...input, agentId: 'a:b', principalId: 'c' })!.id,
    resolveExecutionScope({ ...input, agentId: 'a', principalId: 'b:c' })!.id,
  );
});

test('missing identity, unsupported negotiation, and grants never become direct scopes', () => {
  for (const capabilitiesSubset of [undefined, [], ...capabilities.map((c) => capabilities.filter((v) => v !== c))]) {
    assert.equal(resolveExecutionScope({ ...input, capabilities: capabilitiesSubset }), undefined);
  }
  for (const patch of [
    { principalId: undefined }, { principalId: '' }, { principalId: 'x'.repeat(513) },
    { actorId: 'connector' }, { actorId: input.principalId },
    { authorizationKey: 'grant' }, { authorizationProfile: 'profile' },
  ]) assert.equal(resolveExecutionScope({ ...input, ...patch }), undefined);
});

test('wire schema accepts legacy assignments and rejects unknown scope policies/fields', () => {
  const legacy = {
    type: 'task.assign', taskId: 't', contextId: 'c',
    message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm' },
  };
  assert.equal(TaskAssignFrame.parse(legacy).executionScope, undefined);
  const scope = resolveExecutionScope(input)!;
  assert.deepEqual(TaskAssignFrame.parse({ ...legacy, executionScope: scope }).executionScope, scope);
  for (const patch of [{ policy: 'future-v2' }, { id: '../victim' }, { runtimeName: 'victim' }]) {
    assert.equal(TaskAssignFrame.safeParse({ ...legacy, executionScope: { ...scope, ...patch } }).success, false);
  }
});

const tuple = { issuer: 'did:web:connector.example', method: 'urn:mentionable:auth:slack:workspace:v0.1', subject: 'slack:T123/U456' };
const federated = {
  agentId: 'agent', principalId: tuple.subject, actorId: tuple.issuer,
  authorizationKey: formatFederatedPrincipal(tuple)!,
  authorizationProfile: 'https://mentionable.dev/ns/oauth-federation/v0.1',
  capabilities: [...capabilities, FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY],
};
test('verified federated tuple has a stable scope independent of token/task and separated by issuer/method/subject', () => {
  const scope = resolveExecutionScope(federated)!;
  assert.equal(scope.policy, 'federated-principal-v1');
  assert.equal(scope.principalId, federated.authorizationKey);
  assert.deepEqual(resolveExecutionScope({ ...federated }), scope);
  for (const patch of [{ issuer: 'did:web:other.example' }, { subject: 'slack:T123/other' }, { method: 'another-method' }]) {
    const other = { ...tuple, ...patch };
    assert.notEqual(resolveExecutionScope({ ...federated, actorId: other.issuer, principalId: other.subject, authorizationKey: formatFederatedPrincipal(other)! })?.id, scope.id);
  }
  assert.notEqual(resolveExecutionScope({ ...input, principalId: tuple.subject })!.id, scope.id);
});
test('federated admission fails closed for old clients, inconsistent identity, malformed tuple, and other profiles', () => {
  for (const patch of [
    { capabilities }, { actorId: undefined }, { actorId: 'did:web:other.example' },
    { principalId: 'slack:T123/other' }, { authorizationKey: 'federated:v1:bad' },
    { authorizationProfile: undefined }, { authorizationProfile: 'other-profile' },
  ]) assert.equal(resolveExecutionScope({ ...federated, ...patch }), undefined);
  assert.equal(resolveExecutionScope({ ...input, principalId: federated.authorizationKey }), undefined);
});
