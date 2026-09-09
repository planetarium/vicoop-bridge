import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContainer, type DockerResult } from './runtime-container.js';

// Runtime lifecycle fixtures include the Codex broker boundary.
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
    if(args.includes('{{json .}}')) {
      const name=args.at(-1)!.replace('vicoop-runtime-','');
      return ok(JSON.stringify({Config:{User:'node',Labels:{'vicoop.kind':'codex','vicoop.codex-auth':'stdio-v1','vicoop.name':name},Env:['CODEX_HOME=/data/sessions/codex/config']},HostConfig:{NetworkMode:'default',CapAdd:['NET_ADMIN','NET_RAW'],SecurityOpt:['no-new-privileges']},Mounts:[...[{Type:'volume',Name:'vicoop-agents-'+(name),Destination:'/data/agents/codex'},{Type:'volume',Name:'vicoop-sessions-'+(name),Destination:'/data/sessions/codex'},{Type:'tmpfs',Destination:'/data/creds/codex'}], ...calls.filter(c=>c[0]==='create').flatMap(c=>c.filter(a=>a.startsWith('type=bind,source=')).map(a=>({Type:'bind',Source:a.slice('type=bind,source='.length).split(',target=')[0],Destination:'/workspace'})))]}));
    }
    if(args[0]==='exec' && args.includes('/bin/sh')) return ok();
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

// Helper for the container-init creation sequence shape. The image
// pull path is bypassed (ensureImage finds the image on the first
// inspect), the three volumes are inspected → created, then the
// container is inspected (absent) → created → started, then
// waitUntilRunning's first poll sees `running`.
function happyCreateResponses(): RunResponse[] {
  return [
    ok('28.0.0'), // version (ensureDaemonReachable)
    ok(''), // ps -a --filter (no existing container)
    ok(), // image inspect — found
    fail('volume not found', 1), // volume inspect agents
    ok(), // volume create agents
    fail('volume not found', 1), // volume inspect sessions
    ok(), // volume create sessions
    ok(), // create container
    ok(), // start container
    ok('running'), // waitUntilRunning poll
  ];
}

test('start: with createIfMissing pulls nothing when image is cached, creates+starts a fresh container', async () => {
  const { run, calls } = makeDockerFixture(happyCreateResponses());
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    workspaceDir: '/host/workspace',
    bridgeUrl: 'wss://bridge.example',
    createIfMissing: true,
    dockerRun: run,
  });
  await rc.start();

  // version → ps → image inspect → 3×volume(inspect|create) → create → start → inspect-running
  assert.equal(calls.length, 12);
  assert.deepEqual(calls[0].slice(0, 2), ['version', '--format']);
  assert.deepEqual(calls[1].slice(0, 2), ['ps', '-a']);
  assert.deepEqual(calls[2], ['image', 'inspect', 'test/runtime:latest']);

  // Volumes created with the expected labels
  const volumeCreates = calls.filter((c) => c[0] === 'volume' && c[1] === 'create');
  assert.deepEqual(
    volumeCreates.map((c) => c[c.length - 1]).sort(),
    ['vicoop-agents-codex', 'vicoop-sessions-codex'].sort(),
  );
  for (const v of volumeCreates) {
    assert.ok(v.includes('vicoop.kind=codex'), `label on ${v.join(' ')}`);
    assert.ok(v.includes('vicoop.managed-by=vicoop-bridge'), `managed label on ${v.join(' ')}`);
    assert.ok(v.includes('vicoop.component=runtime'), `component label on ${v.join(' ')}`);
    assert.ok(v.includes('vicoop.name=codex'), `instance label on ${v.join(' ')}`);
  }

  // Container create argv: --name, --restart unless-stopped, NET_ADMIN+RAW,
  // mounts, env, image last.
  const createCmd = calls.find((c) => c[0] === 'create');
  assert.ok(createCmd, 'create call present');
  const argv = createCmd as readonly string[];
  assert.ok(argv.includes('vicoop-runtime-codex'), 'container name');
  assert.equal(argv[argv.length - 1], 'test/runtime:latest', 'image last');
  const restartIdx = argv.indexOf('--restart');
  assert.equal(argv[restartIdx + 1], 'unless-stopped');
  assert.ok(argv.includes('NET_ADMIN'));
  assert.ok(argv.includes('NET_RAW'));
  assert.ok(argv.includes('vicoop.managed-by=vicoop-bridge'));
  assert.ok(argv.includes('vicoop.component=runtime'));
  assert.ok(argv.includes('vicoop.kind=codex'));
  assert.ok(argv.includes('vicoop.name=codex'));
  assert.ok(
    argv.some((a) => a === 'type=bind,source=/host/workspace,target=/workspace'),
    'host workspace mounted',
  );
  assert.ok(
    !argv.some((a) => a.includes('source=vicoop-creds-')),
    'creds volume must not be mounted',
  );
  assert.ok(
    argv.some((a) => a === 'VICOOP_BRIDGE_URL=wss://bridge.example'),
    'bridge URL forwarded',
  );

  // Start sequence
  assert.deepEqual(calls[calls.length - 4], ['start', 'vicoop-runtime-codex']);
  assert.deepEqual(calls[calls.length - 3], [
    'inspect',
    '--format',
    '{{.State.Status}}',
    'vicoop-runtime-codex',
  ]);
});

