import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the actual smoke entrypoint against a disposable fake Docker CLI. This
// exercises exit status and cleanup without altering real Docker resources or
// rewriting the script under test. The fake executable is POSIX-only.
const smoke = fileURLToPath(new URL('../scripts/runtime-foundations-smoke.ts', import.meta.url));
const fakeDocker = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VICOOP_SMOKE_FIXTURE;
const mode = process.env.VICOOP_SMOKE_FAILURE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args) + '\\n');
const statePath = path.join(root, 'state');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { exists: false, running: false, stops: 0 };
function fail(message) { process.stderr.write(message); process.exitCode = 1; }
switch (args[0]) {
  case 'version':
    if (mode === 'work-failure') fail('original daemon failure');
    else process.stdout.write('27.4.0');
    break;
  case 'ps': if (state.exists) process.stdout.write('container-id'); break;
  case 'image': break;
  case 'volume':
    if (args[1] === 'inspect') fail('no such volume');
    else if (args[1] === 'rm' && mode === 'missing') fail('no such volume');
    else if (args[1] === 'rm' && ['nonzero', 'work-failure'].includes(mode)) fail('volume cleanup denied');
    break;
  case 'create': state.exists = true; break;
  case 'start': state.running = true; break;
  case 'stop':
    state.running = false;
    if (++state.stops === 2 && mode === 'reject') fs.unlinkSync(__filename);
    break;
  case 'inspect': process.stdout.write(args.includes('{{.State.Running}}') ? String(state.running) : 'running'); break;
  case 'exec':
    if (args.includes('sleep')) setTimeout(() => {}, 200);
    else {
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write('/tmp|literal $value; with spaces|input');
        process.stderr.write('stderr');
      });
    }
    break;
  case 'cp':
    if (args[2].includes(':')) fs.copyFileSync(args[1], path.join(root, 'remote-file'));
    else fs.copyFileSync(path.join(root, 'remote-file'), args[2]);
    break;
  case 'rm':
    if (mode === 'missing') fail('No such container');
    else if (['nonzero', 'work-failure'].includes(mode)) fail('container cleanup denied');
    break;
  default: fail('unexpected command: ' + args[0]);
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

for (const mode of ['success', 'missing', 'nonzero', 'reject', 'work-failure']) {
  test(`runtime smoke cleanup: ${mode}`, { skip: process.platform === 'win32', timeout: 20_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'vicoop-smoke-regression-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    const temp = join(root, 'temp');
    await mkdir(bin);
    await mkdir(temp);
    await writeFile(join(bin, 'docker'), fakeDocker, { mode: 0o755 });
    const result = await new Promise<{ failed: boolean; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ['--import', 'tsx', smoke], {
        timeout: 15_000,
        env: {
          // Do not fall through to the real Docker CLI when the fake removes
          // itself in the ENOENT scenario. Both Node entrypoints use absolute paths.
          ...process.env, PATH: bin, TSX_DISABLE_CACHE: '1',
          TMPDIR: temp, TMP: temp, TEMP: temp,
          VICOOP_SMOKE_FIXTURE: root, VICOOP_SMOKE_FAILURE: mode,
        },
      }, (error, stdout, stderr) => resolve({ failed: error !== null, stdout, stderr }));
    });
    const success = mode === 'success' || mode === 'missing';
    assert.equal(result.failed, !success, result.stderr);
    assert.equal(result.stdout.includes('PASS:'), success, result.stdout);
    assert.deepEqual((await readdir(temp)).filter((name) => name.startsWith('vicoop-runtime-smoke-')), [],
      'local smoke data is removed even if Docker cleanup fails');
    const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    if (mode === 'reject') {
      // The fake Docker binary disappears before cleanup, causing ENOENT for
      // every command. All four failures must be retained in the aggregate.
      for (const prefix of ['runtime', 'agents', 'creds', 'sessions']) {
        assert.match(result.stderr, new RegExp(`cleanup failed: vicoop-${prefix}-r1-smoke-`));
      }
    } else {
      assert.equal(calls.filter((args) => args[0] === 'rm').length, 1);
      assert.equal(calls.filter((args) => args[0] === 'volume' && args[1] === 'rm').length, 3);
    }
    if (mode === 'work-failure') {
      assert.match(result.stderr, /original daemon failure/);
      assert.match(result.stderr, /container cleanup denied/);
      assert.match(result.stderr, /volume cleanup denied/);
    }
  });
}
