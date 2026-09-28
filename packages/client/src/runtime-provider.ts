import type { ExecutionScopeV1 } from '@vicoop-bridge/protocol';
import type { SpawnOptions } from './spawn-adapter.js';

/**
 * Contract for the R2 isolated provider; the legacy docker-exec adapter does
 * NOT implement supervised termination and must not be cast to this contract.
 * Authorization, allocation deduplication and leases belong to the router.
 */
export interface RuntimeProvider {
  acquire(scope: ExecutionScopeV1, signal: AbortSignal): Promise<ExecutionRuntime>;
}

export interface ExecutionRuntime {
  readonly scopeId: string;
  readonly runtimeId: string;
  spawn(command: string, args: readonly string[], options: SpawnOptions & {
    executionId: string;
    signal: AbortSignal;
  }): Promise<RuntimeProcess>;
  /** Absolute runtime paths; implementations must enforce allowed roots. */
  upload(hostPath: string, runtimePath: string, signal: AbortSignal): Promise<void>;
  download(runtimePath: string, hostPath: string, signal: AbortSignal): Promise<void>;
  /** Manager must hold exclusive lifecycle ownership, with no active leases. */
  stop(signal: AbortSignal): Promise<void>;
  /** Explicit operation, never implied by stop; refuses active runtimes. */
  deleteData(signal: AbortSignal): Promise<void>;
}

export interface RuntimeProcess {
  readonly executionId: string;
  readonly processId: string;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  /** Resolves only after supervised work is gone; rejects on unknown state. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Terminates the in-runtime process group and observes exit, or rejects. */
  terminate(signal: AbortSignal): Promise<void>;
}
