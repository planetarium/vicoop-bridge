import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCard,
  OPENAI_COMPAT_EXTENSION_URI,
  OpenAICompatExtensionParams,
  buildOpenAICompatExtensionParams,
  withOpenAICompatModelsAdvertise,
  type OpenAICompatModelAdvertise,
} from '@vicoop-bridge/protocol';

test('buildOpenAICompatExtensionParams returns undefined for empty input', () => {
  assert.equal(buildOpenAICompatExtensionParams([]), undefined);
});

test('buildOpenAICompatExtensionParams passes through a single entry verbatim', () => {
  const out = buildOpenAICompatExtensionParams([
    { id: 'opus-4-7', reasoning: true, default: true },
  ]);
  assert.deepEqual(out, {
    models: [{ id: 'opus-4-7', reasoning: true, default: true }],
  });
});

test('buildOpenAICompatExtensionParams keeps first default, strips later defaults', () => {
  const out = buildOpenAICompatExtensionParams([
    { id: 'a', default: true, reasoning: true },
    { id: 'b', default: true },
    { id: 'c' },
  ]);
  assert.deepEqual(out, {
    models: [
      { id: 'a', default: true, reasoning: true },
      { id: 'b' },
      { id: 'c' },
    ],
  });
});

test('buildOpenAICompatExtensionParams leaves non-default entries untouched', () => {
  const out = buildOpenAICompatExtensionParams([
    { id: 'a', reasoning: true },
    { id: 'b' },
  ]);
  assert.deepEqual(out, {
    models: [
      { id: 'a', reasoning: true },
      { id: 'b' },
    ],
  });
});

test('OpenAICompatExtensionParams schema accepts unknown sub-fields (passthrough)', () => {
  // Forward-compat: a future revision could add a sibling key alongside
  // `models`. The receiver-side parse should not strip it.
  const parsed = OpenAICompatExtensionParams.parse({
    models: [{ id: 'a' }],
    futureKey: { nested: 42 },
  });
  assert.deepEqual(parsed.models, [{ id: 'a' }]);
  assert.equal((parsed as { futureKey?: unknown }).futureKey !== undefined, true);
});

test('OpenAICompatModelAdvertise rejects empty id', () => {
  assert.throws(() => OpenAICompatExtensionParams.parse({ models: [{ id: '' }] }));
});

test('withOpenAICompatModelsAdvertise is a no-op when the openai-compat extension is absent', () => {
  const card = AgentCard.parse({
    name: 'no-ext',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: {
      extensions: [
        { uri: 'https://example.test/other/v1' },
      ],
    },
  });
  const out = withOpenAICompatModelsAdvertise(card, [{ id: 'opus-4-7', default: true }]);
  assert.deepEqual(out, card);
});

test('withOpenAICompatModelsAdvertise is a no-op when capabilities/extensions is undefined', () => {
  const card = AgentCard.parse({
    name: 'minimal',
    version: '0.0.1',
    protocolVersion: '0.3.0',
  });
  const out = withOpenAICompatModelsAdvertise(card, [{ id: 'opus-4-7', default: true }]);
  assert.deepEqual(out, card);
});

test('withOpenAICompatModelsAdvertise is a no-op for empty model list', () => {
  const card = AgentCard.parse({
    name: 'has-ext',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: {
      extensions: [{ uri: OPENAI_COMPAT_EXTENSION_URI }],
    },
  });
  const out = withOpenAICompatModelsAdvertise(card, []);
  assert.deepEqual(out, card);
});

test('withOpenAICompatModelsAdvertise merges models onto the openai-compat extension entry', () => {
  const card = AgentCard.parse({
    name: 'has-ext',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: {
      extensions: [
        { uri: 'https://example.test/other/v1', description: 'leave me alone' },
        { uri: OPENAI_COMPAT_EXTENSION_URI, description: 'keep desc' },
      ],
    },
  });
  const models: OpenAICompatModelAdvertise[] = [
    { id: 'opus-4-7', reasoning: true, default: true },
    { id: 'sonnet-4-6' },
  ];
  const out = withOpenAICompatModelsAdvertise(card, models);
  // Original is untouched.
  assert.equal(card.capabilities?.extensions?.[1].params, undefined);
  // Output has params.models on the openai-compat entry only.
  const exts = out.capabilities?.extensions;
  assert.equal(exts?.length, 2);
  assert.equal(exts?.[0].uri, 'https://example.test/other/v1');
  assert.equal(exts?.[0].params, undefined);
  assert.equal(exts?.[1].uri, OPENAI_COMPAT_EXTENSION_URI);
  assert.equal(exts?.[1].description, 'keep desc');
  assert.deepEqual(exts?.[1].params, {
    models: [
      { id: 'opus-4-7', reasoning: true, default: true },
      { id: 'sonnet-4-6' },
    ],
  });
});

test('withOpenAICompatModelsAdvertise preserves pre-existing params keys on the entry', () => {
  // If a future code path already wrote a sibling key onto `params`, the
  // merge must not drop it. Required for forward-compat with other
  // sub-fields the spec may add to the same params object.
  const card = AgentCard.parse({
    name: 'has-ext',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: {
      extensions: [
        {
          uri: OPENAI_COMPAT_EXTENSION_URI,
          params: { siblingKey: 'preserved' },
        },
      ],
    },
  });
  const out = withOpenAICompatModelsAdvertise(card, [{ id: 'a' }]);
  assert.deepEqual(out.capabilities?.extensions?.[0].params, {
    siblingKey: 'preserved',
    models: [{ id: 'a' }],
  });
});
