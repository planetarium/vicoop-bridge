import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertContainerCredsPresent,
  collectClaudeHostCreds,
  collectCodexHostCreds,
  expectedCredsPath,
  formatRuntimeList,
  formatRuntimeListJson,
  formatRuntimeRemoveJson,
  formatRuntimeRemoveResult,
  listRuntimeContainers,
  maybeAutoLoginAfterInit,
  removeRuntimeContainer,
} from './container-init.js';
import type { DockerResult } from './runtime-container.js';
import type { Logger } from './logger.js';

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
    'ps',
    '-a',
    '--filter',
    'name=^vicoop-runtime-',
    '--format',
    '{{json .}}',
  ]);
  assert.deepEqual(calls[2], [
    'volume',
    'ls',
    '--format',
    '{{json .}}',
  ]);
  assert.equal(rows[0].kind, 'claude');
  assert.equal(rows[0].name, 'claude');
  assert.equal(rows[0].container.state, 'running');
  assert.equal(rows[0].container.image, 'runtime:latest');
  assert.equal(rows[0].volumes.sessions.present, true);
  assert.equal(rows[1].kind, 'codex');
  assert.equal(rows[1].name, 'codex');
  assert.equal(rows[1].container.state, 'stopped');
  assert.equal(rows[1].volumes.agents.present, true);
  assert.equal(rows[1].volumes.creds.present, false);
  assert.equal(rows[1].volumes.sessions.present, false);
});

test('listRuntimeContainers: no containers returns no rows', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      assert.ok(args[0] === 'ps' || args[0] === 'volume');
      return ok('');
    },
  });

  assert.deepEqual(rows, []);
});

test('listRuntimeContainers: includes unlabeled canonical containers by name', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      if (args[0] === 'ps' && args.includes('label=vicoop.managed-by=vicoop-bridge')) {
        return ok('');
      }
      if (args[0] === 'ps') {
        return ok(
          JSON.stringify({
            Names: 'vicoop-runtime-codex',
            State: 'running',
            Image: 'runtime:unlabeled',
            Labels: 'vicoop.kind=codex',
          }),
        );
      }
      return ok(
        [
          JSON.stringify({ Name: 'vicoop-agents-codex', Labels: 'vicoop.kind=codex' }),
          JSON.stringify({ Name: 'vicoop-creds-codex', Labels: 'vicoop.kind=codex' }),
          JSON.stringify({ Name: 'vicoop-sessions-codex', Labels: 'vicoop.kind=codex' }),
        ].join('\n'),
      );
    },
  });

  assert.deepEqual(
    rows.map((row) => [
      row.kind,
      row.name,
      row.container.name,
      row.container.state,
      row.container.image,
      row.volumes.agents.present,
      row.volumes.creds.present,
      row.volumes.sessions.present,
    ]),
    [
      [
        'codex',
        'codex',
        'vicoop-runtime-codex',
        'running',
        'runtime:unlabeled',
        true,
        true,
        true,
      ],
    ],
  );
});

test('formatRuntimeList and JSON output include volume state', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      if (args[0] === 'ps') {
        return ok(
          JSON.stringify({
            Names: 'vicoop-runtime-codex',
            State: 'exited',
            Image: 'runtime:latest',
            Labels: 'vicoop.kind=codex,vicoop.name=codex',
          }),
        );
      }
      return ok(
        JSON.stringify({
          Name: 'vicoop-creds-codex',
          Labels: 'vicoop.kind=codex,vicoop.name=codex',
        }),
      );
    },
  });

  assert.match(formatRuntimeList(rows), /KIND\s+NAME\s+CONTAINER\s+IMAGE\s+AGENTS\s+CREDS\s+SESSIONS/);
  assert.match(formatRuntimeList(rows), /codex\s+codex\s+stopped\s+runtime:latest\s+no\s+yes\s+no/);
  const parsed = JSON.parse(formatRuntimeListJson(rows));
  assert.equal(parsed[0].name, 'codex');
  assert.equal(parsed[0].volumes.creds.name, 'vicoop-creds-codex');
  assert.equal(parsed[0].volumes.creds.present, true);
});

