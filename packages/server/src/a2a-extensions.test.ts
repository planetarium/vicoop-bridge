import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseA2AExtensionsHeader } from './a2a-extensions.js';

test('parseA2AExtensionsHeader trims, drops empties, and dedupes in order', () => {
  assert.deepEqual(
    parseA2AExtensionsHeader(' https://example.test/a , ,https://example.test/b,https://example.test/a '),
    ['https://example.test/a', 'https://example.test/b'],
  );
});

test('parseA2AExtensionsHeader returns empty list when absent', () => {
  assert.deepEqual(parseA2AExtensionsHeader(undefined), []);
});
