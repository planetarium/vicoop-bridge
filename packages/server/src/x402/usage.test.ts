import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { readTaskUsage } from './usage.js';

test('readTaskUsage reads the bare {usage} shape plain A2A callers receive', () => {
  const usage = readTaskUsage({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, model: 'sonnet' },
    },
  });
  assert.deepEqual(usage, {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    model: 'sonnet',
  });
});

test('readTaskUsage reads the chat_completion envelope shape', () => {
  // The backends switch to this shape when the caller activated the
  // openai-compat extension; both must price identically.
  const usage = readTaskUsage({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      chat_completion: {
        id: 'chatcmpl-x',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
  });
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('readTaskUsage extracts cached and model details', () => {
  const usage = readTaskUsage({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 900 },
        completion_tokens_details: { reasoning_tokens: 40 },
        model: 'claude-sonnet-4',
      },
    },
  });
  assert.equal(usage?.cached_tokens, 900);
  assert.equal(usage?.model, 'claude-sonnet-4');
});

test('readTaskUsage recomputes the total rather than trusting the reported one', () => {
  // The charge is derived from prompt + completion, so a backend that
  // miscomputed `total_tokens` must not be able to move the price.
  const usage = readTaskUsage({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99999 },
    },
  });
  assert.equal(usage?.total_tokens, 15);
});

test('readTaskUsage drops an incoherent cache count instead of discounting on it', () => {
  // cached_tokens is a breakdown of prompt_tokens; a larger value is
  // nonsense, and honouring it would discount tokens that were never cached.
  const usage = readTaskUsage({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 0,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 5000 },
      },
    },
  });
  assert.equal(usage?.cached_tokens, undefined);
  assert.equal(usage?.prompt_tokens, 100);
});

test('readTaskUsage returns undefined when there is nothing usable', () => {
  assert.equal(readTaskUsage(undefined), undefined);
  assert.equal(readTaskUsage({}), undefined);
  assert.equal(readTaskUsage({ [OPENAI_COMPAT_EXTENSION_URI]: {} }), undefined);
  // Missing required counts, negative, and non-integer values are all
  // unusable — better to report "unpriceable" than to invent a number.
  assert.equal(
    readTaskUsage({ [OPENAI_COMPAT_EXTENSION_URI]: { usage: { prompt_tokens: 10 } } }),
    undefined,
  );
  assert.equal(
    readTaskUsage({
      [OPENAI_COMPAT_EXTENSION_URI]: { usage: { prompt_tokens: -1, completion_tokens: 5 } },
    }),
    undefined,
  );
  assert.equal(
    readTaskUsage({
      [OPENAI_COMPAT_EXTENSION_URI]: { usage: { prompt_tokens: 1.5, completion_tokens: 5 } },
    }),
    undefined,
  );
});

test('readTaskUsage surfaces the {0,0,0} placeholder as zero, not as absent', () => {
  // codex emits this when its runtime dropped accounting. It must reach
  // `meterUsage` as a real zero so that path is logged as unpriceable rather
  // than silently priced — the two are handled identically there, but the
  // reader must not paper over the difference here.
  const usage = readTaskUsage({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  });
  assert.deepEqual(usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});
