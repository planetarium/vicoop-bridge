// Exercise embedded image builds outside the repository, using a compiled CLI.
// Version and writable-volume probes only; no provider/model calls or agent registration.
// VICOOP_SMOKE_IMAGE optionally skips the bundled build with an existing image.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const binary = process.env.VICOOP_CLIENT_BIN;
assert.ok(binary, 'set VICOOP_CLIENT_BIN to an absolute compiled CLI path');
const directory = await mkdtemp(join(tmpdir(), 'vicoop-init-smoke-'));
const path = join(directory, 'config.json');
const env = { ...process.env, VICOOP_HOME: directory, ANTHROPIC_API_KEY: 'fixture-host-secret', OPENAI_API_KEY: 'fixture-host-secret' };
for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) delete env[name];
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { env, cwd: directory, stdio: 'inherit' });
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`CLI failed: ${code}/${signal}`)));
});
try {
  await writeFile(path, JSON.stringify({ agent_id: 'init-smoke', server_token: 'fixture', server_url: 'ws://127.0.0.1:1',
    retained: 'operator-setting', backends: { claude: { cwd: '/old', runtime_name: 'legacy' } } }));
  await run(['container', 'init', 'claude', '--config', path, ...(process.env.VICOOP_SMOKE_IMAGE ? ['--image', process.env.VICOOP_SMOKE_IMAGE] : [])]);
  const claude = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(claude.server_token, 'fixture');
  assert.equal(claude.retained, 'operator-setting');
  assert.equal(claude.backends.claude.cwd, undefined);
  assert.equal(claude.backends.claude.runtime_name, undefined);
  assert.equal(claude.backends.claude.runtime, 'container');
  const image = claude.backends.claude.caller_runtime.image;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  await run(['container', 'init', 'claude', '--config', path]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), claude);
  await run(['container', 'init', 'codex', '--config', path, '--image', image]);
  await run(['container', 'list']);
  await run(['container', 'validate']);
  await run(['container', 'validate', '--backend', 'claude', '--config', path]);
  await run(['caller-state', '--config', path]);
  const codex = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(codex.backends.claude, claude.backends.claude);
  assert.equal(codex.backend, 'codex');
  assert.notEqual(codex.backends.codex.caller_runtime.stateDirectory, claude.backends.claude.caller_runtime.stateDirectory);
  console.log(`PASS standalone init: image preparation, immutable ID, both backends, private SQLite state, preserved config, repeat initialization, default-config list/validate and compatibility alias (${image})`);
} finally { await rm(directory, { recursive: true, force: true }); }
