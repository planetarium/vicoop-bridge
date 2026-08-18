import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  CALLER_CONTEXT_CAPABILITY,
  CallerContextV1,
  HelloFrame,
  OpenAICompatModelAdvertise,
  TaskAssignFrame,
  buildOpenAICompatExtensionParams,
  TaskStatusFrame,
  encodeFrame,
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

test('hello round-trips caller-context capability', () => {
  const frame = HelloFrame.parse({
    type: 'hello',
    agentId: 'agent-1',
    version: '0.1',
    token: 'secret',
    protocolCapabilities: [CALLER_CONTEXT_CAPABILITY],
  });
  const decoded = parseUpFrame(encodeFrame(frame));
  assert.equal(decoded.type, 'hello');
  if (decoded.type !== 'hello') throw new Error('unreachable');
  assert.deepEqual(decoded.protocolCapabilities, [CALLER_CONTEXT_CAPABILITY]);
});

test('task.assign caller context round-trips only when provided', () => {
  const base = {
    type: 'task.assign' as const,
    taskId: 'task-1',
    contextId: 'context-1',
    message: { role: 'user' as const, parts: [], messageId: 'message-1' },
  };
  const caller = {
    authenticated: { principalId: 'siwe:0xabc' },
    presented: [
      {
        credentialId: 'urn:uuid:credential-1',
        issuer: 'did:web:issuer.example',
        subject: 'acct:alice@example.com',
        method: 'platform-identity-v0.2',
        platform: { provider: 'slack', workspaceId: 'T123' },
      },
    ],
  };
  const decoded = parseDownFrame(encodeFrame(TaskAssignFrame.parse({ ...base, caller })));
  assert.equal(decoded.type, 'task.assign');
  if (decoded.type !== 'task.assign') throw new Error('unreachable');
  assert.deepEqual(decoded.caller, caller);

  const withoutCaller = parseDownFrame(encodeFrame(TaskAssignFrame.parse(base)));
  assert.equal(withoutCaller.type, 'task.assign');
  if (withoutCaller.type !== 'task.assign') throw new Error('unreachable');
  assert.equal(withoutCaller.caller, undefined);
});

test('caller context fails closed on unknown or oversized fields', () => {
  assert.throws(() =>
    CallerContextV1.parse({ authenticated: { principalId: 'siwe:0xabc', email: 'x@y.z' } }),
  );
  assert.throws(() =>
    CallerContextV1.parse({ authenticated: { principalId: 'x'.repeat(513) } }),
  );
  assert.throws(() =>
    CallerContextV1.parse({
      presented: Array.from({ length: 9 }, (_, i) => ({
        credentialId: `credential-${i}`,
        issuer: 'did:web:issuer.example',
        subject: 'acct:alice@example.com',
        method: 'test',
      })),
    }),
  );
});