test('start: reuses an existing running container (no create, no start)', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
    ok('abc123'), // ps -a — match
    ok('true'), // inspect Running
    ok('running'), // wait poll
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
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

test('start: failIfExists rejects an existing container during init', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
    ok('abc123'), // ps -a — match
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    runtimeName: 'work',
    image: 'test/runtime:latest',
    createIfMissing: true,
    failIfExists: true,
    dockerRun: run,
  });

  await assert.rejects(
    rc.start(),
    /runtime container 'vicoop-runtime-work' already exists.*container rm work/s,
  );
  assert.equal(calls.filter((c) => c[0] === 'start').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'create').length, 0);
});

test('start: failIfExists rejects existing volumes before creating a container', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
    ok(''), // ps -a — no container
    fail('volume not found', 1), // agents absent
    ok(), // sessions exists
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    createIfMissing: true,
    failIfExists: true,
    dockerRun: run,
  });

  await assert.rejects(
    rc.start(),
    /runtime volumes already exist: vicoop-sessions-codex.*container rm codex/s,
  );
  assert.equal(calls.filter((c) => c[0] === 'image').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'create').length, 0);
});

test('start: starts an existing stopped container', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
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

test('start: missing container is a hard error unless createIfMissing is set', async () => {
  const { run, calls } = makeDockerFixture([
    ok('28.0.0'),
    ok(''), // ps -a — absent
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    dockerRun: run,
  });

  await assert.rejects(
    rc.start(),
    /runtime container 'vicoop-runtime-codex' does not exist.*vicoop-client container init codex/s,
  );
  assert.equal(calls.filter((c) => c[0] === 'create').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'volume').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'image').length, 0);
});

test('start: docker daemon unreachable surfaces an actionable error', async () => {
  const { run } = makeDockerFixture([
    fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 1),
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    dockerRun: run,
  });
  await assert.rejects(rc.start(), /docker daemon is not reachable/);
});

test('stop: tolerates already-stopped containers', async () => {
  const { run, calls } = makeDockerFixture([...happyCreateResponses(),
    fail('Error: No such container: vicoop-runtime-codex', 1),
  ]);
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    createIfMissing: true,
    dockerRun: run,
  });
  await rc.start();
  // Should not throw despite docker stop's non-zero exit.
  await rc.stop();
  assert.ok(calls.some(args => args[0] === 'stop'));
});

test('Env carries VICOOP_BRIDGE_URL and optional skip-firewall toggle', async () => {
  const { run, calls } = makeDockerFixture(happyCreateResponses());
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    bridgeUrl: 'wss://bridge.example',
    skipFirewall: true,
    createIfMissing: true,
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

test('runtimeName selects container and volume names', async () => {
  const { run, calls } = makeDockerFixture(happyCreateResponses());
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    runtimeName: 'work',
    image: 'test/runtime:latest',
    createIfMissing: true,
    dockerRun: run,
  });
  await rc.start();

  assert.equal(rc.getContainerName(), 'vicoop-runtime-work');
  const volumeCreates = calls.filter((c) => c[0] === 'volume' && c[1] === 'create');
  assert.deepEqual(
    volumeCreates.map((c) => c[c.length - 1]).sort(),
    [
      'vicoop-agents-work',
      'vicoop-sessions-work',
    ].sort(),
  );
  assert.equal(volumeCreates.every((c) => c.includes('vicoop.name=work')), true);
  const createCmd = calls.find((c) => c[0] === 'create') as readonly string[];
  assert.ok(createCmd.includes('vicoop-runtime-work'));
  assert.ok(createCmd.includes('vicoop.name=work'));
  assert.ok(
    createCmd.includes('CODEX_HOME=/data/sessions/codex/config'),
  );
});

