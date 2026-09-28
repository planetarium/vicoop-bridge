// A compiled CLI, outside the checkout, talking to a deterministic Docker fixture.
// Complements the opt-in real-Docker init/lifecycle smoke; no provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const binary = process.env.VICOOP_CLIENT_BIN;
assert.ok(binary?.startsWith('/'), 'set VICOOP_CLIENT_BIN to the compiled CLI absolute path');
const dir = await mkdtemp(join(tmpdir(), 'storage-packaging-'));
try {
  const hashes = {};
  for (const path of ['container/storage/Dockerfile', 'src/caller-storage-manager.ts', 'src/caller-storage-manager-cli.ts', 'src/caller-runtime-sqlite.ts'])
    hashes[`packages/client/${path}`] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
  await writeFile(join(dir, 'hashes.json'), JSON.stringify(hashes));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin/docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), root = process.env.FIXTURE_ROOT;
const image = 'sha256:' + 'a'.repeat(64), id = 'b'.repeat(64);
const statePath = path.join(root, 'docker.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { volumes: {}, builds: 0 };
const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const missing = type => { console.error('No such ' + type); process.exit(1); };
const labels = () => Object.fromEntries(args.flatMap((a,i) => a === '--label' ? [args[i+1].split('=')] : []));
switch (args[0]) {
  case 'info': out('linux'); break;
  case 'version': out('1.45 1.45'); break;
  case 'ps': break;
  case 'image': out([{ Id: image, Config: {} }]); break;
  case 'build': {
    const context = args.at(-1);
    const hashes = JSON.parse(fs.readFileSync(path.join(root, 'hashes.json')));
    for (const [name, hash] of Object.entries(hashes)) {
      if (crypto.createHash('sha256').update(fs.readFileSync(path.join(context,name))).digest('hex') !== hash) throw Error('embedded input mismatch: ' + name);
    }
    fs.writeFileSync(args[args.indexOf('--iidfile')+1], image); state.builds++; break;
  }
  case 'volume': {
    const name = args.at(-1);
    if (args[1] === 'create') state.volumes[name] ??= { Name: name, Driver: 'local', Options: {}, Labels: labels() };
    else if (!state.volumes[name]) missing('volume');
    out(args[1] === 'inspect' ? [state.volumes[name]] : name); break;
  }
  case 'run': out(args.at(-1).includes('claude --version') ? '2.1.267 (Claude Code)' : 'codex-cli 0.153.4'); break;
  case 'create': state.helper = { Id: id, Name: '/' + args[args.indexOf('--name')+1], Config: { Image: image, Labels: labels() } }; out(id); break;
  case 'start': break;
  case 'container': if (!state.helper) missing('container'); out([state.helper]); break;
  case 'rm': if (args.includes(id)) delete state.helper; break;
  default: throw Error('Unexpected Docker command ' + args);
}
fs.writeFileSync(statePath, JSON.stringify(state));
`, { mode: 0o700 });
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ agent_id: 'compiled-init', server_token: 'fixture', custom: 'keep' }));
  const env = { ...process.env, FIXTURE_ROOT: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    ANTHROPIC_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture' };
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) delete env[name];
  for (const kind of ['claude', 'claude', 'codex']) {
    const result = spawnSync(binary, ['container', 'init', kind, '--config', config, '--image', 'fixture:local',
      '--storage-mib', '64', '--storage-capacity-mib', '128', '--storage-reserve-mib', '64'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const saved = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(saved.custom, 'keep');
  assert.deepEqual(saved.backends.claude.caller_runtime.fixedImageStorage, saved.backends.codex.caller_runtime.fixedImageStorage);
  assert.equal(saved.backends.claude.caller_runtime.fixedImageStorage.capacityMiB, 128);
  const docker = JSON.parse(await readFile(join(dir, 'docker.json'), 'utf8'));
  assert.equal(docker.builds, 2, 'reinitialization reuses its pinned helper');
  assert.equal(docker.helper, undefined);
  console.log('PASS compiled CLI outside checkout: exact embedded helper inputs, both backends, policy, reinitialization and cleanup');
} finally { await rm(dir, { recursive: true, force: true }); }
