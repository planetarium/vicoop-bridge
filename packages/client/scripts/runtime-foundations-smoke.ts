// Explicit opt-in smoke: creates a unique runtime and removes only its own
// container/volumes. Runs under tsx or as a Bun-compiled executable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContainer, agentsVolumeName, credsVolumeName, sessionsVolumeName,
} from '../src/runtime-container.js';
import { runDockerCommand } from '../src/docker-command.js';
import { createDockerExecSpawn } from '../src/spawn-adapter.js';

const name = `r1-smoke-${randomUUID().slice(0, 12)}`;
const kind = 'claude';
const image = process.env.VICOOP_SMOKE_IMAGE ?? 'ghcr.io/planetarium/vicoop-runtime:latest';
const runtime = new RuntimeContainer({
  backendKind: kind, runtimeName: name, image, createIfMissing: true,
  failIfExists: true, skipFirewall: true,
});
const container = runtime.getContainerName();
const directory = await mkdtemp(join(tmpdir(), 'vicoop-runtime-smoke-'));

async function docker(args: string[]) {
  const result = await runDockerCommand(args);
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}

const failures: unknown[] = [];
try {
  await runtime.start();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    await docker(['exec', container, 'sleep', '0.2']);
    assert.ok(ticks > 0, 'Docker commands must not block the host event loop');
  } finally {
    clearInterval(timer);
  }
  const spawn = createDockerExecSpawn(runtime);
  const child = spawn('sh', ['-c', 'IFS= read -r line; printf "%s|%s|%s" "$PWD" "$VB_SMOKE" "$line"; printf "stderr" >&2'], {
    cwd: '/tmp', env: { VB_SMOKE: 'literal $value; with spaces' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  child.stdin!.end('input\n');
  assert.equal(await exit, 0);
  assert.equal(Buffer.concat(stdout).toString(), '/tmp|literal $value; with spaces|input');
  assert.equal(Buffer.concat(stderr).toString(), 'stderr');

  const input = join(directory, 'input.txt');
  const output = join(directory, 'output.txt');
  await writeFile(input, 'persistent smoke data\n');
  const remotePath = '/data/sessions/claude/r1-smoke.txt';
  await docker(['cp', input, `${container}:${remotePath}`]);
  await runtime.stop();
  const reopened = new RuntimeContainer({ backendKind: kind, runtimeName: name, image });
  await reopened.start();
  await docker(['cp', `${container}:${remotePath}`, output]);
  assert.equal(await readFile(output, 'utf8'), 'persistent smoke data\n');
  await reopened.stop();
} catch (error) {
  failures.push(error);
} finally {
  // Always attempt every cleanup, including partial-start failure. Names are
  // unique to this invocation; no pre-existing user runtime is adopted.
  const cleanup = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (cause) {
      failures.push(new Error(`cleanup failed: ${label}`, { cause }));
    }
  };
  await cleanup(container, async () => {
    const result = await runDockerCommand(['rm', '-f', container]);
    if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
      throw new Error(`docker rm exited ${result.exitCode}: ${result.stderr}`);
    }
  });
  for (const volume of [agentsVolumeName(kind, name), credsVolumeName(kind, name), sessionsVolumeName(kind, name)]) {
    await cleanup(volume, async () => {
      const result = await runDockerCommand(['volume', 'rm', volume]);
      if (result.exitCode !== 0 && !/no such volume/i.test(result.stderr)) {
        throw new Error(`docker volume rm exited ${result.exitCode}: ${result.stderr}`);
      }
    });
  }
  await cleanup(directory, () => rm(directory, { recursive: true, force: true }));
}
if (failures.length > 0) throw new AggregateError(failures, 'runtime smoke failed (including cleanup)');
console.log('PASS: lifecycle, responsive event loop, stdio/EOF, cwd/env, file round trip, stop/start persistence, cleanup');
