import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TaskAssignFrame,
  TaskStatusFrame,
  encodeFrame,
  isDeltaRequest,
  parseDownFrame,
  parseUpFrame,
} from './index.js';

test('TaskStatusFrame round-trips an optional metadata object verbatim', () => {
  const frame = {
    type: 'task.status' as const,
    taskId: 'task-1',
    status: { state: 'working' as const, timestamp: '2026-06-18T00:00:00.000Z' },
    metadata: {
      [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true },
    },
  };

  // Schema accepts it.
  const parsed = TaskStatusFrame.parse(frame);
  assert.deepEqual(parsed.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true },
  });

  // Full encode → parseUpFrame round-trip preserves it on the wire.
  const wire = encodeFrame(frame);
  const decoded = parseUpFrame(wire);
  assert.equal(decoded.type, 'task.status');
  if (decoded.type !== 'task.status') throw new Error('unreachable');
  assert.deepEqual(decoded.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true },
  });
});

test('TaskStatusFrame.metadata is optional — frames without it parse and omit the field', () => {
  const frame = {
    type: 'task.status' as const,
    taskId: 'task-2',
    status: { state: 'working' as const },
  };
  const parsed = TaskStatusFrame.parse(frame);
  assert.equal(parsed.metadata, undefined);

  const decoded = parseUpFrame(encodeFrame(frame));
  if (decoded.type !== 'task.status') throw new Error('unreachable');
  assert.equal(decoded.metadata, undefined);
});

// ---- Stateful-context delta (#410) ----

test('isDeltaRequest detects the openai-compat delta marker', () => {
  assert.equal(
    isDeltaRequest({ [OPENAI_COMPAT_EXTENSION_URI]: { delta: true } }),
    true,
  );
});

test('isDeltaRequest is false when the marker is absent, false, or malformed', () => {
  assert.equal(isDeltaRequest(undefined), false);
  assert.equal(isDeltaRequest({}), false);
  assert.equal(isDeltaRequest({ [OPENAI_COMPAT_EXTENSION_URI]: {} }), false);
  assert.equal(isDeltaRequest({ [OPENAI_COMPAT_EXTENSION_URI]: { delta: false } }), false);
  // A classic full-replay envelope (no delta flag) is not a delta request.
  assert.equal(
    isDeltaRequest({ [OPENAI_COMPAT_EXTENSION_URI]: { chat_completions_request: {} } }),
    false,
  );
  // Non-object under the URI must not throw.
  assert.equal(isDeltaRequest({ [OPENAI_COMPAT_EXTENSION_URI]: 'nope' }), false);
});

test('TaskAssignFrame round-trips contextHistory on the wire', () => {
  const frame = {
    type: 'task.assign' as const,
    taskId: 'task-3',
    contextId: 'ctx-3',
    message: {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'turn 2' }],
      messageId: 'm-2',
    },
    contextHistory: [
      { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'turn 1' }], messageId: 'm-0' },
      { role: 'agent' as const, parts: [{ kind: 'text' as const, text: 'reply 1' }], messageId: 'm-1' },
    ],
  };

  const parsed = TaskAssignFrame.parse(frame);
  assert.equal(parsed.contextHistory?.length, 2);

  const decoded = parseDownFrame(encodeFrame(frame));
  if (decoded.type !== 'task.assign') throw new Error('unreachable');
  assert.deepEqual(decoded.contextHistory, frame.contextHistory);
});

test('TaskAssignFrame.contextHistory is optional — frames without it parse and omit the field', () => {
  const frame = {
    type: 'task.assign' as const,
    taskId: 'task-4',
    contextId: 'ctx-4',
    message: {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: 'hi' }],
      messageId: 'm-4',
    },
  };
  const decoded = parseDownFrame(encodeFrame(frame));
  if (decoded.type !== 'task.assign') throw new Error('unreachable');
  assert.equal(decoded.contextHistory, undefined);
});
