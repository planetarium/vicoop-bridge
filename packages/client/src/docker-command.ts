import { spawn } from 'node:child_process';

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerCommandOptions {
  timeoutMs?: number;
  /** Preserve progress output for operator-initiated image pulls. */
  inheritOutput?: boolean;
  signal?: AbortSignal;
}

export type AsyncDockerRun = (
  args: readonly string[],
  options?: DockerCommandOptions,
) => DockerCommandResult | Promise<DockerCommandResult>;

/**
 * Bounded, shell-free CLI execution. Timeout/abort describes the local CLI
 * only: Docker may have already accepted a mutation. Callers must reconcile
 * daemon state before retrying; this is not an in-container job supervisor.
 */
export function runDockerCommand(
  args: readonly string[],
  options: DockerCommandOptions = {},
): Promise<DockerCommandResult> {
  return runBoundedCommand('docker', args, options);
}

export function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: DockerCommandOptions = {},
): Promise<DockerCommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('command timeout must be finite and positive'));
  }
  if (options.signal?.aborted) return Promise.reject(new Error('command aborted before start'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, Array.from(args), {
      stdio: ['ignore', options.inheritOutput ? 'inherit' : 'pipe', options.inheritOutput ? 'inherit' : 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? -1,
      });
    };
    const stop = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Do not wait indefinitely for close (e.g. inherited descendant pipes).
      // This promise does not certify that a remote Docker operation stopped.
      finish(error);
    };
    const abort = () => stop(new Error('command aborted; Docker state may require reconciliation'));
    const timer = setTimeout(() => stop(new Error(`command timed out after ${timeoutMs}ms; Docker state may require reconciliation`)), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(new Error('command output exceeded 1 MiB'));
      else target.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(failure, code));
  });
}
