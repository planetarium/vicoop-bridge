import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  OpenAICompatModelAdvertise,
  buildOpenAICompatExtensionParams,
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

test('OpenAICompatModelAdvertise carries contextWindow / maxOutputTokens through to the wire', () => {
  const entry = OpenAICompatModelAdvertise.parse({
    id: 'claude-sonnet-4-5[1m]',
    default: true,
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  });
  assert.equal(entry.contextWindow, 1_000_000);
  assert.equal(entry.maxOutputTokens, 64_000);

  // The strict `z.object` must NOT strip the hints, and
  // `buildOpenAICompatExtensionParams` must carry them onto the params block
  // that reaches the AgentCard on the wire.
  const params = buildOpenAICompatExtensionParams([entry]);
  assert.deepEqual(params?.models, [entry]);
});

test('OpenAICompatModelAdvertise rejects a non-positive / non-integer contextWindow', () => {
  assert.throws(() => OpenAICompatModelAdvertise.parse({ id: 'm', contextWindow: 0 }));
  assert.throws(() => OpenAICompatModelAdvertise.parse({ id: 'm', maxOutputTokens: -1 }));
  assert.throws(() => OpenAICompatModelAdvertise.parse({ id: 'm', contextWindow: 1.5 }));
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
