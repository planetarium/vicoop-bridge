import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runContainerInit,
  collectClaudeHostCreds,
  collectCodexHostCreds,
} from './container-init.js';

// A logger spy good enough for assertions on the "what got logged"
// surface. container init's logger surface is the public contract
// for operator-facing messages, so it's the right place to anchor
// tests that don't want to mock the whole dockerode stack.
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
  const code = await runContainerInit({
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

// ──────────────────────────────────────────────────────────────────
// collectClaudeHostCreds
// ──────────────────────────────────────────────────────────────────

test('collectClaudeHostCreds darwin: keychain hit returns one creds file', () => {
  const files = collectClaudeHostCreds({
    platform: 'darwin',
    keychainLookup: (svc) => {
      assert.equal(svc, 'Claude Code-credentials');
      return '{"claudeAiOauth":{"accessToken":"x"}}';
    },
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].target, '/data/creds/claude/.credentials.json');
  assert.ok(files[0].data.toString().includes('claudeAiOauth'));
});

test('collectClaudeHostCreds darwin: keychain miss returns empty', () => {
  const files = collectClaudeHostCreds({
    platform: 'darwin',
    keychainLookup: () => null,
  });
  assert.deepEqual(files, []);
});

test('collectClaudeHostCreds darwin: keychain throw returns empty (not propagated)', () => {
  const files = collectClaudeHostCreds({
    platform: 'darwin',
    keychainLookup: () => {
      throw new Error('security: SecKeychainSearchCopyNext failed');
    },
  });
  assert.deepEqual(files, []);
});

test('collectClaudeHostCreds linux: reads ~/.claude/.credentials.json when present', () => {
  const files = collectClaudeHostCreds({
    platform: 'linux',
    homedir: () => '/home/op',
    existsSync: (p) => p === '/home/op/.claude/.credentials.json',
    readFileSync: (p) => {
      assert.equal(p, '/home/op/.claude/.credentials.json');
      return Buffer.from('{"token":"y"}');
    },
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].target, '/data/creds/claude/.credentials.json');
});

test('collectClaudeHostCreds linux: missing file returns empty', () => {
  const files = collectClaudeHostCreds({
    platform: 'linux',
    homedir: () => '/home/op',
    existsSync: () => false,
  });
  assert.deepEqual(files, []);
});

// ──────────────────────────────────────────────────────────────────
// collectCodexHostCreds
// ──────────────────────────────────────────────────────────────────

test('collectCodexHostCreds: picks up auth.json + config.toml when both present', () => {
  const seen: string[] = [];
  const files = collectCodexHostCreds({
    homedir: () => '/home/op',
    existsSync: () => true,
    readFileSync: (p) => {
      seen.push(p);
      return Buffer.from(`fixture:${p}`);
    },
  });
  assert.deepEqual(seen.sort(), [
    '/home/op/.codex/auth.json',
    '/home/op/.codex/config.toml',
  ]);
  assert.deepEqual(
    files.map((f) => f.target).sort(),
    ['/data/creds/codex/auth.json', '/data/creds/codex/config.toml'],
  );
});

test('collectCodexHostCreds: auth.json alone is enough', () => {
  const files = collectCodexHostCreds({
    homedir: () => '/home/op',
    existsSync: (p) => p === '/home/op/.codex/auth.json',
    readFileSync: () => Buffer.from('{"token":"z"}'),
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].target, '/data/creds/codex/auth.json');
});

test('collectCodexHostCreds: neither file present returns empty', () => {
  const files = collectCodexHostCreds({
    homedir: () => '/home/op',
    existsSync: () => false,
  });
  assert.deepEqual(files, []);
});
