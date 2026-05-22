import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectClaudeHostCreds,
  collectCodexHostCreds,
} from './container-init.js';

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
