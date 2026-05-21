// Spawn-time indirection for the external-runtime profile (#249).
//
// Both ClaudeSpawnFn (backends/claude.ts) and AppServerSpawnFn
// (backends/codex-rpc.ts) share the same structural shape:
//
//   (command, args, { cwd? }) => ChildHandle
//
// where ChildHandle is the slim subset of child_process.ChildProcess
// that the backends actually consume (stdin / stdout / stderr / kill /
// on('close'|'error', ...)). Because the two ChildHandle interfaces
// are structurally identical, a single SpawnFn satisfies both — we
// don't need two parallel adapter trees.
//
// Two implementations:
//
//   - createHostSpawn(): the existing behavior (node:child_process.spawn).
//     Used when `backends.<kind>.runtime === 'host'` (the default).
//   - createDockerExecSpawn(runtime): runs the same command inside a
//     long-lived RuntimeContainer via `docker exec`. Returns a
//     ChildHandle that bridges PassThrough streams to the dockerode
//     exec stream — close / error events fire when the remote exec
//     finishes, mirroring what backends expect from a real subprocess.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import type { Exec } from 'dockerode';
import type { RuntimeContainer } from './runtime-container.js';

// Same shape as ClaudeChildHandle / AppServerChildHandle. We keep the
// definition here (instead of importing one of them) so spawn-adapter
// doesn't introduce a circular dependency back into backends/, and so
// it's obvious from the file alone what the contract is.
export interface ChildHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface SpawnOptions {
  cwd?: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildHandle;

// Host implementation. Identical to the per-backend defaultSpawn
// today, exposed here so call sites can always go through the adapter
// indirection regardless of mode.
export function createHostSpawn(): SpawnFn {
  return (command, args, options) =>
    nodeSpawn(command, Array.from(args), {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }) as unknown as ChildHandle;
}

// docker-exec implementation. Each call starts a fresh `docker exec`
// inside the long-lived runtime container; the returned ChildHandle's
// streams are wired to the demuxed exec stream and close events fire
// when the remote process exits (inspect.ExitCode then propagates as
// the `close` listener's `code`).
//
// `kill` is best-effort: dockerode exec has no direct signal channel.
// We close stdin and unpipe streams; if the agent process honors EOF
// on stdin (claude / codex both do for app-server-style protocols)
// it exits promptly. Hard kill via `container.exec(['kill', '-9', pid])`
// is out of scope for this PR — a separate issue if cancel-during-task
// proves laggy in practice.
export function createDockerExecSpawn(runtime: RuntimeContainer): SpawnFn {
  return (command, args, options) => makeDockerExecHandle(runtime, command, args, options);
}

function makeDockerExecHandle(
  runtime: RuntimeContainer,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  let killed = false;
  let execHandle: Exec | undefined;
  let stream: Duplex | undefined;

  // Async setup: build the exec, then wire the stream. Any failure
  // surfaces as a synthetic 'error' event so the backend's existing
  // child.on('error', ...) handler runs unchanged.
  void (async () => {
    try {
      execHandle = await runtime.exec({
        command,
        args,
        cwd: options.cwd,
      });
      // hijack + stdin: returns a duplex stream we can write stdin to
      // and read multiplexed stdout/stderr from.
      stream = (await execHandle.start({
        hijack: true,
        stdin: true,
      })) as unknown as Duplex;

      // demuxStream splits the multiplexed docker stream into stdout
      // and stderr targets. We pass our PassThroughs so consumers (the
      // backends) see independent stdout / stderr like real child
      // processes do.
      runtime.getDocker().modem.demuxStream(stream, stdout, stderr);

      // Forward host-side stdin into the container.
      stdin.pipe(stream);

      stream.on('end', () => {
        // Resolve the exit code via inspect once the stream closes.
        // `inspect()` after end is reliable in dockerode; before it,
        // ExitCode is null.
        void (async () => {
          let code: number | null = null;
          try {
            const info = await execHandle?.inspect();
            code = info?.ExitCode ?? null;
          } catch {
            // Ignore — we still need to emit close so the backend's
            // close handler runs and the task settles.
          }
          stdout.end();
          stderr.end();
          events.emit('close', code, null);
        })();
      });
      stream.on('error', (err) => events.emit('error', err));
    } catch (err) {
      stdout.end();
      stderr.end();
      events.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    stdin,
    stdout,
    stderr,
    kill(_signal) {
      if (killed) return false;
      killed = true;
      // Best-effort: close stdin so an EOF-aware agent shuts down,
      // and forcibly close the docker stream. No signal channel
      // available through dockerode exec.
      try {
        stdin.end();
      } catch {
        // ignore
      }
      try {
        stream?.destroy();
      } catch {
        // ignore
      }
      return true;
    },
    on(event, listener) {
      events.on(event, listener as (...a: unknown[]) => void);
    },
  };
}
