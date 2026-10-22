import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteApprovalBroker, currentApprovalRequester } from './remote-approval.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';
const task: TaskAssignFrame = { type: 'task.assign', taskId: 'task', executionId: 'run', contextId: 'ctx', message: { role: 'user', messageId: 'm', parts: [] } };

test('approval binds decision to exact execution/request, snapshots input, and consumes once', async () => {
  const broker = new RemoteApprovalBroker(1000);
  const frames: UpFrame[] = [];
  const input = { command: 'echo approved' };
  await broker.run(task, new AbortController().signal, true, f => frames.push(f), async () => {
    let done = false;
    const result = currentApprovalRequester()('Bash', input).then(d => { done = true; return d; });
    const request = frames[0]; assert.equal(request.type, 'approval.request');
    if (request.type !== 'approval.request') throw new Error();
    input.command = 'changed';
    assert.equal(request.request.input.command, 'echo approved');
    const resolution = { type: 'approval.resolve' as const, taskId: task.taskId, executionId: 'wrong', requestId: request.request.requestId, decision: 'allow_once' as const };
    broker.resolve(resolution);
    await Promise.resolve(); assert.equal(done, false);
    broker.resolve({ ...resolution, executionId: 'run' });
    assert.equal(await result, 'allow_once');
    broker.resolve({ ...resolution, executionId: 'run', decision: 'deny' });
  });
  assert.equal(frames.filter(f => f.type === 'approval.received').length, 1);
});
test('unsupported peer, overlapping requests, process cancellation, and expiry fail closed', async () => {
  const frames: UpFrame[] = [];
  const ac = new AbortController();
  const broker = new RemoteApprovalBroker(10);
  await broker.run(task, ac.signal, false, f => frames.push(f), async () => {
    assert.equal(await currentApprovalRequester()('Bash', {}), 'deny');
  });
  assert.equal(frames.length, 0);
  await broker.run(task, ac.signal, true, f => frames.push(f), async () => {
    const first = currentApprovalRequester()('Bash', {});
    assert.equal(await currentApprovalRequester()('Bash', {}), 'deny');
    ac.abort(); assert.equal(await first, 'deny');
  });
  // Keep a ref'ed timer: the broker's timer intentionally doesn't keep the daemon alive.
  await broker.run(task, new AbortController().signal, true, f => frames.push(f), async () => {
    const result = currentApprovalRequester()('Bash', {});
    await new Promise(r => setTimeout(r, 20));
    assert.equal(await result, 'deny');
  });
});