for (const reason of ['never-started', 'exists', 'unsafe-boundary']) {
  test(`cleanup does not stop a runtime that was not acquired: ${reason}`, async () => {
    const calls: string[][] = [];
    const runtime = new RuntimeContainer({backendKind: 'codex', failIfExists: reason === 'exists',
      dockerRun(args) {
        calls.push([...args]);
        return ok(args[0] === 'version' ? '28' : args[0] === 'ps' ? 'existing-container' : '{}');
      },
    });
    if (reason !== 'never-started') await assert.rejects(runtime.start());
    await runtime.stop();
    assert.ok(!calls.some(args => args[0] === 'stop' || args[0] === 'start' || args[0] === 'exec'));
  });
}

test('cleanup stops an acquired runtime if firewall installation fails', async () => {
  const calls: string[][] = [];
  const runtime = new RuntimeContainer({backendKind: 'codex', dockerRun(args) {
    calls.push([...args]);
    if (args[0] === 'exec') return fail('firewall failed');
    if (args.includes('{{json .}}')) return ok(JSON.stringify({Config:{User:'node',Labels:{'vicoop.kind':'codex','vicoop.codex-auth':'stdio-v1','vicoop.name':'codex'},Env:['CODEX_HOME=/data/sessions/codex/config']},HostConfig:{NetworkMode:'default',CapAdd:['NET_ADMIN'],SecurityOpt:['no-new-privileges']},Mounts:[{Type:'volume',Name:'vicoop-agents-'+('codex'),Destination:'/data/agents/codex'},{Type:'volume',Name:'vicoop-sessions-'+('codex'),Destination:'/data/sessions/codex'},{Type:'tmpfs',Destination:'/data/creds/codex'}]}));
    return ok(args[0] === 'version' ? '28' : args[0] === 'ps' ? 'existing-container' : 'running');
  }});
  await assert.rejects(runtime.start(), /firewall failed/);
  await runtime.stop();
  assert.equal(calls.filter(args => args[0] === 'stop').length, 1);
});

test('shutdown leaves an already-running reused runtime running', async () => {
  const {run, calls} = makeDockerFixture([ok('28'), ok('existing'), ok('true'), ok('running')]);
  const runtime = new RuntimeContainer({backendKind: 'codex', dockerRun: run});
  await runtime.start();
  await runtime.stop();
  assert.ok(!calls.some(args => args[0] === 'start' || args[0] === 'stop'));
});

test('startup readiness failure releases the runtime started by this lifecycle', async () => {
  const {run, calls} = makeDockerFixture([ok('28'), ok('existing'), ok('false'), ok(), ok('exited'), ok()]);
  const runtime = new RuntimeContainer({backendKind: 'codex', dockerRun: run});
  await assert.rejects(runtime.start(), /exited/);
  assert.equal(calls.filter(args => args[0] === 'stop').length, 1);
  await runtime.stop();
  assert.equal(calls.filter(args => args[0] === 'stop').length, 1);
});

test('reuse rejects a missing or different workspace before starting or executing', async () => {
  for (const source of [undefined, '/projectA']) {
    const fixture = makeDockerFixture([ok('28'), ok('existing')]);
    const runtime = new RuntimeContainer({backendKind: 'codex', workspaceDir: '/projectB',
      dockerRun(args) {
        const result = fixture.run(args);
        if (!args.includes('{{json .}}')) return result;
        const c = JSON.parse(result.stdout);
        if (source) c.Mounts.push({Type: 'bind', Source: source, Destination: '/workspace'});
        return ok(JSON.stringify(c));
      },
    });
    await assert.rejects(runtime.start(), /workspace/);
    assert.ok(!fixture.calls.some(args => ['start', 'stop', 'exec'].includes(args[0])));
  }
});

test('start awaits asynchronous Docker results including bounded streamed image pull', async () => {
  const calls: Array<{ args: readonly string[]; options: unknown }> = [];
  const responses = happyCreateResponses();
  responses.splice(2, 1, fail('image missing'), ok());
  const fixture = makeDockerFixture(responses);
  const runtime = new RuntimeContainer({
    backendKind: 'claude', createIfMissing: true,
    dockerRun: async (args, options) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      calls.push({ args, options });
      return fixture.run(args);
    },
  });
  await runtime.start();
  assert.deepEqual(calls.find((call) => call.args[0] === 'pull')?.options, {
    inheritOutput: true, timeoutMs: 600_000,
  });
  await runtime.stop();
  assert.equal(calls.at(-1)?.args[0], 'stop');
});

test('failed image pull aborts creation before touching volumes', async () => {
  const fixture = makeDockerFixture([ok('27'), ok(), fail('missing image'), fail('pull failed')]);
  const runtime = new RuntimeContainer({ backendKind: 'claude', createIfMissing: true, dockerRun: fixture.run });
  await assert.rejects(runtime.start(), /docker pull/);
  assert.equal(fixture.calls.some((args) => args[0] === 'volume' || args[0] === 'create'), false);
});
