import assert from 'node:assert/strict';
import test from 'node:test';
import { runLogin } from './login.js';

test('login --help prints usage and exits successfully', async () => {
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await runLogin(['--help']);
    assert.equal(code, 0);
    assert.match(stderr, /usage: vicoop-client login/);
  } finally {
    process.stderr.write = originalWrite;
  }
});
