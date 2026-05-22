import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectClaudeHostCreds,
  collectCodexHostCreds,
  formatRuntimeList,
  formatRuntimeListJson,
  listRuntimeContainers,
} from './container-init.js';
import type { DockerResult } from './runtime-container.js';

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

// ──────────────────────────────────────────────────────────────────
// container ls
// ──────────────────────────────────────────────────────────────────

test('listRuntimeContainers: fixed rows from managed docker labels', () => {
  const calls: Array<readonly string[]> = [];
  const dockerRun = (args: readonly string[]): DockerResult => {
    calls.push(args);
    if (args[0] === 'ps') {
      return ok(
        [
          JSON.stringify({
            Names: 'vicoop-runtime-claude',
            State: 'running',
            Image: 'runtime:latest',
          }),
          JSON.stringify({
            Names: 'vicoop-runtime-codex',
            State: 'exited',
            Image: 'runtime:old',
          }),
        ].join('\n'),
      );
    }
    if (args[0] === 'volume') {
      return ok(
        [
          JSON.stringify({ Name: 'vicoop-agents-claude' }),
          JSON.stringify({ Name: 'vicoop-creds-claude' }),
          JSON.stringify({ Name: 'vicoop-sessions-claude' }),
          JSON.stringify({ Name: 'vicoop-agents-codex' }),
        ].join('\n'),
      );
    }
    throw new Error(`unexpected docker args: ${args.join(' ')}`);
  };

  const rows = listRuntimeContainers({ dockerRun });

  assert.deepEqual(calls[0], [
    'ps',
    '-a',
    '--filter',
    'label=vicoop.managed-by=vicoop-bridge',
    '--filter',
    'label=vicoop.component=runtime',
    '--format',
    '{{json .}}',
  ]);
  assert.deepEqual(calls[1], [
    'volume',
    'ls',
    '--filter',
    'label=vicoop.managed-by=vicoop-bridge',
    '--filter',
    'label=vicoop.component=runtime',
    '--format',
    '{{json .}}',
  ]);
  assert.equal(rows[0].kind, 'claude');
  assert.equal(rows[0].container.state, 'running');
  assert.equal(rows[0].container.image, 'runtime:latest');
  assert.equal(rows[0].volumes.sessions.present, true);
  assert.equal(rows[1].kind, 'codex');
  assert.equal(rows[1].container.state, 'stopped');
  assert.equal(rows[1].volumes.agents.present, true);
  assert.equal(rows[1].volumes.creds.present, false);
  assert.equal(rows[1].volumes.sessions.present, false);
});

test('listRuntimeContainers: missing resources stay visible', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      assert.ok(args[0] === 'ps' || args[0] === 'volume');
      return ok('');
    },
  });

  assert.deepEqual(
    rows.map((row) => [row.kind, row.container.state, row.container.image]),
    [
      ['claude', 'missing', null],
      ['codex', 'missing', null],
    ],
  );
  assert.equal(rows.every((row) => !row.volumes.agents.present), true);
});

test('formatRuntimeList and JSON output include volume state', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      if (args[0] === 'ps') return ok('');
      return ok(JSON.stringify({ Name: 'vicoop-creds-codex' }));
    },
  });

  assert.match(formatRuntimeList(rows), /KIND\s+CONTAINER\s+IMAGE\s+AGENTS\s+CREDS\s+SESSIONS/);
  assert.match(formatRuntimeList(rows), /codex\s+missing\s+-\s+no\s+yes\s+no/);
  const parsed = JSON.parse(formatRuntimeListJson(rows));
  assert.equal(parsed[1].volumes.creds.name, 'vicoop-creds-codex');
  assert.equal(parsed[1].volumes.creds.present, true);
});

function ok(stdout = ''): DockerResult {
  return { stdout, stderr: '', exitCode: 0 };
}
