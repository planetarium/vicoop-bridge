// Shared process/stdio contract for backend execution adapters.

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
  env?: Record<string, string>;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildHandle;
