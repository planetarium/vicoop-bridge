import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAICompatUsage,
  sumOpenAICompatUsage,
  toProtocolTaskUsage,
} from './openai-compat-usage.js';

test('sumOpenAICompatUsage adds two runs, and never turns "not reported" into zero', () => {
  const a = buildOpenAICompatUsage({
    prompt_tokens: 1000,
    completion_tokens: 40,
    cached_tokens: 900,
    reasoning_tokens: 5,
    model: 'first',
  });
  const b = buildOpenAICompatUsage({ prompt_tokens: 2000, completion_tokens: 7, model: 'second' });
  assert.deepEqual(sumOpenAICompatUsage(a, b), {
    prompt_tokens: 3000,
    completion_tokens: 47,
    total_tokens: 3047,
    model: 'second',
    // Present on one side only: carried, the missing side counts as 0.
    prompt_tokens_details: { cached_tokens: 900 },
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  // Neither side has details → none are invented.
  assert.deepEqual(sumOpenAICompatUsage(b, b), {
    prompt_tokens: 4000,
    completion_tokens: 14,
    total_tokens: 4014,
    model: 'second',
  });
  assert.equal(sumOpenAICompatUsage(a, null), a);
  assert.equal(sumOpenAICompatUsage(null, b), b);
  assert.equal(sumOpenAICompatUsage(null, null), null);
});

test('toProtocolTaskUsage carries the counts onto the protocol shape', () => {
  const usage = buildOpenAICompatUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    cached_tokens: 900,
    reasoning_tokens: 50,
    model: 'claude-sonnet-4',
  });
  assert.deepEqual(toProtocolTaskUsage(usage), {
    promptTokens: 1000,
    completionTokens: 200,
    cachedInputTokens: 900,
    model: 'claude-sonnet-4',
  });
});

test('toProtocolTaskUsage does not carry a derived total', () => {
  // `total_tokens` is recomputed by the consumer from prompt + completion, so
  // shipping it would just be a second copy that could disagree.
  const usage = buildOpenAICompatUsage({ prompt_tokens: 10, completion_tokens: 5 });
  assert.deepEqual(toProtocolTaskUsage(usage), {
    promptTokens: 10,
    completionTokens: 5,
  });
});

test('toProtocolTaskUsage omits cache and model when the runtime did not report them', () => {
  const usage = buildOpenAICompatUsage({ prompt_tokens: 10, completion_tokens: 5 });
  const converted = toProtocolTaskUsage(usage)!;
  assert.equal('cachedInputTokens' in converted, false);
  assert.equal('model' in converted, false);
});

test('toProtocolTaskUsage returns undefined for no usage', () => {
  // Absent must stay absent all the way to the wire: the bridge bills on this
  // field, and a fabricated zero would be indistinguishable from a genuinely
  // free call.
  assert.equal(toProtocolTaskUsage(null), undefined);
});

test('toProtocolTaskUsage passes a reported zero through as a real zero', () => {
  // Distinct from the case above — here the runtime did answer, with zero.
  const usage = buildOpenAICompatUsage({ prompt_tokens: 0, completion_tokens: 0 });
  assert.deepEqual(toProtocolTaskUsage(usage), {
    promptTokens: 0,
    completionTokens: 0,
  });
});
