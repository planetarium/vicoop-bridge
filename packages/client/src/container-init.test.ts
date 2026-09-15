import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRuntimeList,
  formatRuntimeListJson,
  formatRuntimeRemoveJson,
  formatRuntimeRemoveResult,
  listRuntimeContainers,
  removeRuntimeContainer,
  runContainerValidateCli,
} from './container-init.js';
import type { DockerResult } from './runtime-container.js';

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

function ok(stdout = ''): DockerResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): DockerResult {
  return { stdout: '', stderr, exitCode };
}

test('container validate CLI reports success, inspect failure and unsafe boundary', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const args = {action: 'container-validate' as const, kind: 'codex' as const, name: 'work'};
  const safe = {
    Config: {User: 'node', Labels: {'vicoop.name': 'work', 'vicoop.codex-auth': 'stdio-v1'},
      Env: ['CODEX_HOME=/data/sessions/codex/config']},
    HostConfig: {NetworkMode: 'default', CapAdd: ['NET_ADMIN'], SecurityOpt: ['no-new-privileges']},
    Mounts: [
      {Type: 'volume', Name: 'vicoop-agents-work', Destination: '/data/agents/codex'},
      {Type: 'volume', Name: 'vicoop-sessions-work', Destination: '/data/sessions/codex'},
      {Type: 'tmpfs', Destination: '/data/creds/codex'},
    ],
  };
  assert.equal(await runContainerValidateCli(args, command => {
    assert.deepEqual(command, ['inspect', '--format', '{{json .}}', 'vicoop-runtime-work']);
    return ok(JSON.stringify(safe));
  }), 0);
  assert.equal(errors.length, 0);

  assert.equal(await runContainerValidateCli(args, () => fail('sensitive inspect detail')), 1);
  assert.match(errors.pop()!, /^container validate failed: Cannot inspect runtime authentication boundary$/);
  safe.Config.Env.push('OPENAI_API_KEY=sensitive-provider-key');
  assert.equal(await runContainerValidateCli(args, () => ok(JSON.stringify(safe))), 1);
  const message = errors.pop()!;
  assert.match(message, /^container validate failed: codex runtime requires host-broker migration/);
  assert.ok(!message.includes('sensitive-provider-key'));
});
