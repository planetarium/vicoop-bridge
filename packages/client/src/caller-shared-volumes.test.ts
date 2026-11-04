import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, realpath, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallerRuntimeConfig } from "./caller-runtime-config.js";
import {
  DockerCallerRuntimePool,
  CALLER_TMPFS,
} from "./caller-runtime-docker.js";
import { scopeDigest } from "./caller-runtime-store.js";
import type { AsyncDockerRun } from "./docker-command.js";

const base = {
  image: `sha256:${"a".repeat(64)}`,
  stateDirectory: "/tmp/caller-config",
};
const shared = { name: "docs", volume: "company-docs-v1" };

test("shared volume configuration rejects path injection, reserved names and ambiguity", () => {
  assert.deepEqual(CallerRuntimeConfig.parse(base).sharedVolumes, []);
  for (const entry of [
    { ...shared, name: "../workspace" },
    { ...shared, name: "/workspace" },
    { ...shared, name: "docs/nested" },
    { ...shared, volume: "/host" },
    { ...shared, volume: "docs,readonly=false" },
    { ...shared, volume: "vb-caller-secret" },
    { ...shared, target: "/workspace" },
    { ...shared, volume: "vicoop-creds-claude" },
  ])
    assert.equal(
      CallerRuntimeConfig.safeParse({ ...base, sharedVolumes: [entry] })
        .success,
      false
    );
  for (const entries of [
    [shared, shared],
    [shared, { ...shared, name: "other" }],
    [shared, { ...shared, volume: "other" }],
  ])
    assert.equal(
      CallerRuntimeConfig.safeParse({ ...base, sharedVolumes: entries })
        .success,
      false
    );
});

