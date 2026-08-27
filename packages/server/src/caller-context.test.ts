import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  CALLER_CONTEXT_V1_CAPABILITY,
  CALLER_CONTEXT_V2_CAPABILITY,
} from '@vicoop-bridge/protocol';
import {
  canonicalizeCallerContextV1,
  createCanonicalCallerContext,
  selectCallerContextVersion,
  serializeCallerContext,
} from './caller-context.js';

// Frozen copy of the 0.38.x/0.39.x caller parser. This deliberately does not
// import the evolving protocol union, so server-first compatibility is real.
const LegacyCallerContextV1 = z
  .object({
    authenticated: z.object({ principalId: z.string().min(1).max(512) }).strict().optional(),
    presented: z
      .array(
        z
          .object({
            credentialId: z.string().min(1).max(512),
            issuer: z.string().min(1).max(512),
            subject: z.string().min(1).max(512),
            method: z.string().min(1).max(256),
            assurance: z.string().min(1).max(256).optional(),
            platform: z
              .object({
                provider: z.string().min(1).max(256).optional(),
                workspaceId: z.string().min(1).max(256).optional(),
              })
              .strict()
              .optional(),
            observedInvocation: z
              .object({ target: z.string().min(1).max(512).optional() })
              .strict()
              .optional(),
            profile: z
              .object({
                displayName: z.string().min(1).max(256).optional(),
                username: z.string().min(1).max(256).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

const LegacyTaskAssignFrameV1 = z.object({
  type: z.literal('task.assign'),
  taskId: z.string(),
  executionId: z.string().min(1).max(128).optional(),
  contextId: z.string(),
  message: z.object({
    role: z.enum(['user', 'agent']),
    parts: z.array(z.unknown()),
    messageId: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extensions: z.array(z.string()).optional(),
  }),
  requestedExtensions: z.array(z.string()).optional(),
  caller: LegacyCallerContextV1.optional(),
});

test('selects caller-context v2 before v1 and otherwise disables delivery', () => {
  assert.equal(
    selectCallerContextVersion([
      CALLER_CONTEXT_V1_CAPABILITY,
      CALLER_CONTEXT_V2_CAPABILITY,
    ]),
    'v2',
  );
  assert.equal(selectCallerContextVersion([CALLER_CONTEXT_V1_CAPABILITY]), 'v1');
  assert.equal(selectCallerContextVersion([CALLER_CONTEXT_V2_CAPABILITY]), 'v2');
  assert.equal(selectCallerContextVersion([]), undefined);
  assert.equal(selectCallerContextVersion(undefined), undefined);
});

test('serializes canonical context for frozen v1 and v2 clients', () => {
  const canonical = createCanonicalCallerContext({
    principalId: 'siwe:0xabc',
    attestations: [
      {
        credentialId: 'urn:uuid:1',
        issuer: 'did:web:issuer.example',
        subject: 'slack:T123/U456',
        method: 'platform-identity-v0.2',
        assurance: 'platform',
        platform: { provider: 'slack', workspaceId: 'T123' },
        observedInvocation: { target: '@agent@bridge.example' },
        profile: { displayName: 'Alice', username: 'alice' },
      },
    ],
  });
  assert.ok(canonical);

  const v1 = serializeCallerContext(canonical, 'v1');
  const legacyFrame = LegacyTaskAssignFrameV1.parse({
    type: 'task.assign',
    taskId: 'task-legacy',
    contextId: 'context-legacy',
    message: { role: 'user', parts: [], messageId: 'message-legacy' },
    caller: v1,
  });
  assert.deepEqual(legacyFrame.caller, {
    authenticated: { principalId: 'siwe:0xabc' },
    presented: canonical.attestations,
  });
  assert.deepEqual(serializeCallerContext(canonical, 'v2'), {
    principal: { id: 'siwe:0xabc' },
    attestations: canonical.attestations,
  });
  assert.throws(() =>
    LegacyTaskAssignFrameV1.parse({
      ...legacyFrame,
      caller: serializeCallerContext(canonical, 'v2'),
    }),
  );
  assert.deepEqual(canonicalizeCallerContextV1(legacyFrame.caller!), canonical);
});

test('omits empty, invalid, unsupported, or v1-unrepresentable context', () => {
  assert.equal(createCanonicalCallerContext({}), undefined);
  assert.equal(createCanonicalCallerContext({ principalId: 'x'.repeat(513) }), undefined);

  const delegated = createCanonicalCallerContext({
    principalId: 'slack:T123/U456',
    actorId: 'service:gateway',
  });
  assert.ok(delegated);
  assert.equal(serializeCallerContext(delegated, 'v1'), undefined);
  assert.deepEqual(serializeCallerContext(delegated, 'v2'), {
    principal: { id: 'slack:T123/U456' },
    actor: { id: 'service:gateway' },
  });
  assert.equal(serializeCallerContext(delegated, undefined), undefined);
});
