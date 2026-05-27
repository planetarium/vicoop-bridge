import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createLogger, type Logger } from '../logger.js';

// Slim subset of ChildProcess the supervisor uses. Tests inject a fake.
export interface VicoopCodexChildHandle {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface VicoopCodexSpawnOptions {
  cwd?: string;
}

export type VicoopCodexSpawnFn = (
  command: string,
  args: readonly string[],
  options: VicoopCodexSpawnOptions,
) => VicoopCodexChildHandle;

export interface ServeSupervisorOptions {
  command?: string;
  cwd?: string;
  extraArgs?: readonly string[];
  spawn?: VicoopCodexSpawnFn;
  stderrCaptureBytes?: number;
  startupTimeoutMs?: number;
  logger?: Logger;
}

export interface ListeningInfo {
  host: string;
  port: number;
  url: string;
}

export interface CloseReason {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: unknown;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: VicoopCodexSpawnOptions,
): VicoopCodexChildHandle {
  // Same Windows-shim handling as the legacy subprocess-per-call code.
  return nodeSpawn(command, Array.from(args), {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...(options.cwd ? { cwd: options.cwd } : {}),
  }) as ChildProcess;
}

// Long-running `vicoop-codex serve --port 0` child. Spawns once, parses the
// machine-parseable JSON banner the CLI emits as its first stderr line to
// discover the bound port, then exposes `getBaseUrl()` for the backend
// `handle()` to POST against. Modeled on AppServerRpcClient (codex-rpc.ts).
export class ServeSupervisor {
  private readonly command: string;
  private readonly baseArgs: readonly string[];
  private readonly cwd?: string;
  private readonly spawnFn: VicoopCodexSpawnFn;
  private readonly stderrCap: number;
  private readonly startupTimeoutMs: number;
  private readonly logger?: Logger;

  private child: VicoopCodexChildHandle | null = null;
  private stderrTail = '';
  private stderrBuf = '';
  private listening: ListeningInfo | null = null;
  private readyWaiters: Array<{
    resolve: (info: ListeningInfo) => void;
    reject: (err: Error) => void;
  }> = [];
  private startupTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private closeReason: CloseReason | null = null;
  private readonly closeWaiters = new Set<(reason: CloseReason) => void>();

  constructor(opts: ServeSupervisorOptions = {}) {
    this.command = opts.command ?? 'vicoop-codex';
    this.baseArgs = [
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      ...(opts.extraArgs ?? []),
    ];
    this.cwd = opts.cwd;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.stderrCap = opts.stderrCaptureBytes ?? 16 * 1024;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 10_000;
    this.logger = opts.logger;
  }

  // Spawn the child and arm the stderr listener. Throws synchronously on
  // spawn(2) failure (ENOENT for a missing binary, etc.).
  start(): void {
    if (this.child) throw new Error('ServeSupervisor.start called twice');
    if (this.closed) throw new Error('ServeSupervisor.start called after close');
    const child = this.spawnFn(this.command, this.baseArgs, { cwd: this.cwd });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.appendStderr(s);
      if (!this.listening) this.scanForListening(s);
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      // `serve` doesn't write to stdout in normal operation. Capture into
      // stderrTail so unexpected output still surfaces on failure.
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.appendStderr(s);
    });
    child.on('error', (err) => this.handleClose({ error: err }));
    child.on('close', (code, signal) => this.handleClose({ code, signal }));

    if (this.startupTimeoutMs > 0) {
      this.startupTimer = setTimeout(() => {
        if (this.listening || this.closed) return;
        this.fail(
          new Error(
            `vicoop-codex serve failed to report a listening port within ${this.startupTimeoutMs}ms` +
              (this.stderrTail ? `; stderr tail: ${this.stderrTail.trim()}` : ''),
          ),
        );
      }, this.startupTimeoutMs);
    }
  }

  // Resolves once the child has printed its listening banner. Rejects if the
  // child exits or times out before then.
  ready(): Promise<ListeningInfo> {
    if (this.listening) return Promise.resolve(this.listening);
    if (this.closed) {
      return Promise.reject(this.closeError('vicoop-codex serve exited before becoming ready'));
    }
    return new Promise<ListeningInfo>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  // Resolves when the child exits. Used by the backend to drop the singleton
  // and lazily respawn on the next task.
  waitForClose(): Promise<CloseReason> {
    if (this.closed) return Promise.resolve(this.closeReason ?? {});
    return new Promise((resolve) => {
      this.closeWaiters.add(resolve);
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  getListening(): ListeningInfo | null {
    return this.listening;
  }

  // Last N bytes of stderr+stdout. Surfaced in task.fail messages so an
  // operator can diagnose without enabling --verbose.
  getStderrTail(): string {
    return this.stderrTail;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.child || this.closed) return;
    try {
      this.child.kill(signal);
    } catch {
      // best-effort
    }
  }

  private appendStderr(s: string): void {
    if (this.stderrTail.length >= this.stderrCap) {
      this.stderrTail = (this.stderrTail + s).slice(-this.stderrCap);
    } else {
      this.stderrTail += s;
      if (this.stderrTail.length > this.stderrCap) {
        this.stderrTail = this.stderrTail.slice(-this.stderrCap);
      }
    }
  }

  // Buffer stderr line-by-line until we find a JSON object with
  // `event: "listening"`. The CLI emits this as the FIRST stderr line,
  // followed by a human banner — we tolerate other lines in case stderr
  // ordering shifts.
  private scanForListening(chunk: string): void {
    this.stderrBuf += chunk;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl).trim();
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (line.length === 0) continue;
      if (line.charAt(0) !== '{') continue;
      try {
        const parsed = JSON.parse(line) as {
          event?: string;
          host?: string;
          port?: number;
          url?: string;
        };
        if (
          parsed.event === 'listening' &&
          typeof parsed.host === 'string' &&
          typeof parsed.port === 'number' &&
          typeof parsed.url === 'string'
        ) {
          this.markReady({ host: parsed.host, port: parsed.port, url: parsed.url });
          return;
        }
      } catch {
        // not the line we're looking for
      }
    }
  }

  private markReady(info: ListeningInfo): void {
    this.listening = info;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve(info);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.logger?.warn?.(`[vicoop-codex] supervisor failed: ${err.message}`);
    this.kill();
    if (!this.closed) {
      // close handler may not fire on a spawn that never wired stdio; finalize
      // synchronously so callers don't hang.
      this.handleClose({ error: err });
    }
  }

  private handleClose(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    const err = this.closeError('vicoop-codex serve exited before becoming ready');
    for (const w of waiters) w.reject(err);
    const closeListeners = [...this.closeWaiters];
    this.closeWaiters.clear();
    for (const cb of closeListeners) cb(reason);
  }

  private closeError(prefix: string): Error {
    const r = this.closeReason;
    const detail = r?.error
      ? `: ${(r.error as Error).message ?? String(r.error)}`
      : r?.code !== undefined && r?.code !== null
        ? ` (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ''})`
        : r?.signal
          ? ` (signal ${r.signal})`
          : '';
    const tail = this.stderrTail.trim();
    return new Error(`${prefix}${detail}${tail ? `; stderr tail: ${tail}` : ''}`);
  }
}