test('listRuntimeContainers: volume-only leftovers do not create rows', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      if (args[0] === 'ps') return ok('');
      return ok(
        JSON.stringify({
          Name: 'vicoop-creds-codex-work',
          Labels: 'vicoop.kind=codex,vicoop.name=work',
        }),
      );
    },
  });

  assert.deepEqual(rows, []);
  assert.equal(formatRuntimeList(rows), 'KIND  NAME  CONTAINER  IMAGE  AGENTS  CREDS  SESSIONS');
  assert.equal(formatRuntimeListJson(rows), '[]');
});

test('listRuntimeContainers: includes named runtime instances discovered from labels', () => {
  const rows = listRuntimeContainers({
    dockerRun: (args) => {
      if (args[0] === 'ps') {
        return ok(
          JSON.stringify({
            Names: 'vicoop-runtime-work',
            State: 'running',
            Image: 'runtime:named',
            Labels: 'vicoop.kind=codex,vicoop.name=work',
          }),
        );
      }
      return ok(
        [
          JSON.stringify({
            Name: 'vicoop-agents-work',
            Labels: 'vicoop.kind=codex,vicoop.name=work',
          }),
          JSON.stringify({
            Name: 'vicoop-creds-work',
            Labels: 'vicoop.kind=codex,vicoop.name=work',
          }),
        ].join('\n'),
      );
    },
  });

  assert.deepEqual(
    rows.map((row) => [row.kind, row.name, row.container.name, row.container.state]),
    [['codex', 'work', 'vicoop-runtime-work', 'running']],
  );
  const named = rows[0];
  assert.equal(named.volumes.agents.present, true);
  assert.equal(named.volumes.creds.present, true);
  assert.equal(named.volumes.sessions.name, 'vicoop-sessions-work');
  assert.equal(named.volumes.sessions.present, false);
});

// ──────────────────────────────────────────────────────────────────
// container rm
// ──────────────────────────────────────────────────────────────────

test('removeRuntimeContainer: removes container and volumes by default', () => {
  const calls: Array<readonly string[]> = [];
  const result = removeRuntimeContainer({
    name: 'work',
    preserveVolumes: false,
    dockerRun: (args) => {
      calls.push(args);
      return ok('');
    },
  });

  assert.deepEqual(calls, [
    [
      'ps',
      '-a',
      '--filter',
      'label=vicoop.managed-by=vicoop-bridge',
      '--filter',
      'label=vicoop.component=runtime',
      '--format',
      '{{json .}}',
    ],
    ['ps', '-a', '--filter', 'name=^vicoop-runtime-', '--format', '{{json .}}'],
    ['volume', 'ls', '--format', '{{json .}}'],
    ['rm', '-f', 'vicoop-runtime-work'],
    ['volume', 'rm', 'vicoop-agents-work'],
    ['volume', 'rm', 'vicoop-creds-work'],
    ['volume', 'rm', 'vicoop-sessions-work'],
  ]);
  assert.equal(result.container.removed, true);
  assert.equal(result.name, 'work');
  assert.deepEqual(
    result.volumes.map((v) => [v.name, v.removed, v.skipped]),
    [
      ['vicoop-agents-work', true, false],
      ['vicoop-creds-work', true, false],
      ['vicoop-sessions-work', true, false],
    ],
  );
  assert.match(formatRuntimeRemoveResult(result), /removed volume vicoop-agents-work/);
});

test('removeRuntimeContainer: --preserve-volumes keeps all canonical volumes', () => {
  const calls: Array<readonly string[]> = [];
  const result = removeRuntimeContainer({
    name: 'codex',
    preserveVolumes: true,
    dockerRun: (args) => {
      calls.push(args);
      return ok('');
    },
  });

  assert.deepEqual(calls, [
    [
      'ps',
      '-a',
      '--filter',
      'label=vicoop.managed-by=vicoop-bridge',
      '--filter',
      'label=vicoop.component=runtime',
      '--format',
      '{{json .}}',
    ],
    ['ps', '-a', '--filter', 'name=^vicoop-runtime-', '--format', '{{json .}}'],
    ['volume', 'ls', '--format', '{{json .}}'],
    ['rm', '-f', 'vicoop-runtime-codex'],
  ]);
  assert.equal(result.volumes.every((v) => !v.removed && v.skipped), true);
  assert.match(formatRuntimeRemoveResult(result), /kept volumes/);
});

