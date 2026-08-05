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
  assert.deepEqual(result.usage, {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    cached_tokens: 20,
    model: 'sonnet',
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
  assert.equal(result.usage?.total_tokens, 15);
});

test('readTaskUsage falls back to the bare openai-compat usage shape', () => {
  // A client too old to send the frame field must stay priceable rather than
  // silently billing the floor.
  const result = readTaskUsage(
    undefined,
    oaiMetadata({ usage: { prompt_tokens: 120, completion_tokens: 30, model: 'sonnet' } }),
  );
  assert.equal(result.source, 'openai-compat');
  assert.deepEqual(result.usage, {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    model: 'sonnet',
  });
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
  assert.deepEqual(result.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

test('readTaskUsage recomputes the total rather than trusting the reported one', () => {
  // The charge derives from prompt + completion, so a backend that
  // miscomputed the total must not be able to move the price.
  const result = readTaskUsage(
    undefined,
    oaiMetadata({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99999 } }),
  );
  assert.equal(result.usage?.total_tokens, 15);
});

test('readTaskUsage drops an incoherent cache count instead of discounting on it', () => {
  // cached is a breakdown of prompt; a larger value would discount tokens
  // that were never cached.
  const fromProtocol = readTaskUsage(
    { promptTokens: 100, completionTokens: 0, cachedInputTokens: 5000 },
    undefined,
  );
  assert.equal(fromProtocol.usage?.cached_tokens, undefined);
  assert.equal(fromProtocol.usage?.prompt_tokens, 100);

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
  assert.equal(fromLegacy.usage?.cached_tokens, undefined);
});

test('readTaskUsage reports nothing usable as undefined with no source', () => {
  const nothing = readTaskUsage(undefined, undefined);
  assert.equal(nothing.usage, undefined);
  assert.equal(nothing.source, undefined);

  assert.equal(readTaskUsage(undefined, {}).usage, undefined);
  assert.equal(readTaskUsage(undefined, oaiMetadata({})).usage, undefined);
  assert.equal(
    readTaskUsage(undefined, oaiMetadata({ usage: { prompt_tokens: 10 } })).usage,
    undefined,
  );
  assert.equal(
    readTaskUsage(undefined, oaiMetadata({ usage: { prompt_tokens: -1, completion_tokens: 5 } }))
      .usage,
    undefined,
  );
  assert.equal(
    readTaskUsage(undefined, oaiMetadata({ usage: { prompt_tokens: 1.5, completion_tokens: 5 } }))
      .usage,
    undefined,
  );
});

test('a malformed protocol field falls through to the legacy source', () => {
  // Rather than treating a broken frame as "unpriceable" while a perfectly
  // good legacy value sits right there.
  const result = readTaskUsage(
    { promptTokens: -1, completionTokens: 5 } as unknown as WireTaskUsage,
    oaiMetadata({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  );
  assert.equal(result.source, 'openai-compat');
  assert.equal(result.usage?.total_tokens, 15);
});

test('a zero-token report is surfaced as a real zero, not as absent', () => {
  // Some runtimes emit {0,0} when their accounting dropped. `meterUsage`
  // treats that as unpriceable, but the reader must not paper over the
  // difference between "reported zero" and "reported nothing".
  const result = readTaskUsage({ promptTokens: 0, completionTokens: 0 }, undefined);
  assert.equal(result.source, 'protocol');
  assert.deepEqual(result.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});