for (const withBinds of [false, true]) test(`shared mounts (binds=${withBinds}) survive acquisition and recreation, reject drift, and are never deleted`, async (t) => {
  const previousContext = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_CONTEXT = 'unit-test';
  t.after(() => { if (previousContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previousContext; });
  const directory = await mkdtemp(join(tmpdir(), "caller-shared-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(await realpath(directory), 'assets');
  await mkdir(source);
  await writeFile(join(source, 'corpus'), 'original');
  const options = CallerRuntimeConfig.parse({
    ...base,
    sharedBinds: withBinds ? [{ name: 'assets', source }] : [],
    stateDirectory: directory,
    sharedVolumes: [shared],
  });
  const containers = new Map<string, any>(),
    volumes = new Map<string, any>(),
    networks = new Map<string, any>();
  const sharedInfo = {
    Name: shared.volume,
    Driver: "local",
    Options: {},
    Labels: {},
  };
  volumes.set(shared.volume, sharedInfo);
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
  const pool = new DockerCallerRuntimePool("claude", options, "agent", run);
  await pool.initialize();
  const alice = scopeDigest("agent", "alice"),
    bob = scopeDigest("agent", "bob");
  await pool.acquire(alice, undefined, "alice");
  await pool.acquire(bob, undefined, "bob");
  const aliceInfo = containers.get(pool.name(alice));
  // Exercise fixed-image subpath validation without starting its privileged storage helper.
  const originalMounts = structuredClone(aliceInfo.Mounts);
  const originalDeclared = structuredClone(aliceInfo.HostConfig.Mounts);
  options.fixedImageStorage = {
    image: options.image,
    poolVolume: "storage-pool",
    capacityMiB: 128,
    reserveMiB: 64,
    reservationBoundary: "docker-filesystem",
  };
  for (const mount of aliceInfo.Mounts.filter(
    (m: any) => !m.Destination.startsWith("/shared/")
  ))
    mount.Name = `${pool.name(alice)}-storage`;
  for (const mount of aliceInfo.HostConfig.Mounts.filter(
    (m: any) => !m.Target.startsWith("/shared/")
  )) {
    mount.Source = `${pool.name(alice)}-storage`;
    mount.VolumeOptions = {
      NoCopy: true,
      Subpath: mount.Target === "/workspace" ? "workspace" : "sessions",
    };
  }
  const validate = () =>
    (
      pool as unknown as { validate(c: unknown, id: string): Promise<void> }
    ).validate(aliceInfo, alice);
  await validate();
  aliceInfo.HostConfig.Mounts[0].VolumeOptions.Subpath = "sessions";
  await assert.rejects(validate(), /boundary mismatch/);
  aliceInfo.HostConfig.Mounts[0].VolumeOptions.Subpath = "workspace";
  aliceInfo.HostConfig.Mounts.push({ ...aliceInfo.HostConfig.Mounts[2] });
  await assert.rejects(validate(), /boundary mismatch/);
  delete options.fixedImageStorage;
  aliceInfo.Mounts = originalMounts;
  aliceInfo.HostConfig.Mounts = originalDeclared;
  const mount = aliceInfo.Mounts.find(
    (m: any) => m.Destination === "/shared/docs"
  );
  const declaration = aliceInfo.HostConfig.Mounts.find(
    (m: any) => m.Target === "/shared/docs"
  );
  for (const [object, key, value] of [
    [mount, "RW", true],
    [mount, "Name", "foreign"],
    [mount, "Type", "bind"],
    [mount, "Destination", "/workspace/extra"],
    [declaration, "ReadOnly", false],
    [declaration.VolumeOptions, "NoCopy", false],
    [declaration.VolumeOptions, "Subpath", "secret"],
  ] as Array<[any, string, unknown]>) {
    const previous = object[key];
    object[key] = value;
    await assert.rejects(pool.acquire(alice), /boundary mismatch/);
    object[key] = previous;
  }
  if (withBinds) {
    const actual = aliceInfo.Mounts.find((m: any) => m.Type === 'bind');
    const declared = aliceInfo.HostConfig.Mounts.find((m: any) => m.Type === 'bind');
    for (const [object, key, value] of [
      [actual, 'RW', true], [actual, 'Source', '/foreign'], [actual, 'Type', 'volume'],
      [actual, 'Destination', '/workspace'], [actual, 'Propagation', 'rslave'],
      [declared, 'Source', '/foreign'], [declared, 'Target', '/shared/other'],
      [declared, 'ReadOnly', false], [declared, 'Type', 'volume'],
      [declared.BindOptions, 'NonRecursive', false], [declared.BindOptions, 'NonRecursive', undefined],
      [declared.BindOptions, 'Propagation', 'rshared'], [declared.BindOptions, 'CreateMountpoint', true],
      [declared.BindOptions, 'ReadOnlyNonRecursive', true], [declared.BindOptions, 'ReadOnlyForceRecursive', true],
    ] as Array<[any, string, unknown]>) {
      const previous = object[key]; object[key] = value;
      for (const action of [() => pool.acquire(alice), () => pool.remove(alice, false)])
        await assert.rejects(action(), /boundary mismatch/);
      object[key] = previous;
    }
    for (const mounts of [aliceInfo.Mounts, aliceInfo.HostConfig.Mounts]) {
      mounts.push(structuredClone(mounts.at(-1)));
      await assert.rejects(pool.acquire(alice), /boundary mismatch/);
      mounts.pop();
    }
    options.sharedBinds[0].source = join(source, 'missing');
    await assert.rejects(pool.acquire(alice), /canonical directory/);
    options.sharedBinds[0].source = source;
  }
  for (const drift of [
    { Driver: "nfs" },
    { Options: { type: "none", o: "bind", device: "/host" } },
    { Labels: { "vicoop.component": "caller-runtime" } },
    { Name: "different" },
  ]) {
    volumes.set(shared.volume, { ...sharedInfo, ...drift });
    await assert.rejects(
      pool.acquire(alice),
      /operator-owned plain local volume/
    );
  }
  volumes.delete(shared.volume);
  await assert.rejects(pool.acquire(alice), /Docker volume failed/);
  volumes.set(shared.volume, sharedInfo);
  await pool.remove(alice, false);
  assert.equal((await pool.acquire(alice)).recreated, true);
  assert.equal(volumes.get(shared.volume), sharedInfo);
  await pool.remove(alice, true);
  await pool.remove(bob, true);
  assert.deepEqual([...volumes.keys()], [shared.volume]);
  assert.ok(
    !calls.some(
      (args) =>
        args[0] === "volume" &&
        ["create", "rm"].includes(args[1]) &&
        args.includes(shared.volume)
    )
  );
  await pool.close();
  assert.equal(await readFile(join(source, 'corpus'), 'utf8'), 'original');
});


test('shared bind schema rejects ambiguous paths, mount options and target collisions', () => {
  const bind = { name: 'assets', source: '/srv/assets' };
  assert.deepEqual(CallerRuntimeConfig.parse(base).sharedBinds, []);
  for (const source of ['relative', '/', '/srv/../assets', '/srv//assets', '/srv/assets/',
    '/srv/assets,readonly=false', '/srv/"assets', '/srv/assets\\nested', '/srv/assets\n', '/srv/assets\0'])
    assert.equal(CallerRuntimeConfig.safeParse({ ...base, sharedBinds: [{ ...bind, source }] }).success, false, source);
  for (const entry of [{...bind, name:'../workspace'}, {...bind, name:'a/b'}, {...bind, target:'/workspace'}, {...bind, readonly:false}])
    assert.equal(CallerRuntimeConfig.safeParse({...base, sharedBinds:[entry]}).success, false);
  for (const entries of [[bind, bind], [bind, {...bind, name:'other'}], [bind, {...bind, source:'/srv/other'}]])
    assert.equal(CallerRuntimeConfig.safeParse({...base, sharedBinds:entries}).success, false);
  assert.equal(CallerRuntimeConfig.safeParse({...base, sharedBinds:[bind], sharedVolumes:[{...shared, name:'assets'}]}).success, false);
  assert.ok(CallerRuntimeConfig.parse({...base, sharedBinds:[{...bind, source:'/srv/한글 assets=one'}]}));
});

test('shared bind preflight rejects symlinks, files, missing directories and unsupported Docker hosts before allocation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bind-preflight-')));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const source = join(directory, 'assets');
  await mkdir(source);
  await symlink(source, join(directory, 'link'));
  await writeFile(join(directory, 'file'), 'not a directory');
  let endpoint = 'unix:///docker.sock', os = 'linux';
  const calls: string[][] = [];
  const run: AsyncDockerRun = async args => {
    calls.push([...args]);
    const stdout = args[0] === 'context' ? JSON.stringify(endpoint) : args[0] === 'info' ? os : '[{"Config":{}}]';
    return {exitCode:0, stdout, stderr:''};
  };
  const options = CallerRuntimeConfig.parse({...base, stateDirectory:join(directory,'state'), sharedBinds:[{name:'assets',source}]});
  const pool = () => new DockerCallerRuntimePool('claude', options, 'test', run);
  // Delegate endpoint resolution to the mocked Docker context inspection.
  const previous = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_CONTEXT = 'fixture';
  t.after(() => { if(previous === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previous; });
  for (const invalid of ['link', 'file', 'missing']) {
    options.sharedBinds[0].source = join(directory, invalid);
    await assert.rejects(pool().initialize(), /canonical directory/);
  }
  options.sharedBinds[0].source = source;
  for (endpoint of ['ssh://remote', 'tcp://remote:2376'])
    await assert.rejects(pool().initialize(), /local Docker Unix socket/);
  const previousHost = process.env.DOCKER_HOST;
  t.after(() => { if(previousHost === undefined)delete process.env.DOCKER_HOST;else process.env.DOCKER_HOST = previousHost; });
  delete process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = 'tcp://remote:2376';
  await assert.rejects(pool().initialize(), /local Docker Unix socket/);
  // With a context selected, validate the endpoint Docker reports instead of
  // assuming that DOCKER_HOST identifies the effective endpoint.
  process.env.DOCKER_CONTEXT = 'fixture';
  endpoint = 'unix:///docker.sock'; os = 'windows';
  await assert.rejects(pool().initialize(), /Linux Docker daemon/);
  assert.ok(!calls.some(args => ['create','start','volume','network'].includes(args[0])));
});
