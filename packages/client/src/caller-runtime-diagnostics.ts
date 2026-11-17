import { CommandExecutionError, type DockerCommandResult } from './docker-command.js';

// Never retain command arguments, raw stderr, stdout, or arbitrary exception text.
// Docker exec output can contain workload data; even daemon errors may echo credentials.
export class CallerDockerError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(
    readonly operation: string,
    readonly elapsedMs: number,
    result?: DockerCommandResult,
    failure?: unknown,
  ) {
    const exhausted = operation === 'network create' && result?.exitCode !== 0 &&
      /all predefined address pools have been fully subnetted|could not find an available, non-overlapping IPv4 address pool/i.test(result?.stderr ?? '');
    const code = exhausted ? 'docker_address_pool_exhausted'
      : failure instanceof CommandExecutionError ? `docker_${failure.code}`
      : result ? 'docker_nonzero_exit' : 'docker_command_failed';
    super(`caller Docker ${operation} failed (${code}); inspect managed runtime resources`);
    this.name = 'CallerDockerError';
    this.code = code;
    this.exitCode = result?.exitCode;
    this.stderr = exhausted ? 'Docker default address pools have no available subnet' : '[withheld]';
  }
  readonly exitCode?: number;
}

export function dockerOperation(args: readonly string[]): string {
  const first = args[0];
  if (['network', 'volume', 'container', 'image', 'context'].includes(first) &&
      ['create', 'inspect', 'rm'].includes(args[1])) return `${first} ${args[1]}`;
  return ['create', 'start', 'stop', 'rm', 'exec', 'ps', 'info'].includes(first) ? first : 'unknown';
}

export function callerFailureDiagnostic(error: unknown): Record<string, unknown> {
  // Some cleanup errors wrap the initiating failure. Keep traversal bounded and
  // emit only fields from our typed error; arbitrary cause/message/name is unsafe.
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++, current = current.cause) {
    if (current instanceof CommandExecutionError) return { code: `docker_${current.code}` };
    if (current instanceof CallerDockerError) return {
      code: current.code,
      operation: current.operation,
      stage: current.operation === 'network create' ? 'network' : 'docker',
      exitCode: current.exitCode,
      elapsedMs: current.elapsedMs,
      stderr: current.stderr,
    };
  }
  return { code: 'caller_runtime_failed' };
}
