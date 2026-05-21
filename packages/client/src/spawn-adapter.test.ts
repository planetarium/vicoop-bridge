import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDockerExecSpawn } from './spawn-adapter.js';

// Stub RuntimeContainer surface that spawn-adapter consumes:
// only `exec()` (returns an Exec-like) and `getDocker()` (whose
// `modem.demuxStream` splits the duplex stream into stdout/stderr).
function makeRuntimeStub(opts: {
  execScript?: (stream: PassThrough) => void;
  exitCode?: number | null;
  execStartShouldThrow?: boolean;
}) {
  const stream = new PassThrough();
  const execEvents = new EventEmitter();
  const exec = {
    async start(_opts: { hijack: boolean; stdin: boolean }) {
      if (opts.execStartShouldThrow) throw new Error('exec failed to start');
      // Schedule the script to run after the consumer wires
      // listeners (microtask boundary). Simulates the real docker
      // hijack stream pushing data after start resolves.
      queueMicrotask(() => opts.execScript?.(stream));
      return stream;
    },
    async inspect() {
      return { ExitCode: opts.exitCode ?? 0 };
    },
  };
  const recordedCmds: Array<{ command: string; args: readonly string[] }> = [];
  const runtime = {
    async exec(spec: { command: string; args: readonly string[]; cwd?: string }) {
      recordedCmds.push({ command: spec.command, args: spec.args });
      return exec;
    },
    getDocker() {
      return {
        modem: {
          demuxStream(src: PassThrough, stdout: PassThrough, stderr: PassThrough) {
            // Trivial demux: forward all data to stdout. Tests that
            // care about stderr can write a multiplex-like marker
            // themselves; the real dockerode protocol's framing is
            // out of scope for unit tests.
            src.on('data', (chunk) => stdout.write(chunk));
            src.on('end', () => {
              stdout.end();
              stderr.end();
            });
          },
        },
      };
    },
  };
  return { runtime, stream, exec, execEvents, recordedCmds };
}

test('docker-exec spawn: emits close with the exec exit code after stream ends', async () => {
  const stub = makeRuntimeStub({
    execScript: (stream) => {
      stream.write('hello\n');
      stream.end();
    },
    exitCode: 0,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawn = createDockerExecSpawn(stub.runtime as any);
  const child = spawn('claude', ['--version'], {});

  const collected: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => collected.push(chunk));

  const exit = await new Promise<{ code: number | null }>((resolve) => {
    child.on('close', (code) => resolve({ code }));
  });
  assert.equal(exit.code, 0);
  assert.equal(Buffer.concat(collected).toString(), 'hello\n');
  assert.deepEqual(stub.recordedCmds, [{ command: 'claude', args: ['--version'] }]);
});

test('docker-exec spawn: surfaces start failures as the child error event', async () => {
  const stub = makeRuntimeStub({ execStartShouldThrow: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawn = createDockerExecSpawn(stub.runtime as any);
  const child = spawn('claude', [], {});
  const err = await new Promise<Error>((resolve) => {
    child.on('error', (e) => resolve(e));
  });
  assert.match(err.message, /exec failed to start/);
});

test('docker-exec spawn: kill() ends stdin and is idempotent', async () => {
  const stub = makeRuntimeStub({ execScript: () => {}, exitCode: 137 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawn = createDockerExecSpawn(stub.runtime as any);
  const child = spawn('codex', ['app-server'], {});
  // First kill returns true, second returns false (already killed).
  assert.equal(child.kill('SIGTERM'), true);
  assert.equal(child.kill('SIGTERM'), false);
});
