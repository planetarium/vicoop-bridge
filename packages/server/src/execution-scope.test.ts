import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_SCOPE_V1_CAPABILITY,
  CALLER_CONTEXT_V2_CAPABILITY,
  TASK_REPLAY_CAPABILITY,
  ExecutionScopeV1,
  TaskAssignFrame,
} from '@vicoop-bridge/protocol';
import { resolveDirectExecutionScope } from './execution-scope.js';

const capabilities = [EXECUTION_SCOPE_V1_CAPABILITY, CALLER_CONTEXT_V2_CAPABILITY, TASK_REPLAY_CAPABILITY];
const input = { agentId: 'agent', principalId: 'apikey:alice', capabilities };

test('direct scope is stable and separated by agent and exact principal', () => {
  const scope = resolveDirectExecutionScope(input)!;
  assert.ok(ExecutionScopeV1.safeParse(scope).success);
  assert.deepEqual(resolveDirectExecutionScope({ ...input }), scope);
  assert.notEqual(resolveDirectExecutionScope({ ...input, agentId: 'other' })!.id, scope.id);
  assert.notEqual(resolveDirectExecutionScope({ ...input, principalId: 'apikey:bob' })!.id, scope.id);
  assert.notEqual(
    resolveDirectExecutionScope({ ...input, agentId: 'a:b', principalId: 'c' })!.id,
    resolveDirectExecutionScope({ ...input, agentId: 'a', principalId: 'b:c' })!.id,
  );
});

test('missing identity, unsupported negotiation, and grants never become direct scopes', () => {
  for (const capabilitiesSubset of [undefined, [], ...capabilities.map((c) => capabilities.filter((v) => v !== c))]) {
    assert.equal(resolveDirectExecutionScope({ ...input, capabilities: capabilitiesSubset }), undefined);
  }
  for (const patch of [
    { principalId: undefined }, { principalId: '' }, { principalId: 'x'.repeat(513) },
    { actorId: 'connector' }, { actorId: input.principalId },
    { authorizationKey: 'grant' }, { authorizationProfile: 'profile' },
  ]) assert.equal(resolveDirectExecutionScope({ ...input, ...patch }), undefined);
});

test('wire schema accepts legacy assignments and rejects unknown scope policies/fields', () => {
  const legacy = {
    type: 'task.assign', taskId: 't', contextId: 'c',
    message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm' },
  };
  assert.equal(TaskAssignFrame.parse(legacy).executionScope, undefined);
  const scope = resolveDirectExecutionScope(input)!;
  assert.deepEqual(TaskAssignFrame.parse({ ...legacy, executionScope: scope }).executionScope, scope);
  for (const patch of [{ policy: 'future-v2' }, { id: '../victim' }, { runtimeName: 'victim' }]) {
    assert.equal(TaskAssignFrame.safeParse({ ...legacy, executionScope: { ...scope, ...patch } }).success, false);
  }
});
