import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Part } from '@vicoop-bridge/protocol';
import { summarizeParts } from './client.js';

test('summarizeParts: empty', () => {
  assert.equal(summarizeParts([]), '(none)');
});

test('summarizeParts: text part reports text/plain', () => {
  const parts: Part[] = [{ kind: 'text', text: 'hi' }];
  assert.equal(summarizeParts(parts), 'text/plain');
});

test('summarizeParts: file part uses declared mimeType', () => {
  const parts: Part[] = [{ kind: 'file', file: { name: 'a.png', mimeType: 'image/png' } }];
  assert.equal(summarizeParts(parts), 'image/png');
});

test('summarizeParts: file part without mimeType falls back to octet-stream', () => {
  const parts: Part[] = [{ kind: 'file', file: { name: 'a.bin' } }];
  assert.equal(summarizeParts(parts), 'application/octet-stream');
});

test('summarizeParts: data part reports application/json', () => {
  const parts: Part[] = [{ kind: 'data', data: { foo: 'bar' } }];
  assert.equal(summarizeParts(parts), 'application/json');
});

test('summarizeParts: dedupes mime types and preserves first-seen order', () => {
  const parts: Part[] = [
    { kind: 'text', text: 'one' },
    { kind: 'file', file: { name: 'a.png', mimeType: 'image/png' } },
    { kind: 'text', text: 'two' },
    { kind: 'file', file: { name: 'b.png', mimeType: 'image/png' } },
    { kind: 'data', data: {} },
  ];
  assert.equal(summarizeParts(parts), 'text/plain,image/png,application/json');
});

test('summarizeParts: does not include user-supplied content', () => {
  const secret = 'super-secret-token';
  const parts: Part[] = [
    { kind: 'text', text: secret },
    { kind: 'file', file: { name: secret, mimeType: 'image/png', bytes: secret } },
    { kind: 'data', data: { token: secret } },
  ];
  const summary = summarizeParts(parts);
  assert.equal(summary.includes(secret), false);
});
