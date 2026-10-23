import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Registry, type TaskBinding } from './registry.js';
import { approvalStatus } from './tool-approvals.js';
import { APPROVAL_EXTENSION_URI, REMOTE_APPROVAL_CAPABILITY, TASK_REPLAY_CAPABILITY } from '@vicoop-bridge/protocol';
function fixture() {
  const registry = new Registry(); const sent: string[] = [];
  registry.registerAgent({ agentId: 'agent', clientId: 'client', ownerPrincipal: 'owner',
    agentCard: { name: 'agent', version: '1', protocolVersion: '0.3.0' }, allowedCallers: [],
    protocolCapabilities: [TASK_REPLAY_CAPABILITY, REMOTE_APPROVAL_CAPABILITY],
    connectedAt: Date.now(), ws: { readyState: 1, OPEN: 1, send: (s: string) => sent.push(s), close() {} } as unknown as WebSocket });
  const b: TaskBinding = { agentId: 'agent', taskId: 'task', executionId: 'run', contextId: 'ctx',
    sink: { pushStatus() {}, pushArtifact() {}, finish() {} } };
  registry.bindTask(b);
  const input = { command: 'echo original' };
  const a = registry.approvals.request(b, { requestId: randomUUID(), toolName: 'Bash', input,
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { registry, b, a, input, sent };
}
test('approval freezes arguments, serializes a standard auth-required status, and accepts only one decision', () => {
  const { registry, b, a, input, sent } = fixture();
  try {
    input.command = 'tampered';
    assert.equal(a.input.command, 'echo original');
    const status = approvalStatus(a);
    assert.equal(status.state, 'auth-required');
    assert.equal(status.message.metadata[APPROVAL_EXTENSION_URI].requestId, a.requestId);
    assert.equal(registry.approvals.received(b, a.requestId, 'allow_once'), undefined);
    assert.equal(registry.approvals.decide(a.requestId, 'allow_once', 'owner')?.state, 'decided');
    assert.equal(registry.approvals.decide(a.requestId, 'deny', 'owner'), undefined);
    assert.equal(registry.approvals.decide(a.requestId, 'allow_once', 'other'), undefined);
    assert.equal(sent.length, 1);
    assert.equal(registry.approvals.decide(a.requestId, 'allow_once', 'owner')?.state, 'decided');
    assert.equal(registry.approvals.received({ ...b, executionId: 'wrong' }, a.requestId, 'allow_once'), undefined);
    assert.equal(registry.approvals.received(b, a.requestId, 'allow_once')?.state, 'received');
    assert.equal(registry.approvals.list().length, 0);
  } finally { registry.unbindTask(b.taskId, b); }
});
test('expired, displaced and cancelled execution approvals cannot be consumed', () => {
  const { registry, b, a } = fixture();
  a.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(registry.approvals.decide(a.requestId, 'allow_once', 'owner'), undefined);
  const next = { ...b, executionId: 'new-run' };
  registry.bindTask(next);
  assert.equal(registry.approvals.get(a.requestId), undefined);
  registry.unbindTask(next.taskId, next);
});
test('unacknowledged decision is delivered again to the same execution after reconnect', async () => {
  const { registry, b, a, sent } = fixture();
  try {
    registry.approvals.decide(a.requestId, 'allow_once', 'owner');
    await new Promise(r => setTimeout(r, 1100));
    assert.ok(sent.length >= 2);
    assert.equal(sent[0], sent[1]);
    registry.approvals.received(b, a.requestId, 'allow_once');
  } finally { registry.unbindTask(b.taskId, b); }
});
