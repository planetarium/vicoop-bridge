import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDockerExecSpawn } from './spawn-adapter.js';

// Capture spawn invocations so we can assert the docker CLI argv
// shape without actually starting a docker exec. The returned
// "child" is a stand-in EventEmitter with PassThrough streams that
// the backend code accepts as ChildHandle.
function makeSpawnStub() {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (sig?: NodeJS.Signals) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { calls, spawnImpl };
}

const runtimeStub = { getContainerName: () => 'vicoop-runtime-test' };

test('createDockerExecSpawn: argv shape passes through container + command + args', () => {
  const { calls, spawnImpl } = makeSpawnStub();
  const spawn = createDockerExecSpawn(runtimeStub, { spawnImpl });
  spawn('claude', ['--version'], {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args, [
    'exec',
    '-i',
    'vicoop-runtime-test',
    'claude',
    '--version',
  ]);
});

test('createDockerExecSpawn: cwd becomes a docker -w flag', () => {
  const { calls, spawnImpl } = makeSpawnStub();
  const spawn = createDockerExecSpawn(runtimeStub, { spawnImpl });
  spawn('codex', ['app-server'], { cwd: '/workspace' });
  assert.deepEqual(calls[0].args, [
    'exec',
    '-i',
    '-w',
    '/workspace',
    'vicoop-runtime-test',
    'codex',
    'app-server',
  ]);
});

test('createDockerExecSpawn: handle exposes stdin/stdout/stderr + kill', () => {
  const { spawnImpl } = makeSpawnStub();
  const spawn = createDockerExecSpawn(runtimeStub, { spawnImpl });
  const child = spawn('claude', [], {});
  assert.ok(child.stdin, 'stdin available');
  assert.ok(child.stdout, 'stdout available');
  assert.ok(child.stderr, 'stderr available');
  assert.equal(child.kill('SIGTERM'), true);
});
