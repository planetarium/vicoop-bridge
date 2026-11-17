import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { DockerCallerRuntimePool, CALLER_TMPFS, CallerAllocationIncompleteError } from './caller-runtime-docker.js';
import { CallerDockerError } from './caller-runtime-diagnostics.js';
import { scopeDigest } from './caller-runtime-store.js';
import type { AsyncDockerRun } from './docker-command.js';

test('network exhaustion preserves retained callers and storage; only explicit validated recovery resumes allocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'caller-network-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: directory });
  let exhausted = false;
  const containers = new Map<string, any>(),
    volumes = new Map<string, any>(),
    networks = new Map<string, any>();

  const calls: string[][] = [];
  const success = (value: unknown = "") => ({
    exitCode: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  });
  const absent = (kind: string) => ({
    exitCode: 1,
    stdout: "",
    stderr: `No such ${kind}`,
  });
  const run: AsyncDockerRun = async (args) => {
    calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'create' && exhausted)
      return { exitCode: 1, stdout: '', stderr: 'Error response from daemon: all predefined address pools have been fully subnetted' };
    const flags = (flag: string) =>
      args.flatMap((v, i) => (v === flag ? [args[i + 1]] : []));
    const labels = () =>
      Object.fromEntries(flags("--label").map((v) => v.split("=")));
    if (args[0] === "context") return success(JSON.stringify('unix:///local-docker.sock'));
    if (args[0] === "info") return success('linux');
    if (args[0] === "image") return success([{ Config: {} }]);
    if (args[0] === "ps") {
      const filter = flags("--filter")[0];
      return success(
        [...containers.values()]
          .filter((c) =>
            filter.startsWith("volume=")
              ? c.Mounts.some((m: any) => m.Name === filter.slice(7))
              : true
          )
          .map((c) => (filter.startsWith("volume=") ? c.Id : c.Name))
          .join("\n")
      );
    }
    if (args[0] === "volume" || args[0] === "network") {
      const map = args[0] === "volume" ? volumes : networks;
      if (args[1] === "inspect")
        return map.has(args[2]) ? success([map.get(args[2])]) : absent(args[0]);
      if (args[1] === "rm") {
        map.delete(args[2]);
        return success();
      }
      if (args[1] === "create") {
        const name = args.at(-1)!;
        map.set(name, {
          Name: name,
          Id: name,
          Driver: args[0] === "volume" ? "local" : "bridge",
          Scope: "local",
          Options: {},
          Labels: labels(),
          Containers: {},
        });
        return success();
      }
    }
    if (args[0] === "container")
      return containers.has(args[2])
        ? success([containers.get(args[2])])
        : absent("container");
    if (args[0] === "create") {
      const name = flags("--name")[0],
        network = flags("--network")[0];
      const mounts = flags("--mount").map((value) =>
        Object.fromEntries(
          value
            .split(",")
            .map((part) =>
              part.includes("=") ? part.split("=") : [part, true]
            )
        )
      );
      containers.set(name, {
        Name: name,
        Id: name,
        Image: options.image,
        State: { Running: false },
        Config: {
          Labels: labels(),
          User: "1000:1000",
          Entrypoint: ["/usr/bin/tini"],
          Cmd: ["--", "/bin/sleep", "infinity"],
          Env: flags("--env"),
        },
        NetworkSettings: { Networks: { [network]: { NetworkID: network } } },
        HostConfig: {
          ReadonlyRootfs: true,
          NetworkMode: network,
          RestartPolicy: { Name: "no" },
          SecurityOpt: ["no-new-privileges"],
          CapAdd: ["NET_ADMIN"],
          Memory: options.memoryMiB * 1048576,
          MemorySwap: options.memoryMiB * 1048576,
          PidsLimit: options.pids,
          NanoCpus: options.cpus * 1e9,
          Tmpfs: CALLER_TMPFS,
          Mounts: mounts.map((m) => ({
            Type: m.type,
            Source: m.source,
            Target: m.target,
            ReadOnly: !!m.readonly,
            ...(m.type === 'volume' ? { VolumeOptions: { NoCopy: !!m["volume-nocopy"] } } : {
              BindOptions: { NonRecursive: m['bind-recursive'] === 'disabled', Propagation: m['bind-propagation'] },
            }),
          })),
        },
        Mounts: mounts.map((m) => ({
          Type: m.type,
          Name: m.type === 'volume' ? m.source : undefined,
          Source: m.source,
          Propagation: m['bind-propagation'],
          Destination: m.target,
          RW: !m.readonly,
        })),
      });
      return success();
    }
    if (args[0] === "start" || args[0] === "stop") {
      containers.get(args.at(-1)!).State.Running = args[0] === "start";
      return success();
    }
    if (args[0] === "rm") {
      containers.delete(args[1]);
      return success();
    }
    if (args[0] === "exec")
      return success(
        args.includes("/usr/bin/du")
          ? "0 /workspace\n0 /data/sessions/claude"
          : ""
      );
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };

  const make = () => new DockerCallerRuntimePool('claude', options, 'agent', run);
  let pool = make();
  await pool.initialize();
  const alice = scopeDigest('agent', 'alice'), bob = scopeDigest('agent', 'bob');
  await pool.acquire(alice, undefined, 'alice');
  const aliceContainer = structuredClone(containers.get(pool.name(alice)));
  exhausted = true;
  await assert.rejects(pool.acquire(bob, undefined, 'bob'), error => {
    assert.ok(error instanceof CallerDockerError);
    assert.equal(error.code, 'docker_address_pool_exhausted');
    assert.equal(error.operation, 'network create');
    assert.equal(error.exitCode, 1);
    return true;
  });
  await pool.stop(bob);
  assert.equal(await pool.store.allocationComplete(bob), false);
  assert.equal((await pool.describe(bob)).allocationComplete, false);
  assert.equal((await pool.describe(bob)).reservationPending, false);
  assert.equal(volumes.size, 4);
  const beforeRecoveryVolumes = structuredClone([...volumes]);
  assert.deepEqual(containers.get(pool.name(alice)), aliceContainer);
  await pool.acquire(alice, undefined, 'alice');
  await assert.rejects(pool.recover(bob), /validated offline/);
  await pool.close();
  exhausted = false;
  pool = make();
  await pool.initialize();
  await assert.rejects(pool.acquire(bob, undefined, 'bob'), CallerAllocationIncompleteError);
  await pool.close();
  pool = make();
  await pool.initialize(false, true);
  await assert.rejects(pool.recover(scopeDigest('agent', 'unknown')), /unknown caller scope/);
  await assert.rejects(pool.recover(alice), /incomplete allocation/);
  const networkName = `${pool.name(bob)}-net`;
  networks.set(networkName, { Name: networkName, Id: networkName, Driver: 'bridge', Scope: 'local', Labels: {}, Containers: {} });
  await assert.rejects(pool.recover(bob), /network ownership/);
  networks.delete(networkName);
  const volume = volumes.get(`${pool.name(bob)}-sessions`);
  volume.Labels['vicoop.scope'] = alice;
  await assert.rejects(pool.recover(bob), /volume ownership/);
  volume.Labels['vicoop.scope'] = bob;
  volumes.delete(`${pool.name(bob)}-sessions`);
  await assert.rejects(pool.recover(bob), /volume missing/);
  volumes.set(`${pool.name(bob)}-sessions`, volume);
  // A foreign consumer must block recovery before any create/start.
  containers.set('foreign', { Id: 'foreign', Name: 'foreign', Mounts: [{ Name: `${pool.name(bob)}-sessions` }] });
  await assert.rejects(pool.recover(bob), /mounted by another/);
  containers.delete('foreign');
  exhausted = true;
  await assert.rejects(pool.recover(bob), /docker_address_pool_exhausted/);
  assert.equal(await pool.store.allocationComplete(bob), false);
  await pool.close();
  pool = make();
  await pool.initialize(false, true);
  exhausted = false;
  const before = calls.length;
  await pool.recover(bob);
  assert.equal(await pool.store.allocationComplete(bob), true);
  assert.equal((await pool.describe(bob)).state, 'stopped');
  assert.deepEqual([...volumes].sort(), beforeRecoveryVolumes.sort());
  assert.ok(!calls.slice(before).some(args => args[0] === 'volume' && ['create', 'rm'].includes(args[1])));
  assert.ok(!calls.some(args => args.includes('prune')));
  await pool.close();
  pool = make();
  await pool.initialize();
  await pool.acquire(bob, undefined, 'bob');
  assert.equal((await pool.describe(bob)).state, 'running');
  await pool.close();
});
