import test from 'node:test';
import assert from 'node:assert/strict';
import { runBackendInit } from './backend-init.js';

// A logger spy good enough for assertions on the "what got logged"
// surface. Backend init's logger surface is the public contract for
// operator-facing messages, so it's the right place to anchor tests
// that don't want to mock the whole dockerode stack.
function makeLogger() {
  const records: Array<{ level: string; args: unknown[] }> = [];
  return {
    records,
    logger: {
      level: 'info' as const,
      error: (...args: unknown[]) => records.push({ level: 'error', args }),
      warn: (...args: unknown[]) => records.push({ level: 'warn', args }),
      info: (...args: unknown[]) => records.push({ level: 'info', args }),
      debug: (...args: unknown[]) => records.push({ level: 'debug', args }),
    },
  };
}

test('host runtime is rejected with code 64 and a clear hint', async () => {
  const { logger, records } = makeLogger();
  const code = await runBackendInit({
    kind: 'codex',
    runtime: 'host',
    fromHost: false,
    logger,
  });
  assert.equal(code, 64);
  const errorLines = records
    .filter((r) => r.level === 'error')
    .map((r) => r.args.join(' '));
  assert.ok(
    errorLines.some((line) => line.includes('--runtime container only')),
    'expected an error mentioning the host-mode limitation',
  );
});
