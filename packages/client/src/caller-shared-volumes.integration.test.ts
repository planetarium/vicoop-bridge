import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DockerCallerRuntimePool } from "./caller-runtime-docker.js";
import { CallerRuntimeConfig } from "./caller-runtime-config.js";
import { scopeDigest } from "./caller-runtime-store.js";
import { runDockerCommand as docker } from "./docker-command.js";
// Supply a locally installed caller image containing tini, firewall tools and UID 1000 writable data directories.
test(
  "real Docker shares read-only materials while preserving private caller state",
  { skip: !process.env.VICOOP_SHARED_TEST_IMAGE },
  async () => {
    const volume = `shared-smoke-${Date.now()}`,
      directory = await mkdtemp("/tmp/shared-docker-");
    const run = async (args: string[]) => {
      const r = await docker(args);
      if (r.exitCode) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const image = await run([
      "image",
      "inspect",
      process.env.VICOOP_SHARED_TEST_IMAGE!,
      "--format",
      "{{.Id}}",
    ]);
    const options = CallerRuntimeConfig.parse({
      image,
      stateDirectory: directory,
      sharedVolumes: [{ name: "docs", volume }],
    });
    let pool = new DockerCallerRuntimePool("claude", options, "shared-smoke");
    const alice = scopeDigest("shared-smoke", "alice"),
      bob = scopeDigest("shared-smoke", "bob");
    try {
      await run(["volume", "create", volume]);
      await run([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0",
        "--mount",
        `type=volume,source=${volume},target=/materials,volume-nocopy`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "echo reference > /materials/readme; chmod -R a+rX /materials",
      ]);
      await pool.initialize();
      const a = await pool.acquire(alice, undefined, "alice");
      const b = await pool.acquire(bob, undefined, "bob");
      assert.equal(
        await run(["exec", a.name, "cat", "/shared/docs/readme"]),
        "reference"
      );
      assert.equal(
        await run(["exec", b.name, "cat", "/shared/docs/readme"]),
        "reference"
      );
      assert.notEqual(
        (await docker(["exec", a.name, "touch", "/shared/docs/forbidden"]))
          .exitCode,
        0
      );
      await run([
        "exec",
        a.name,
        "/bin/sh",
        "-c",
        "echo alice > /workspace/private",
      ]);
      assert.notEqual(
        (await docker(["exec", b.name, "cat", "/workspace/private"])).exitCode,
        0
      );
      await pool.close();
      pool = new DockerCallerRuntimePool("claude", options, "shared-smoke");
      await pool.initialize();
      assert.equal((await pool.acquire(alice)).recovered, true);
      await pool.remove(alice, false);
      assert.equal((await pool.acquire(alice)).recreated, true);
      assert.equal(
        await run(["exec", a.name, "cat", "/workspace/private"]),
        "alice"
      );
      await pool.remove(alice, true);
      assert.equal(
        await run([
          "exec",
          (await pool.acquire(bob)).name,
          "cat",
          "/shared/docs/readme",
        ]),
        "reference"
      );
      await pool.remove(bob, true);
      await pool.close();
      await run(["volume", "inspect", volume]);
    } finally {
      for (const id of [alice, bob]) {
        try {
          await pool.remove(id, true);
        } catch {}
      }
      try {
        await pool.close();
      } catch {}
      await run(["volume", "rm", volume]);
      await rm(directory, { recursive: true, force: true });
    }
  }
);
