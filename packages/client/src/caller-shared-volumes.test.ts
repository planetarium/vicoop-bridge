import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("shared mounts survive acquisition and recreation, reject drift, and are never deleted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "caller-shared-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = CallerRuntimeConfig.parse({
    ...base,
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
            VolumeOptions: { NoCopy: !!m["volume-nocopy"] },
          })),
        },
        Mounts: mounts.map((m) => ({
          Type: m.type,
          Name: m.source,
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
});
