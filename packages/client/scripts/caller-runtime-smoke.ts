// Real Docker lifecycle acceptance; no provider calls. Run source and Bun-compiled.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DockerCallerRuntimePool,
  type CallerKind,
} from '../src/caller-runtime-docker.js';
import { CallerRuntimeConfig } from '../src/caller-runtime-config.js';
import { scopeDigest } from '../src/caller-runtime-store.js';
import { runDockerCommand } from '../src/docker-command.js';
const image = process.env.VICOOP_SMOKE_IMAGE;
assert.ok(image, 'set VICOOP_SMOKE_IMAGE to immutable caller image ID');
const directory = await mkdtemp(join(tmpdir(), 'vicoop-caller-smoke-'));
async function docker(args: string[]) {
  const r = await runDockerCommand(args);
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout.trim();
}
try {
  for (const kind of ['claude', 'codex'] as CallerKind[]) {
    const agent = `smoke-${randomUUID()}`;
    const config = CallerRuntimeConfig.parse({
      image,
      stateDirectory: join(directory, kind),
      storageMiB: 64,
    });
    let pool = new DockerCallerRuntimePool(kind, config, agent);
    const alice = scopeDigest(agent, 'alice'),
      bob = scopeDigest(agent, 'bob');
    const ids = [alice, bob];
    await pool.initialize();
    try {
      const a = await pool.acquire(alice),
        b = await pool.acquire(bob);
      assert.notEqual(a.name, b.name);
      const containerId = await docker([
        'inspect',
        '--format',
        '{{.Id}}',
        a.name,
      ]);
      await docker([
        'exec',
        a.name,
        '/bin/sh',
        '-c',
        `printf ALICE > /workspace/owner; printf ALICE_SESSION > /data/sessions/${kind}/session-probe`,
      ]);
      await docker([
        'exec',
        b.name,
        '/bin/sh',
        '-c',
        `test ! -e /workspace/owner; printf BOB > /workspace/owner; printf BOB_SESSION > /data/sessions/${kind}/session-probe`,
      ]);
      assert.equal((await pool.acquire(alice)).name, a.name);
      assert.equal(
        await docker(['inspect', '--format', '{{.Id}}', a.name]),
        containerId,
      );
      assert.equal(
        await docker(['exec', a.name, 'cat', '/workspace/owner']),
        'ALICE',
      );
      await pool.stop(alice);
      assert.equal(
        await docker(['inspect', '--format', '{{.State.Running}}', b.name]),
        'true',
      );
      await pool.acquire(alice);
      assert.equal(
        await docker(['inspect', '--format', '{{.Id}}', a.name]),
        containerId,
      );
      await pool.remove(alice, false);
      await pool.acquire(alice);
      assert.notEqual(
        await docker(['inspect', '--format', '{{.Id}}', a.name]),
        containerId,
      );
      assert.equal(
        await docker(['exec', a.name, 'cat', '/workspace/owner']),
        'ALICE',
      );
      assert.equal(
        await docker([
          'exec',
          a.name,
          'cat',
          `/data/sessions/${kind}/session-probe`,
        ]),
        'ALICE_SESSION',
      );
      assert.equal(
        await docker(['exec', b.name, 'cat', '/workspace/owner']),
        'BOB',
      );
      const input = await pool.inputDirectory(alice);
      await pool.inputWrite(
        alice,
        `${input}/image-1.png`,
        Buffer.from('INPUT'),
      );
      assert.equal(
        await docker(['exec', a.name, 'cat', `${input}/image-1.png`]),
        'INPUT',
      );
      await pool.inputRemove(alice, input);
      await pool.close();
      pool = new DockerCallerRuntimePool(kind, config, agent);
      assert.equal((await pool.initialize()).length, 2);
      await pool.acquire(alice);
      assert.equal(
        await docker(['exec', a.name, 'cat', '/workspace/owner']),
        'ALICE',
      );
      // A live host owner prevents a second daemon from recovering its containers.
      const other = new DockerCallerRuntimePool(kind, config, agent);
      await assert.rejects(other.initialize(), /live owner/);
      await docker([
        'exec',
        a.name,
        '/bin/sh',
        '-c',
        'dd if=/dev/zero of=/workspace/large bs=1M count=65 status=none',
      ]);
      await assert.rejects(pool.checkStorage(alice), /storage limit/);
      await docker(['exec', a.name, 'rm', '/workspace/large']);
      await pool.close();
      const resized = { ...config, memoryMiB: 1024, cpus: 0.5, pids: 128, maxScopes: 1 };
      const rejected = new DockerCallerRuntimePool(kind, resized, agent);
      await assert.rejects(rejected.initialize(), /exceed maxScopes/);
      pool = new DockerCallerRuntimePool(kind, resized, agent);
      await pool.initialize(false);
      await assert.rejects(pool.acquire(alice), /offline administration/);
      await pool.remove(alice, false);
      await pool.remove(bob, true);
      await pool.close();
      pool = new DockerCallerRuntimePool(kind, resized, agent);
      await pool.initialize();
      const restored = await pool.acquire(alice);
      assert.equal(await docker(['exec', restored.name, 'cat', '/workspace/owner']), 'ALICE');
      assert.equal(await docker(['inspect', '--format', '{{.HostConfig.Memory}}', restored.name]), String(1024 * 1048576));
      console.log(
        `PASS ${kind}: A/B/A, container reuse, stop/recreate/restart persistence, independent volumes, exclusive owner, input transfer, storage admission, offline resize recovery`,
      );
    } finally {
      for (const id of await pool.store.scopes()) await pool.remove(id, true);
      await pool.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
