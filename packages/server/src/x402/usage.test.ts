import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_COMPAT_EXTENSION_URI, type TaskUsage as WireTaskUsage } from '@vicoop-bridge/protocol';
import { readTaskUsage } from './usage.js';

const oaiMetadata = (payload: Record<string, unknown>) => ({
  [OPENAI_COMPAT_EXTENSION_URI]: payload,
});

test('readTaskUsage prefers the protocol frame field', () => {
  const reported: WireTaskUsage = {
    promptTokens: 120,
    completionTokens: 30,
    cachedInputTokens: 20,
    model: 'sonnet',
  };
  const result = readTaskUsage(reported, undefined);
  assert.equal(result.source, 'protocol');
  assert.equal(result.model, 'sonnet');
  assert.deepEqual(result.usage, {
    kind: 'detailed',
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 20,
  });
});

test('the protocol field wins even when openai-compat metadata disagrees', () => {
  // Billing must not depend on which of two sources happens to be read first,
  // and the protocol field is the one the bridge owns.
  const result = readTaskUsage(
    { promptTokens: 10, completionTokens: 5 },
    oaiMetadata({ usage: { prompt_tokens: 9999, completion_tokens: 9999 } }),
  );
  assert.equal(result.source, 'protocol');
  assert.deepEqual(result.usage, { kind: 'detailed', inputTokens: 10, outputTokens: 5 });
});

test('readTaskUsage falls back to the bare openai-compat usage shape', () => {
  // A client too old to send the frame field must stay priceable rather than
  // silently billing the floor.
  const result = readTaskUsage(
    undefined,
    oaiMetadata({ usage: { prompt_tokens: 120, completion_tokens: 30, model: 'sonnet' } }),
  );
  assert.equal(result.source, 'openai-compat');
  assert.equal(result.model, 'sonnet');
  assert.deepEqual(result.usage, { kind: 'detailed', inputTokens: 120, outputTokens: 30 });
});

test('readTaskUsage falls back to the chat_completion envelope shape', () => {
  const result = readTaskUsage(
    undefined,
    oaiMetadata({
      chat_completion: {
        id: 'chatcmpl-x',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }),
  );
  assert.equal(result.source, 'openai-compat');
  assert.deepEqual(result.usage, { kind: 'detailed', inputTokens: 10, outputTokens: 5 });
});

test('readTaskUsage never reads a reported total', () => {
  // The charge derives from prompt + completion — the SDK sums them itself —
  // so a backend that miscomputed (or inflated) the total cannot move the
  // price.
  const result = readTaskUsage(
    undefined,
    oaiMetadata({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99999 } }),
  );
  assert.deepEqual(result.usage, { kind: 'detailed', inputTokens: 10, outputTokens: 5 });
});

test('readTaskUsage drops an incoherent cache count instead of discounting on it', () => {
  // cached is a breakdown of prompt; a larger value would discount tokens
  // that were never cached. Dropping it here also keeps the SDK from calling
  // the whole report unpriceable, which would downgrade the call to the floor.
  const fromProtocol = readTaskUsage(
    { promptTokens: 100, completionTokens: 0, cachedInputTokens: 5000 },
    undefined,
  );
  assert.deepEqual(fromProtocol.usage, { kind: 'detailed', inputTokens: 100, outputTokens: 0 });

  const fromLegacy = readTaskUsage(
    undefined,
    oaiMetadata({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 5000 },
      },
    }),
  );
  assert.deepEqual(fromLegacy.usage, { kind: 'detailed', inputTokens: 100, outputTokens: 0 });
});

test('readTaskUsage reports nothing usable as unreported with no source', () => {
  const nothing = readTaskUsage(undefined, undefined);
  assert.deepEqual(nothing.usage, { kind: 'unreported' });
  assert.equal(nothing.source, undefined);

  for (const metadata of [
    {},
    oaiMetadata({}),
    oaiMetadata({ usage: { prompt_tokens: 10 } }),
    oaiMetadata({ usage: { prompt_tokens: -1, completion_tokens: 5 } }),
    oaiMetadata({ usage: { prompt_tokens: 1.5, completion_tokens: 5 } }),
  ]) {
    assert.deepEqual(readTaskUsage(undefined, metadata).usage, { kind: 'unreported' });
  }
});

test('a malformed protocol field falls through to the legacy source', () => {
  // Rather than treating a broken frame as "unpriceable" while a perfectly
  // good legacy value sits right there.
  const result = readTaskUsage(
    { promptTokens: -1, completionTokens: 5 } as unknown as WireTaskUsage,
    oaiMetadata({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  );
  assert.equal(result.source, 'openai-compat');
  assert.deepEqual(result.usage, { kind: 'detailed', inputTokens: 10, outputTokens: 5 });
});

test('a zero-token report is a trusted zero, not unreported', () => {
  // The a2x#206 semantic: a backend that *reported* zero consumption is
  // believed, and the SDK settles it as a genuine '0' (basis `zero`) rather
  // than billing the floor. Only a task with no usable report at all becomes
  // `unreported` — the case the floor exists for.
  const result = readTaskUsage({ promptTokens: 0, completionTokens: 0 }, undefined);
  assert.equal(result.source, 'protocol');
  assert.deepEqual(result.usage, { kind: 'detailed', inputTokens: 0, outputTokens: 0 });
});
