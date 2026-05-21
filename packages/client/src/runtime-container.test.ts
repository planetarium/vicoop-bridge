import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContainer, type DockerResult } from './runtime-container.js';

// Test seam fixture. Each `dockerRun` call is matched against the
// next response in the queue and pushed onto `calls` for assertion.
// Missing fixtures fall back to a successful zero-output result so
// the harness can ignore steps it doesn't care about (e.g. the
// `waitUntilRunning` poll after a successful start).
type RunResponse =
  | DockerResult
  | ((args: readonly string[]) => DockerResult);

function makeDockerFixture(responses: RunResponse[]) {
  const calls: Array<readonly string[]> = [];
  let i = 0;
  const run = (args: readonly string[]): DockerResult => {
    calls.push(args);
    const r = responses[i++] ?? ok();
    return typeof r === 'function' ? r(args) : r;
  };
  return { run, calls };
}

function ok(stdout = ''): DockerResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(stderr: string, exitCode = 1): DockerResult {
  return { stdout: '', stderr, exitCode };
}

// Helper for the "happy start" sequence shape. The image pull path
// is bypassed (ensureImage finds the image on the first inspect),
// the three volumes are inspected → created, then the container is
// inspected (absent) → created → started, then waitUntilRunning's
// first poll sees `running`. That's what most tests need; the
// negative tests override the relevant entries to inject failures.
function happyStartResponses(): RunResponse[] {
  return [
    ok('28.0.0'), // version (ensureDaemonReachable)
    ok(), // image inspect — found
    fail('volume not found', 1), // volume inspect agents
    ok(), // volume create agents
    fail('volume not found', 1), // volume inspect creds
    ok(), // volume create creds
    fail('volume not found', 1), // volume inspect sessions
    ok(), // volume create sessions
    ok(''), // ps -a --filter (no existing container)
    ok(), // create container
    ok(), // start container
    ok('running'), // waitUntilRunning poll
  ];
}

test('start: pulls nothing when image is cached, creates+starts a fresh container', async () => {
  const { run, calls } = makeDockerFixture(happyStartResponses());
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    workspaceDir: '/host/workspace',
    bridgeUrl: 'wss://bridge.example',
    dockerRun: run,
  });
  await rc.start();

  // version → image inspect → 3×volume(inspect|create) → ps → create → start → inspect-running
  assert.equal(calls.length, 12);
  assert.deepEqual(calls[0].slice(0, 2), ['version', '--format']);
  assert.deepEqual(calls[1], ['image', 'inspect', 'test/runtime:latest']);

  // Volumes created with the expected labels
  const volumeCreates = calls.filter((c) => c[0] === 'volume' && c[1] === 'create');
  assert.deepEqual(
    volumeCreates.map((c) => c[c.length - 1]).sort(),
    ['vicoop-agents-claude', 'vicoop-creds-claude', 'vicoop-sessions-claude'].sort(),
  );
  for (const v of volumeCreates) {
    assert.ok(v.includes('vicoop.kind=claude'), `label on ${v.join(' ')}`);
  }

  // Container create argv: --name, --restart unless-stopped, NET_ADMIN+RAW,
  // mounts, env, image last.
  const createCmd = calls.find((c) => c[0] === 'create');
  assert.ok(createCmd, 'create call present');
  const argv = createCmd as readonly string[];
  assert.ok(argv.includes('vicoop-runtime-claude'), 'container name');
  assert.equal(argv[argv.length - 1], 'test/runtime:latest', 'image last');
  const restartIdx = argv.indexOf('--restart');
  assert.equal(argv[restartIdx + 1], 'unless-stopped');
  assert.ok(argv.includes('NET_ADMIN'));
  assert.ok(argv.includes('NET_RAW'));
  assert.ok(
    argv.some((a) => a === 'type=bind,source=/host/workspace,target=/workspace'),
    'host workspace mounted',
  );
  assert.ok(
    argv.some((a) => a === 'type=volume,source=vicoop-creds-claude,target=/data/creds/claude'),
    'creds volume mounted',
  );
  assert.ok(
    argv.some((a) => a === 'VICOOP_BRIDGE_URL=wss://bridge.example'),
    'bridge URL forwarded',
  );

  // Start sequence
  assert.deepEqual(calls[calls.length - 2], ['start', 'vicoop-runtime-claude']);
  assert.deepEqual(calls[calls.length - 1], [
    'inspect',
    '--format',
    '{{.State.Status}}',
    'vicoop-runtime-claude',
  ]);
});

test('start: reuses an existing running container (no create, no start)', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
    ok(), // image inspect
    ok(), // volume inspect agents — present
    ok(), // volume inspect creds
    ok(), // volume inspect sessions
    ok('abc123'), // ps -a — match
    ok('true'), // inspect Running
    ok('running'), // wait poll
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    dockerRun: run,
  });
  await rc.start();

  assert.equal(
    calls.filter((c) => c[0] === 'create').length,
    0,
    'no create call',
  );
  assert.equal(
    calls.filter((c) => c[0] === 'start').length,
    0,
    'no start call',
  );
});

test('start: starts an existing stopped container', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
    ok(),
    ok(),
    ok(),
    ok(),
    ok('abc123'), // ps -a — found
    ok('false'), // inspect Running — stopped
    ok(), // start
    ok('running'), // wait
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    dockerRun: run,
  });
  await rc.start();
  assert.equal(calls.filter((c) => c[0] === 'create').length, 0);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'start'),
    [['start', 'vicoop-runtime-codex']],
  );
});

test('start: docker daemon unreachable surfaces an actionable error', async () => {
  const { run } = makeDockerFixture([
    fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 1),
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    dockerRun: run,
  });
  await assert.rejects(rc.start(), /docker daemon is not reachable/);
});

test('stop: tolerates already-stopped containers', async () => {
  const { run } = makeDockerFixture([
    fail('Error: No such container: vicoop-runtime-claude', 1),
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    dockerRun: run,
  });
  // Should not throw despite docker stop's non-zero exit.
  await rc.stop();
});

test('Env carries VICOOP_BRIDGE_URL and optional skip-firewall toggle', async () => {
  const { run, calls } = makeDockerFixture(happyStartResponses());
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    bridgeUrl: 'wss://bridge.example',
    skipFirewall: true,
    dockerRun: run,
  });
  await rc.start();
  const createCmd = calls.find((c) => c[0] === 'create') as readonly string[];
  assert.ok(createCmd.includes('VICOOP_BRIDGE_URL=wss://bridge.example'));
  assert.ok(createCmd.includes('VICOOP_SKIP_FIREWALL=1'));
});

test('getContainerName returns the canonical per-kind name', () => {
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    dockerRun: () => ok(),
  });
  assert.equal(rc.getContainerName(), 'vicoop-runtime-codex');
});
