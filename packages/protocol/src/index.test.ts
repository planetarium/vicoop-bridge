import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TaskStatusFrame,
  encodeFrame,
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
