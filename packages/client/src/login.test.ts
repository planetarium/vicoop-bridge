import assert from 'node:assert/strict';
import test from 'node:test';
import { runLogin } from './login.js';

test('login help flags print usage and exit successfully', async (t) => {
  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const longCode = await runLogin(['--help']);
  assert.equal(longCode, 0);
  assert.match(stderr, /usage: vicoop-client login/);

  stderr = '';
  const shortCode = await runLogin(['-h']);
  assert.equal(shortCode, 0);
  assert.match(stderr, /usage: vicoop-client login/);
});
