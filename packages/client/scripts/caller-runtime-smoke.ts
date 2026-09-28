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
import { openCallerDatabase } from '../src/caller-runtime-sqlite.js';
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
      // Verify the actual workload and root-supervisor UID-drop capability sets.
      const capabilityProbe = `const fs=require('fs'),cp=require('child_process'); const status=fs.readFileSync('/proc/self/status','utf8'); const caps=status.split('\\n').filter(line=>/^Cap(Inh|Prm|Eff|Amb):/.test(line)); if(caps.length!==4||caps.some(line=>!/0+$/.test(line)))process.exit(10); if(!/NoNewPrivs:\\s+1/.test(status))process.exit(11); const result=cp.spawnSync('/usr/sbin/iptables',['-S']); if(result.status===null||result.status===0)process.exit(12); console.log('unprivileged');`;
      assert.equal(await docker(['exec', '--user', '1000:1000', a.name, '/usr/local/bin/node', '-e', capabilityProbe]), 'unprivileged');
      const dropProbe = `const cp=require('child_process');const result=cp.spawnSync('/usr/local/bin/node',['-e',${JSON.stringify(capabilityProbe)}],{uid:1000,gid:1000,stdio:'inherit'});process.exit(result.status??1);`;
      assert.equal(await docker(['exec', '--user', '0', a.name, '/usr/local/bin/node', '-e', dropProbe]), 'unprivileged');
      const extraNetwork = `caller-smoke-extra-${randomUUID()}`;
      await docker(['network', 'create', extraNetwork]);
      try {
        await docker(['network', 'connect', extraNetwork, a.name]);
        try { await assert.rejects(pool.acquire(alice), /boundary mismatch/); }
        finally { await docker(['network', 'disconnect', extraNetwork, a.name]); }
      } finally { await docker(['network', 'rm', extraNetwork]); }
      await docker(['network', 'connect', `${a.name}-net`, b.name]);
      try { await assert.rejects(pool.acquire(alice), /network.*boundary mismatch/); }
      finally { await docker(['network', 'disconnect', `${a.name}-net`, b.name]); }
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
      for (const suffix of ['workspace', 'sessions']) {
        const consumer = `caller-smoke-consumer-${randomUUID()}`;
        await docker(['create', '--name', consumer, '--network', 'none',
          '--mount', `type=volume,src=${a.name}-${suffix},dst=/borrowed,readonly`,
          image, '/bin/sleep', 'infinity']);
        try {
          // Even a stopped foreign consumer prevents Docker from deleting a volume.
          for (const deleteData of [false, true])
            await assert.rejects(pool.remove(alice, deleteData), /mounted by another container/);
          assert.equal(await docker(['inspect', '--format', '{{.Id}}', a.name]), containerId);
          await docker(['network', 'inspect', `${a.name}-net`]);
          assert.ok((await pool.store.scopes()).includes(alice));
        } finally { await docker(['rm', consumer]); }
      }
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
      const older = await openCallerDatabase(join(config.stateDirectory, 'state.sqlite'));
      try { older.exec('DELETE FROM completed_allocations'); } finally { older.close(); }
      pool = new DockerCallerRuntimePool(kind, config, agent);
      assert.equal((await pool.initialize()).length, 2);
      assert.equal(await pool.store.allocationComplete(alice), true);
      assert.equal(await pool.store.allocationComplete(bob), true);
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
      await docker(['network', 'rm', `${a.name}-net`]);
      const strictNetwork = new DockerCallerRuntimePool(kind, config, agent);
      await assert.rejects(strictNetwork.initialize(false, true), /network missing|boundary mismatch/);
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
      await pool.remove(alice, false);
      await docker(['volume', 'rm', `${restored.name}-workspace`]);
      await pool.close();
      pool = new DockerCallerRuntimePool(kind, resized, agent);
      await pool.initialize();
      await pool.close();
      await assert.rejects(pool.initialize(false, true), /retained caller volume missing/);
      await pool.initialize();
      await assert.rejects(pool.acquire(alice), /retained caller volume missing/);
      await assert.rejects(docker(['volume', 'inspect', `${restored.name}-workspace`]));
      await pool.store.forget(alice);
      await assert.rejects(pool.acquire(alice), /unrecorded caller resources/);
      assert.deepEqual(await pool.store.scopes(), []);
      console.log(
        `PASS ${kind}: A/B/A, container reuse, stop/recreate/restart persistence, independent volumes, exclusive owner, input transfer, storage admission, offline resize recovery, network drift rejection, unprivileged workloads`,
      );
    } finally {
      for (const id of new Set([...ids, ...await pool.store.scopes()])) await pool.remove(id, true);
      await pool.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
