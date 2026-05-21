import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RuntimeContainer } from './runtime-container.js';

// Minimal dockerode-compatible stub. Records what was called so the
// tests can assert lifecycle behavior (volumes ensured, container
// created, restart policy / mounts set) without a live daemon.
function makeDockerStub(opts: {
  ping?: () => Promise<void>;
  // Initial set of pre-existing container names (no leading `/`).
  containers?: string[];
  // Initial set of pre-existing image names.
  images?: string[];
  // Whether the existing container is reported as Running. Used by
  // start() to decide between start vs reuse-as-is.
  containerRunning?: boolean;
}) {
  const created: Array<Record<string, unknown>> = [];
  const startedContainers: string[] = [];
  const stoppedContainers: string[] = [];
  const ensuredVolumes: string[] = [];
  const pulledImages: string[] = [];
  const images = new Set(opts.images ?? []);
  const containers = new Map<string, { name: string; running: boolean }>();
  for (const name of opts.containers ?? []) {
    containers.set(name, { name, running: opts.containerRunning ?? false });
  }

  const modem = {
    followProgress(_stream: unknown, done: (err: Error | null) => void): void {
      // We never feed real layer events into stream; tests don't care
      // about progress reporting, only that the pull resolves.
      done(null);
    },
  };

  const docker = {
    modem,
    ping: opts.ping ?? (async () => {}),
    getImage(name: string) {
      return {
        inspect: async () => {
          if (!images.has(name)) {
            const err = new Error(`no such image: ${name}`) as Error & {
              statusCode: number;
            };
            err.statusCode = 404;
            throw err;
          }
          return {};
        },
      };
    },
    pull(name: string, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) {
      pulledImages.push(name);
      images.add(name);
      const stream = new PassThrough();
      cb(null, stream);
      stream.end();
    },
    getVolume(name: string) {
      return {
        inspect: async () => {
          if (!ensuredVolumes.includes(name)) {
            const err = new Error(`no such volume: ${name}`) as Error & {
              statusCode: number;
            };
            err.statusCode = 404;
            throw err;
          }
          return { Name: name };
        },
      };
    },
    async createVolume(opts: { Name: string }) {
      ensuredVolumes.push(opts.Name);
      return { Name: opts.Name };
    },
    async listContainers(_opts: unknown): Promise<Array<{ Id: string; Names: string[] }>> {
      return Array.from(containers.values()).map((c) => ({
        Id: c.name,
        Names: [`/${c.name}`],
      }));
    },
    async createContainer(spec: Record<string, unknown> & { name: string }) {
      created.push(spec);
      containers.set(spec.name, { name: spec.name, running: false });
      return makeContainerStub(spec.name);
    },
    getContainer(id: string) {
      return makeContainerStub(id);
    },
  };

  function makeContainerStub(id: string) {
    return {
      id,
      async inspect() {
        const entry = containers.get(id);
        return { State: { Running: entry?.running ?? false, Status: entry?.running ? 'running' : 'created' } };
      },
      async start() {
        startedContainers.push(id);
        const entry = containers.get(id);
        if (entry) entry.running = true;
      },
      async stop(_opts?: { t?: number }) {
        stoppedContainers.push(id);
        const entry = containers.get(id);
        if (entry) entry.running = false;
      },
      async exec(_spec: unknown) {
        return new EventEmitter();
      },
    };
  }

  return { docker, created, startedContainers, stoppedContainers, ensuredVolumes, pulledImages };
}

test('start: pulls image, ensures volumes, creates+starts a fresh container', async () => {
  const stub = makeDockerStub({});
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    workspaceDir: '/host/workspace',
    bridgeUrl: 'wss://bridge.example',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docker: stub.docker as any,
  });
  await rc.start();
  assert.deepEqual(stub.pulledImages, ['test/runtime:latest']);
  assert.deepEqual(
    stub.ensuredVolumes.sort(),
    ['vicoop-agents-claude', 'vicoop-creds-claude', 'vicoop-sessions-claude'].sort(),
  );
  assert.equal(stub.created.length, 1);
  assert.equal(stub.created[0].name, 'vicoop-runtime-claude');
  const hostConfig = stub.created[0].HostConfig as {
    Binds: string[];
    RestartPolicy: { Name: string };
    CapAdd: string[];
  };
  assert.equal(hostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.deepEqual(hostConfig.CapAdd, ['NET_ADMIN', 'NET_RAW']);
  assert.ok(hostConfig.Binds.some((b) => b === '/host/workspace:/workspace'));
  assert.ok(hostConfig.Binds.some((b) => b === 'vicoop-creds-claude:/data/creds/claude'));
  assert.ok(hostConfig.Binds.some((b) => b === 'vicoop-sessions-claude:/data/sessions/claude'));
  assert.deepEqual(stub.startedContainers, ['vicoop-runtime-claude']);
});

test('start: reuses an existing running container (no create, no start)', async () => {
  const stub = makeDockerStub({
    containers: ['vicoop-runtime-claude'],
    containerRunning: true,
    images: ['test/runtime:latest'],
  });
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docker: stub.docker as any,
  });
  await rc.start();
  assert.equal(stub.created.length, 0);
  assert.equal(stub.startedContainers.length, 0);
});

test('start: starts an existing stopped container', async () => {
  const stub = makeDockerStub({
    containers: ['vicoop-runtime-codex'],
    containerRunning: false,
    images: ['test/runtime:latest'],
  });
  const rc = new RuntimeContainer({
    backendKind: 'codex',
    image: 'test/runtime:latest',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docker: stub.docker as any,
  });
  await rc.start();
  assert.equal(stub.created.length, 0);
  assert.deepEqual(stub.startedContainers, ['vicoop-runtime-codex']);
});

test('start: docker ping failure surfaces an actionable error', async () => {
  const stub = makeDockerStub({
    ping: async () => {
      throw new Error('connect ENOENT /var/run/docker.sock');
    },
  });
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docker: stub.docker as any,
  });
  await assert.rejects(rc.start(), /docker daemon is not reachable/);
});

test('stop: calls container.stop and tolerates 304 already-stopped', async () => {
  const stub = makeDockerStub({
    containers: ['vicoop-runtime-claude'],
    containerRunning: true,
    images: ['test/runtime:latest'],
  });
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docker: stub.docker as any,
  });
  await rc.start();
  await rc.stop();
  assert.deepEqual(stub.stoppedContainers, ['vicoop-runtime-claude']);
});

test('Env carries VICOOP_BRIDGE_URL and optional skip-firewall toggle', async () => {
  const stub = makeDockerStub({});
  const rc = new RuntimeContainer({
    backendKind: 'claude',
    image: 'test/runtime:latest',
    bridgeUrl: 'wss://bridge.example',
    skipFirewall: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docker: stub.docker as any,
  });
  await rc.start();
  const env = (stub.created[0].Env ?? []) as string[];
  assert.ok(env.includes('VICOOP_BRIDGE_URL=wss://bridge.example'));
  assert.ok(env.includes('VICOOP_SKIP_FIREWALL=1'));
});
