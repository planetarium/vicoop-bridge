import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskState, V03ResponseMapper, V10ResponseMapper, type Task } from '@a2x/sdk';
import { normalizeTaskParts, partToA2X } from './parts.js';

const wire = [
  { kind: 'text', text: 'files', metadata: { label: 'text' } },
  { kind: 'file', file: { name: 'a.bin', mimeType: 'application/octet-stream', bytes: 'AAE=' }, metadata: { label: 'inline' } },
  { kind: 'file', file: { name: 'b.bin', mimeType: 'application/octet-stream', uri: 'https://example.test/b.bin' }, metadata: { label: 'uri' } },
  { kind: 'data', data: { file: { bytes: 'opaque data' } }, metadata: { label: 'data' } },
] as const;
const flat = [
  { text: 'files', metadata: { label: 'text' } },
  { filename: 'a.bin', mediaType: 'application/octet-stream', raw: 'AAE=', metadata: { label: 'inline' } },
  { filename: 'b.bin', mediaType: 'application/octet-stream', url: 'https://example.test/b.bin', metadata: { label: 'uri' } },
  { data: { file: { bytes: 'opaque data' } }, metadata: { label: 'data' } },
];

test('wire parts become SDK parts without losing metadata or changing data payloads', () => {
  assert.deepEqual(wire.map(partToA2X), flat);
  for (const part of flat) assert.equal(partToA2X(part), part);
  assert.deepEqual(partToA2X({ kind: 'file', file: { bytes: '', name: '', mimeType: '' } }),
    { raw: '', filename: '', mediaType: '' });
  assert.deepEqual(partToA2X({ kind: 'file', file: { uri: 'https://example.test/file' } }),
    { url: 'https://example.test/file' });
});

test('legacy task normalization is immutable and idempotent through both SDK response mappers', () => {
  const message = { messageId: 'm', role: 'agent', parts: wire, metadata: { note: 'kept' }, extensions: ['urn:test'] };
  // Deliberately model the historical JSON stored before #549, not SDK Part[].
  const legacy = {
    id: 'task', contextId: 'context', status: { state: TaskState.COMPLETED, message },
    history: [message], artifacts: [{ artifactId: 'a', parts: wire, metadata: { note: 'kept' }, extensions: ['urn:test'] }],
    metadata: { file: { bytes: 'opaque metadata' } },
  } as unknown as Task;
  const original = structuredClone(legacy);
  const normalized = normalizeTaskParts(legacy);
  assert.deepEqual(legacy, original);
  assert.deepEqual(normalizeTaskParts(normalized), normalized);
  for (const [mapper, expected] of [[new V03ResponseMapper(), wire], [new V10ResponseMapper(), flat]] as const) {
    const result = mapper.mapTask(normalized) as Task;
    assert.deepEqual(result.artifacts![0]!.parts, expected);
    assert.deepEqual(result.status.message!.parts, expected);
    assert.deepEqual(result.history![0]!.parts, expected);
    assert.deepEqual(result.artifacts![0]!.metadata, { note: 'kept' });
    assert.deepEqual(result.status.message!.extensions, ['urn:test']);
    assert.deepEqual(result.metadata, legacy.metadata);
  }
});

test('extra file fields never override SDK part discriminators or crash legacy reads', () => {
  for (const file of [null, undefined, false, 42, 'legacy', [], { bytes: 'wrong' }]) {
    for (const base of [{ text: 'kept' }, { data: { value: 'kept' } }, { raw: 'AAE=' }, { url: 'https://example.test/file' }]) {
      const part = { ...base, file, metadata: { keep: true } };
      assert.equal(partToA2X(part), part);
      const legacy = { id: 'legacy', status: { state: TaskState.COMPLETED },
        history: [{ messageId: 'm', role: 'user', parts: [part] }] } as Task;
      for (const mapper of [new V03ResponseMapper(), new V10ResponseMapper()]) {
        assert.doesNotThrow(() => mapper.mapTask(normalizeTaskParts(legacy)));
      }
    }
  }
  const text = { kind: 'text' as const, text: 'kept', file: null };
  const data = { kind: 'data' as const, data: { kept: true }, file: { bytes: 'wrong' } };
  assert.deepEqual(partToA2X(text), { text: 'kept', file: null });
  assert.deepEqual(partToA2X(data),
    { data: { kept: true }, file: { bytes: 'wrong' } });
});
