import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCallerContainerInit } from './caller-container-init.js';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import { scopeDigest } from './caller-runtime-store.js';
import { runDockerCommand } from './docker-command.js';
import { createLogger } from './logger.js';

// Actual Docker builds/probes and retained files; fixtures make no provider calls.
test('init provisions shared fixed storage, concurrent backends agree, and reinit preserves caller data', {
  skip: process.env.VICOOP_FIXED_STORAGE_TEST !== '1', timeout: 600_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storage-init-integration-'));
  const storagePool = `vb-init-test-${randomUUID()}`;
  const tag = `${storagePool}:fixture`;
  const legacyPool = `${storagePool}-unlabeled`;
  const command = async (args: string[]) => {
    const result = await runDockerCommand(args, { timeoutMs: 300_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  // This deliberately includes only the initialization/runtime contract.
  await writeFile(join(dir, 'Dockerfile'), `FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini iptables util-linux iproute2 procps && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /workspace /data/sessions/claude/config /data/sessions/codex/config \\
 && chown -R node:node /workspace /data/sessions \\
 && printf '#!/bin/sh\\necho "2.1.267 (Claude Code)"\\n' > /usr/local/bin/claude \\
 && printf '#!/bin/sh\\necho "codex-cli 0.153.4"\\n' > /usr/local/bin/codex \\
 && chmod +x /usr/local/bin/claude /usr/local/bin/codex
USER node
`);
  const paths = [join(dir, 'claude.json'), join(dir, 'codex.json')];
  let pool: DockerCallerRuntimePool | undefined;
  let complete = false;
  try {
    const available = await runDockerCommand(['info'], { timeoutMs: 10_000 });
    assert.equal(available.exitCode, 0, available.stderr);
    await command(['build', '-t', tag, dir]);
    const image = await command(['image', 'inspect', '--format', '{{.Id}}', tag]);
    await Promise.all(paths.map((path, i) => writeFile(path, JSON.stringify({ agent_id: `init-agent-${i}`, server_token: 'fixture', preserved: true }))));
    const options = { image, storagePool, storageMiB: 64, storageCapacityMiB: 128, storageReserveMiB: 64,
      validateCredentials: async () => {}, logger: createLogger('silent') };
    await Promise.all([
      runCallerContainerInit({ ...options, kind: 'claude', configPath: paths[0] }),
      runCallerContainerInit({ ...options, kind: 'codex', configPath: paths[1] }),
    ]);
    const config = JSON.parse(await readFile(paths[0], 'utf8'));
    const other = JSON.parse(await readFile(paths[1], 'utf8'));
    const runtime = config.backends.claude.caller_runtime;
    assert.equal(config.preserved, true);
    assert.deepEqual(runtime.fixedImageStorage, other.backends.codex.caller_runtime.fixedImageStorage);
    assert.match(runtime.fixedImageStorage.image, /^sha256:[a-f0-9]{64}$/);
    pool = new DockerCallerRuntimePool('claude', runtime, config.agent_id);
    await pool.initialize();
    const id = scopeDigest(config.agent_id, 'alice');
    await pool.acquire(id, undefined, 'alice');
    const identity = await pool.store.fixedStorage(id);
    await command(['exec', '--user', '1000:1000', pool.name(id), 'node', '-e',
      "const fs=require('fs');fs.writeFileSync('/workspace/retained','workspace');fs.writeFileSync('/data/sessions/claude/config/retained','session')"]);
    await pool.close(); pool = undefined;
    await runCallerContainerInit({ ...options, kind: 'claude', configPath: paths[0] });
    assert.deepEqual(JSON.parse(await readFile(paths[0], 'utf8')), config);
    await assert.rejects(runCallerContainerInit({ ...options, kind: 'claude', configPath: paths[0], storageMiB: 128 }), /configuration changed/);
    await assert.rejects(runCallerContainerInit({ ...options, kind: 'claude', configPath: paths[0], storageCapacityMiB: 256 }), /immutable/);
    pool = new DockerCallerRuntimePool('claude', runtime, config.agent_id);
    await pool.initialize(); await pool.acquire(id);
    assert.equal(await pool.store.fixedStorage(id), identity);
    assert.equal(await command(['exec', pool.name(id), 'node', '-e',
      "const fs=require('fs');console.log(fs.readFileSync('/workspace/retained','utf8')+':'+fs.readFileSync('/data/sessions/claude/config/retained','utf8'))"]), 'workspace:session');
    await pool.remove(id, true); await pool.close(); pool = undefined;
    // Probe space is returned; a subsequent initializer can still allocate it.
    await runCallerContainerInit({ ...options, kind: 'codex', configPath: paths[1] });
    // Rejected new policy must not publish an unusable immutable pool.
    const legacyPath = join(dir, 'legacy-pool.json');
    const original = JSON.stringify({ agent_id: 'legacy-pool-agent', server_token: 'fixture' });
    await writeFile(legacyPath, original);
    const legacyOptions = { ...options, kind: 'claude' as const, configPath: legacyPath, storagePool: legacyPool };
    await assert.rejects(runCallerContainerInit({ ...legacyOptions, storageMiB: 1024, storageCapacityMiB: 64 }), /smaller than a scope/);
    const missing = await runDockerCommand(['volume', 'inspect', legacyPool]);
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.stderr, /No such volume/i);
    // A #509-style pool has an existing catalog but no policy labels. Seed it
    // with a real disposable helper probe, then try incorrect/default policy.
    await command(['volume', 'create', '--label', 'vicoop.component=caller-storage-pool', legacyPool]);
    await command(['run', '--rm', '--name', `${legacyPool}-seed`, '--privileged', '--network', 'none', '--read-only',
      '--tmpfs', '/mnt:rw,nosuid,nodev', '--tmpfs', '/tmp:rw,nosuid,nodev',
      '--mount', 'type=bind,src=/dev,dst=/dev', '--mount', `type=volume,src=${legacyPool},dst=/pool`,
      runtime.fixedImageStorage.image, 'probe', 'f'.repeat(64), randomUUID(),
      String(64 * 1048576), String(128 * 1048576), String(64 * 1048576)]);
    await assert.rejects(runCallerContainerInit({ ...legacyOptions,
      storageMiB: undefined, storageCapacityMiB: undefined, storageReserveMiB: undefined }), /pool policy differs/);
    assert.equal(await readFile(legacyPath, 'utf8'), original);
    await runCallerContainerInit(legacyOptions);
    const recovered = JSON.parse(await readFile(legacyPath, 'utf8')).backends.claude.caller_runtime;
    assert.equal(recovered.fixedImageStorage.capacityMiB, 128);
    assert.equal(recovered.fixedImageStorage.reserveMiB, 64);
    complete = true;
  } catch (error) {
    console.error('Initialization/lifecycle failure before cleanup:', error);
    throw error;
  } finally {
    if (pool) {
      for (const id of await pool.store.scopes()) await pool.remove(id, true);
      await pool.close();
    }
    // On uncertainty preserve the durable recovery journal and dedicated test pool.
    if (complete) {
      await command(['volume', 'rm', storagePool, legacyPool]);
      await command(['image', 'rm', tag]);
      await rm(dir, { recursive: true, force: true });
    } else console.error(`Initialization test recovery state retained: ${dir}; pools: ${storagePool}, ${legacyPool}`);
  }
});
