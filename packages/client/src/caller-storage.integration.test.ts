import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import { runDockerCommand } from './docker-command.js';

// Explicit opt-in: builds an operator helper and uses privileged containers.
// Run from packages/client with VICOOP_FIXED_STORAGE_TEST=1 and DOCKER_CONTEXT set.
test('fixed image runtime: ENOSPC, independent callers, recreation, admission and deletion', {
  skip: process.env.VICOOP_FIXED_STORAGE_TEST !== '1', timeout: 300_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fixed-storage-integration-'));
  const poolVolume = `vb-storage-test-${randomUUID()}`;
  const helperTag = `${poolVolume}-helper`, runtimeTag = `${poolVolume}-runtime`;
  const command = async (args: string[]) => {
    const result = await runDockerCommand(args, { timeoutMs: 180_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  const pools: DockerCallerRuntimePool[] = [];
  t.after(async () => {
    for (const pool of pools.reverse()) {
      for (const id of await pool.store.scopes()) await pool.remove(id, true);
      await pool.close();
    }
    await command(['volume', 'rm', poolVolume]);
    await command(['image', 'rm', runtimeTag, helperTag]);
    await rm(directory, { recursive: true, force: true });
  });
  await command(['volume', 'create', '--label', 'vicoop.component=caller-storage-pool', poolVolume]);
  await command(['build', '-t', helperTag, '-f', resolve('container/storage/Dockerfile'), resolve('../..')]);
  const helperImage = await command(['image', 'inspect', '--format', '{{.Id}}', helperTag]);
  await command(['run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', helperImage, '-ec',
    'test -x /usr/local/bin/vicoop-storage; ! command -v python3; ! command -v bun']);
  await writeFile(join(directory, 'Dockerfile'), `FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends tini iptables util-linux && rm -rf /var/lib/apt/lists/* && mkdir -p /home/node\n`);
  await command(['build', '-t', runtimeTag, directory]);
  const image = await command(['image', 'inspect', '--format', '{{.Id}}', runtimeTag]);
  const options = CallerRuntimeConfig.parse({ image, stateDirectory: join(directory, 'state'), storageMiB: 64,
    fixedImageStorage: { image: helperImage, poolVolume, capacityMiB: 128, reserveMiB: 64, reservationBoundary: 'docker-filesystem' } });
  let pool = new DockerCallerRuntimePool('claude', options, 'storage-test');
  await pool.initialize(); pools.push(pool);
  const alice = scopeDigest('storage-test', 'alice'), bob = scopeDigest('storage-test', 'bob');
  await Promise.all([pool.acquire(alice, undefined, 'alice'), pool.acquire(bob, undefined, 'bob')]);
  const exec = (id: string, script: string) => command(['exec', '--user', '1000:1000', pool.name(id), 'node', '-e',
    `const fs = require('node:fs'); const assert = require('node:assert/strict'); ${script}`]);
  await exec(alice, "fs.writeFileSync('/workspace/marker','retained');fs.writeFileSync('/data/sessions/claude/config/marker','session')");
  assert.equal(await exec(alice, `
    const fd = fs.openSync('/workspace/fill','w');
    try {
      assert.throws(() => { for (let n=0; n<128; n++) fs.writeSync(fd, Buffer.alloc(1048576, 120)); }, { code: 'ENOSPC' });
    } finally { fs.closeSync(fd); }
    console.log('ENOSPC');`), 'ENOSPC');
  await exec(bob, "const fd=fs.openSync('/workspace/healthy','w');fs.writeSync(fd,'ok');fs.fsyncSync(fd);fs.closeSync(fd)");
  await pool.stop(alice); await pool.acquire(alice);
  await exec(alice, "fs.unlinkSync('/workspace/fill')");
  await exec(alice, `
    assert.equal(fs.statSync('/workspace').dev, fs.statSync('/data/sessions/claude').dev);
    fs.mkdirSync('/workspace/inodes');
    assert.throws(() => { for (let n=0; n<10000; n++) fs.closeSync(fs.openSync('/workspace/inodes/'+n,'w')); }, { code: 'ENOSPC' });
    assert.equal(fs.statfsSync('/workspace').ffree, 0);`);
  await exec(bob, "fs.writeFileSync('/workspace/still-healthy','ok')");
  await exec(alice, "fs.rmSync('/workspace/inodes', { recursive: true })");
  // Independent client state still shares the daemon-side pool admission lock.
  const other = new DockerCallerRuntimePool('claude', { ...options, stateDirectory: join(directory, 'other') }, 'other-agent');
  await other.initialize(); pools.push(other);
  const outsider = scopeDigest('other-agent', 'outsider');
  await assert.rejects(other.acquire(outsider, undefined, 'outsider'), /pool capacity exhausted/);
  await other.remove(outsider, true); await other.close(); pools.pop();
  const charlie = scopeDigest('storage-test', 'charlie');
  await assert.rejects(pool.acquire(charlie, undefined, 'charlie'), /pool capacity exhausted/);
  await pool.remove(charlie, true);
  await pool.remove(alice, false); await pool.acquire(alice);
  await exec(alice, "assert.equal(fs.readFileSync('/workspace/marker','utf8'),'retained');assert.equal(fs.readFileSync('/data/sessions/claude/config/marker','utf8'),'session')");
  // Simulate loss of loop attachments at daemon-host reboot, retaining images.
  await pool.remove(alice, false); await pool.remove(bob, false);
  const records = await Promise.all([alice, bob].map(async id => JSON.parse((await pool.store.fixedStorage(id))!)));
  for (const record of records) {
    await command(['run', '--rm', '--privileged', '--network', 'none',
      '--mount', 'type=bind,src=/dev,dst=/dev', '--mount', `type=volume,src=${poolVolume},dst=/pool`,
      '--entrypoint', 'node', image, '-e',
      "const cp=require('node:child_process'); const p='/pool/managed/'+process.argv[1]+'.img'; for(const line of cp.execFileSync('losetup',['-j',p],{encoding:'utf8'}).trim().split('\\n').filter(Boolean)) cp.execFileSync('losetup',['-d',line.split(':')[0]]);", record.key]);
  }
  await pool.close(); pools.pop();
  await assert.rejects(new DockerCallerRuntimePool('claude', { ...options, storageMiB: 128 }, 'storage-test').initialize(), /configuration changed/);
  pool = new DockerCallerRuntimePool('claude', options, 'storage-test');
  await pool.initialize(); pools.push(pool);
  await pool.acquire(bob); await pool.acquire(alice);
  await exec(alice, "assert.equal(fs.readFileSync('/workspace/marker','utf8'),'retained')");
  // Interrupt deletion after volume removal/loop detach, then let B occupy
  // the stale alias target. Retrying A must not detach B or strand A's budget.
  await pool.remove(alice, false);
  await command(['volume', 'rm', `${pool.name(alice)}-storage`]);
  const aliceRecord = JSON.parse((await pool.store.fixedStorage(alice))!);
  const bobRecord = JSON.parse((await pool.store.fixedStorage(bob))!);
  await command(['run', '--rm', '--privileged', '--network', 'none',
    '--mount', 'type=bind,src=/dev,dst=/dev', '--entrypoint', 'node', image, '-e',
    "const fs=require('node:fs'),cp=require('node:child_process'); const a='/dev/disk/by-uuid/'+process.argv[1],b='/dev/disk/by-uuid/'+process.argv[2];cp.execFileSync('losetup',['-d',fs.readlinkSync(a)]);fs.unlinkSync(a);fs.symlinkSync(fs.readlinkSync(b),a);", aliceRecord.uuid, bobRecord.uuid]);
  await pool.remove(alice, true);
  await exec(bob, "assert.equal(fs.readFileSync('/workspace/healthy','utf8'),'ok');fs.writeFileSync('/workspace/after-delete','still healthy')");
  await pool.acquire(charlie, undefined, 'charlie');
  const inspection = JSON.parse(await command(['container', 'inspect', pool.name(charlie)]))[0];
  assert.equal(inspection.HostConfig.Privileged, false);
  assert.equal(inspection.HostConfig.Devices.length, 0);
  assert(inspection.Mounts.every((m: {Type: string}) => m.Type === 'volume'));
});