test('removeRuntimeContainer: missing resources are reported without throwing', () => {
  const result = removeRuntimeContainer({
    name: 'claude',
    preserveVolumes: false,
    dockerRun: (args) => {
      if (args[0] === 'ps' || (args[0] === 'volume' && args[1] === 'ls')) return ok('');
      return fail('Error: No such container or volume', 1);
    },
  });

  assert.equal(result.container.removed, false);
  assert.equal(result.volumes.every((v) => !v.removed && !v.skipped), true);
  const parsed = JSON.parse(formatRuntimeRemoveJson(result));
  assert.equal(parsed.container.name, 'vicoop-runtime-claude');
  assert.equal(parsed.container.removed, false);
});

test('removeRuntimeContainer: docker can report missing resources on stdout with exit 0', () => {
  const result = removeRuntimeContainer({
    name: 'claude',
    preserveVolumes: false,
    dockerRun: (args) => {
      if (args[0] === 'ps' || (args[0] === 'volume' && args[1] === 'ls')) return ok('');
      return ok('Error response from daemon: No such container: vicoop-runtime-claude');
    },
  });

  assert.equal(result.container.removed, false);
  assert.equal(result.volumes.every((v) => !v.removed && !v.skipped), true);
});

test('removeRuntimeContainer: unexpected docker failures throw', () => {
  assert.throws(
    () =>
      removeRuntimeContainer({
        name: 'codex',
        preserveVolumes: true,
        dockerRun: (args) => {
          if (args[0] === 'ps' || (args[0] === 'volume' && args[1] === 'ls')) return ok('');
          return fail('permission denied', 1);
        },
      }),
    /docker rm -f vicoop-runtime-codex failed/,
  );
});

// ──────────────────────────────────────────────────────────────────
// assertContainerCredsPresent — daemon-startup fail-fast probe
// ──────────────────────────────────────────────────────────────────

test('assertContainerCredsPresent: claude path probes /data/creds/claude/.credentials.json', async () => {
  const calls: Array<readonly string[]> = [];
  await assertContainerCredsPresent('vicoop-runtime-claude', 'claude', {
    dockerRun: (args) => {
      calls.push(args);
      return ok('');
    },
  });
  assert.deepEqual(calls, [[
    'exec',
    'vicoop-runtime-claude',
    'test',
    '-f',
    '/data/creds/claude/.credentials.json',
  ]]);
});

test('assertContainerCredsPresent: codex path probes /data/creds/codex/auth.json', async () => {
  const calls: Array<readonly string[]> = [];
  await assertContainerCredsPresent('vicoop-runtime-codex', 'codex', {
    dockerRun: (args) => {
      calls.push(args);
      return ok('');
    },
  });
  assert.deepEqual(calls[0], [
    'exec',
    'vicoop-runtime-codex',
    'test',
    '-f',
    '/data/creds/codex/auth.json',
  ]);
});

test('assertContainerCredsPresent: throws with auth-command hint when probe fails', async () => {
  await assert.rejects(
    () =>
      assertContainerCredsPresent('vicoop-runtime-claude', 'claude', {
        dockerRun: () => fail('', 1),
      }),
    (err: Error) => {
      assert.match(err.message, /no claude creds at \/data\/creds\/claude\/\.credentials\.json/);
      assert.match(err.message, /docker exec -it vicoop-runtime-claude claude setup-token/);
      return true;
    },
  );
});

