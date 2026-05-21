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
//   - createDockerExecSpawn(runtime): runs the same command inside the
//     RuntimeContainer by shelling out to `docker exec -i`. ChildHandle
//     is satisfied directly by the spawned process — its stdin /
//     stdout / stderr are the host-visible pipes, and `close` /
//     `error` events forward unchanged.
//
// Why shell out to the docker CLI instead of dockerode's
// `exec.start({ hijack: true })`? bun's node:http client doesn't yet
// implement the HTTP 101 'upgrade' event that docker's hijack
// protocol relies on (oven-sh/bun#22412 is the in-flight fix). Under
// node + tsx the dockerode hijack path works; under bun-compiled
// binaries the stream never delivers data and the backend's
// initialize / RPC handshake times out. `docker exec` is provided
// by the same docker installation we already require (Decision §6),
// so it doesn't add a new dependency — it just routes around bun's
// missing http feature until the upstream fix lands.

import { spawn as nodeSpawn } from 'node:child_process';
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

// docker-exec implementation via the `docker` CLI. Each call spawns
// `docker exec -i [-w CWD] <container> <cmd> <args...>` as a host
// child process; the returned ChildHandle is just that subprocess
// (already structurally satisfies ChildHandle). stdin / stdout /
// stderr forward bidirectionally, close fires when the in-container
// process exits, and signals propagate via the docker CLI's own
// handling.
//
// `spawnImpl` is a test seam — production passes through to
// node:child_process.spawn unchanged.
export function createDockerExecSpawn(
  runtime: Pick<RuntimeContainer, 'getContainerName'>,
  opts?: { spawnImpl?: typeof nodeSpawn },
): SpawnFn {
  const containerName = runtime.getContainerName();
  const spawnImpl = opts?.spawnImpl ?? nodeSpawn;
  return (command, args, options) => {
    const dockerArgs = ['exec', '-i'];
    if (options.cwd) dockerArgs.push('-w', options.cwd);
    dockerArgs.push(containerName, command, ...args);
    return spawnImpl('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as ChildHandle;
  };
}
