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
  await command(['build', '-t', helperTag, resolve('container/storage')]);
  const helperImage = await command(['image', 'inspect', '--format', '{{.Id}}', helperTag]);
  await writeFile(join(directory, 'Dockerfile'), `FROM ${helperTag}\nRUN apk add --no-cache tini iptables && ln -s /sbin/tini /usr/bin/tini && mkdir -p /home/node\n`);
  await command(['build', '-t', runtimeTag, directory]);
  const image = await command(['image', 'inspect', '--format', '{{.Id}}', runtimeTag]);
  const options = CallerRuntimeConfig.parse({ image, stateDirectory: join(directory, 'state'), storageMiB: 64,
    fixedImageStorage: { image: helperImage, poolVolume, capacityMiB: 128, reserveMiB: 64, reservationBoundary: 'docker-filesystem' } });
  let pool = new DockerCallerRuntimePool('claude', options, 'storage-test');
  await pool.initialize(); pools.push(pool);
  const alice = scopeDigest('storage-test', 'alice'), bob = scopeDigest('storage-test', 'bob');
  await Promise.all([pool.acquire(alice, undefined, 'alice'), pool.acquire(bob, undefined, 'bob')]);
  const exec = (id: string, script: string) => command(['exec', '--user', '1000:1000', pool.name(id), 'python3', '-c', script]);
  await exec(alice, "open('/workspace/marker','w').write('retained');open('/data/sessions/claude/config/marker','w').write('session')");
  assert.equal(await exec(alice, `import errno
with open('/workspace/fill','wb',buffering=0) as f:
 try:
  for _ in range(128): f.write(b'x'*1048576)
  raise AssertionError('capacity was not enforced')
 except OSError as e:
  assert e.errno==errno.ENOSPC
print('ENOSPC')`), 'ENOSPC');
  await exec(bob, "f=open('/workspace/healthy','w');f.write('ok');f.flush();__import__('os').fsync(f.fileno())");
  await pool.stop(alice); await pool.acquire(alice);
  await exec(alice, "__import__('os').unlink('/workspace/fill')");
  await exec(alice, `import errno,os
assert os.stat('/workspace').st_dev == os.stat('/data/sessions/claude').st_dev
os.mkdir('/workspace/inodes')
try:
 for n in range(10000): open('/workspace/inodes/'+str(n),'w').close()
 raise AssertionError('inode capacity was not enforced')
except OSError as e:
 assert e.errno==errno.ENOSPC
assert os.statvfs('/workspace').f_favail==0`);
  await exec(bob, "open('/workspace/still-healthy','w').write('ok')");
  await exec(alice, "__import__('shutil').rmtree('/workspace/inodes')");
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
  await exec(alice, "assert open('/workspace/marker').read()=='retained';assert open('/data/sessions/claude/config/marker').read()=='session'");
  // Simulate loss of loop attachments at daemon-host reboot, retaining images.
  await pool.remove(alice, false); await pool.remove(bob, false);
  const records = await Promise.all([alice, bob].map(async id => JSON.parse((await pool.store.fixedStorage(id))!)));
  for (const record of records) {
    await command(['run', '--rm', '--privileged', '--network', 'none',
      '--mount', 'type=bind,src=/dev,dst=/dev', '--mount', `type=volume,src=${poolVolume},dst=/pool`,
      '--entrypoint', 'python3', helperImage, '-c',
      "import subprocess,sys,os; p='/pool/managed/'+sys.argv[1]+'.img'; loops=subprocess.check_output(['losetup','-j',p],text=True).splitlines(); [subprocess.check_call(['losetup','-d',l.split(':')[0]]) for l in loops]", record.key, record.uuid]);
  }
  await pool.close(); pools.pop();
  await assert.rejects(new DockerCallerRuntimePool('claude', { ...options, storageMiB: 128 }, 'storage-test').initialize(), /configuration changed/);
  pool = new DockerCallerRuntimePool('claude', options, 'storage-test');
  await pool.initialize(); pools.push(pool);
  await pool.acquire(bob); await pool.acquire(alice);
  await exec(alice, "assert open('/workspace/marker').read()=='retained'");
  await pool.remove(alice, true);
  await pool.acquire(charlie, undefined, 'charlie');
  const inspection = JSON.parse(await command(['container', 'inspect', pool.name(charlie)]))[0];
  assert.equal(inspection.HostConfig.Privileged, false);
  assert.equal(inspection.HostConfig.Devices.length, 0);
  assert(inspection.Mounts.every((m: {Type: string}) => m.Type === 'volume'));
});