test('assertContainerCredsPresent: codex hint uses codex login --device-auth', async () => {
  await assert.rejects(
    () =>
      assertContainerCredsPresent('vicoop-runtime-codex', 'codex', {
        dockerRun: () => fail('', 1),
      }),
    /docker exec -it vicoop-runtime-codex codex login --device-auth/,
  );
});

test('expectedCredsPath: stable canonical paths per kind', () => {
  assert.equal(expectedCredsPath('claude'), '/data/creds/claude/.credentials.json');
  assert.equal(expectedCredsPath('codex'), '/data/creds/codex/auth.json');
});

// ──────────────────────────────────────────────────────────────────
// maybeAutoLoginAfterInit — TTY-gated interactive auth at init time
// ──────────────────────────────────────────────────────────────────

test('maybeAutoLoginAfterInit: TTY off skips interactive auth and prints docker-exec hint', async () => {
  const log = recordingLogger();
  const argvs: Array<readonly string[]> = [];
  const result = await maybeAutoLoginAfterInit('vicoop-runtime-claude', 'claude', log, {
    isTTY: () => false,
    runDockerInteractive: async (argv) => {
      argvs.push(argv);
      return 0;
    },
  });
  assert.deepEqual(result, { attempted: false, exitCode: 0 });
  assert.deepEqual(argvs, []);
  const infos = log.entries.filter((e) => e.level === 'info').map((e) => e.msg);
  assert.ok(infos.some((m) => /not a TTY/.test(m)));
  assert.ok(infos.some((m) => /claude setup-token/.test(m)));
});

test('maybeAutoLoginAfterInit: TTY on runs claude auth via docker exec -it', async () => {
  const log = recordingLogger();
  let captured: readonly string[] | null = null;
  const result = await maybeAutoLoginAfterInit('vicoop-runtime-claude', 'claude', log, {
    isTTY: () => true,
    runDockerInteractive: async (argv) => {
      captured = argv;
      return 0;
    },
  });
  assert.deepEqual(result, { attempted: true, exitCode: 0 });
  assert.deepEqual(captured, [
    'exec',
    '-it',
    'vicoop-runtime-claude',
    'claude',
    'setup-token',
  ]);
});

test('maybeAutoLoginAfterInit: TTY on runs codex auth with --device-auth', async () => {
  const log = recordingLogger();
  let captured: readonly string[] | null = null;
  await maybeAutoLoginAfterInit('vicoop-runtime-codex', 'codex', log, {
    isTTY: () => true,
    runDockerInteractive: async (argv) => {
      captured = argv;
      return 0;
    },
  });
  assert.deepEqual(captured, [
    'exec',
    '-it',
    'vicoop-runtime-codex',
    'codex',
    'login',
    '--device-auth',
  ]);
});

test('maybeAutoLoginAfterInit: failed interactive auth returns exitCode 1 and surfaces retry hint', async () => {
  const log = recordingLogger();
  const result = await maybeAutoLoginAfterInit('vicoop-runtime-claude', 'claude', log, {
    isTTY: () => true,
    runDockerInteractive: async () => 130,
  });
  assert.deepEqual(result, { attempted: true, exitCode: 1 });
  const errors = log.entries.filter((e) => e.level === 'error').map((e) => e.msg);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /interactive auth exited with code 130/);
  assert.match(errors[0], /docker exec -it vicoop-runtime-claude claude setup-token/);
  assert.match(errors[0], /left in place/);
});

function recordingLogger(): Logger & {
  entries: Array<{ level: 'error' | 'warn' | 'info' | 'debug'; msg: string }>;
} {
  const entries: Array<{ level: 'error' | 'warn' | 'info' | 'debug'; msg: string }> = [];
  const join = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return {
    level: 'debug',
    error: (...args) => entries.push({ level: 'error', msg: join(args) }),
    warn: (...args) => entries.push({ level: 'warn', msg: join(args) }),
    info: (...args) => entries.push({ level: 'info', msg: join(args) }),
    debug: (...args) => entries.push({ level: 'debug', msg: join(args) }),
    entries,
  };
}

function ok(stdout = ''): DockerResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): DockerResult {
  return { stdout: '', stderr, exitCode };
}
