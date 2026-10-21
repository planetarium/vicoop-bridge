import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import { setupCallerEnvironment } from './caller-environment-setup.js';
import { fileURLToPath } from 'node:url';
import { runBoundedCommand, runDockerCommand } from './docker-command.js';

// Supply a pinned bundled runtime image with /workspace owned by UID 1000.
// No provider credentials or model requests are needed.
test('real Docker setup gates first request, persists across recreation and recovers failed update', {
  skip: !process.env.VICOOP_SETUP_TEST_IMAGE, timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vb-setup-integration-'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'task-token'), 'fixture-not-a-real-token');
  const options = CallerRuntimeConfig.parse({ stateDirectory: join(root, 'state'), image: process.env.VICOOP_SETUP_TEST_IMAGE });
  const id = scopeDigest('setup-test', 'alice');
  const make = () => new DockerCallerRuntimePool('claude', options, 'setup-test');
  let pool = make();
  try {
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ agent_id: 'setup-test', backend: 'claude', backends: { claude: { caller_runtime: options } } }));
    const cli = async (...args: string[]) => {
      const result = await runBoundedCommand(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), 'container', ...args, '--config', config]);
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const pending = await cli('setup', '--principal', 'typo', '--version', 'v1', '--pending');
    assert.equal(pending.setup.ready, false);
    const inspected = await cli('inspect', '--principal', 'typo');
    assert.equal(inspected.preparations[0].version, 'v1');
    assert.deepEqual(inspected.scopes, []);
    assert.equal((await cli('list')).preparations.length, 1);
    assert.deepEqual((await cli('remove', pending.setup.id)).preparations, []);

    await pool.initialize(false);
    await setupCallerEnvironment(pool, { principalId: 'alice', version: 'v1', pending: true });
    await pool.close(); pool = make(); await pool.initialize();
    await assert.rejects(pool.acquire(id, undefined, 'alice'), /pending/);
    await pool.close(); pool = make(); await pool.initialize(false, true);
    await setupCallerEnvironment(pool, { principalId: 'alice', version: 'v1', from: source });
    await pool.close(); pool = make(); await pool.initialize(false, true);
    await pool.remove(id, false);
    await pool.close(); pool = make(); await pool.initialize();
    const container = await pool.acquire(id, undefined, 'alice');
    const read = await runDockerCommand(['exec', '--user', '1000:1000', container.name, '/usr/local/bin/node', '-e',
      "const fs=require('node:fs');if(fs.readFileSync('/workspace/task-token','utf8')!=='fixture-not-a-real-token'||(fs.statSync('/workspace/task-token').mode&511)!==384)process.exit(1)"]);
    assert.equal(read.exitCode, 0);
    await pool.close(); pool = make(); await pool.initialize(false, true);
    await assert.rejects(setupCallerEnvironment(pool, { principalId: 'alice', version: 'v2', from: source }), /remains pending/);
    await pool.close(); pool = make(); await pool.initialize();
    await assert.rejects(pool.acquire(id, undefined, 'alice'), /pending/);
    await pool.close(); pool = make(); await pool.initialize(false, true);
    await setupCallerEnvironment(pool, { principalId: 'alice', version: 'v2', from: source, replace: true });
    assert.deepEqual(await pool.store.preparation(id), { version: 'v2', ready: true });
  } finally {
    await pool.close();
    pool = make(); await pool.initialize(false);
    try {
      if ((await pool.store.scopes()).includes(id)) await pool.remove(id, true);
      else if (await pool.store.preparation(id)) await pool.store.cancelUnallocatedPreparation(id);
    } finally { await pool.close(); }
    await rm(root, { recursive: true, force: true });
  }
});
