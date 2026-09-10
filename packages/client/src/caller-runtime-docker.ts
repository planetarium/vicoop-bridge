import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, rename, unlink } from 'node:fs/promises';
import type { ClaudeSpawnFn, ClaudeChildHandle } from './backends/claude.js';
import { runDockerCommand } from './docker-command.js';
import { CallerRuntimeStore } from './caller-runtime-store.js';
import { callerCredentialEnvironment, type CallerCredentialsOptions } from './caller-runtime-credentials.js';

export interface CallerDockerOptions extends CallerCredentialsOptions {
  image: string;
  stateDirectory: string;
  agentId: string;
  maxScopes?: number;
  queueLimit?: number;
  workspaceMiB?: number;
  taskTimeoutMs?: number;
}

export interface CallerTaskRuntime {
  readonly committed?: boolean;
  spawn: ClaudeSpawnFn;
  /** Freeze, snapshot on success, and confirm removal before publishing success. */
  finish(commit: boolean): Promise<void>;
  /** Exact generation container, never a subsequent task's container. */
  cancel(): Promise<void>;
}

export interface CallerRuntimePool {
  readonly maxScopes: number;
  readonly queueLimit: number;
  readonly taskTimeoutMs: number;
  initialize(): Promise<string[]>;
  start(scopeId: string, signal: AbortSignal): Promise<CallerTaskRuntime>;
  close(): Promise<void>;
}

export class DockerCallerRuntimePool implements CallerRuntimePool {
  readonly store: CallerRuntimeStore;
  readonly maxScopes: number;
  readonly queueLimit: number;
  readonly taskTimeoutMs: number;
  private readonly bytes: number;
  private readonly active = new Set<string>();
  private initialized = false;
  constructor(private readonly options: CallerDockerOptions) {
    if (process.platform === 'win32')
      throw new Error(
        'caller-container currently supports Linux and macOS hosts',
      );
    if (
      !/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(options.image)
    ) {
      throw new Error(
        'caller runtime image must be pinned by sha256 ID or repository digest',
      );
    }
    this.maxScopes = bounded(options.maxScopes ?? 8, 1, 32, 'maxScopes');
    this.queueLimit = bounded(options.queueLimit ?? 16, 0, 128, 'queueLimit');
    this.taskTimeoutMs = bounded(
      options.taskTimeoutMs ?? 600_000,
      1000,
      3_600_000,
      'taskTimeoutMs',
    );
    this.bytes =
      bounded(options.workspaceMiB ?? 128, 8, 512, 'workspaceMiB') *
      1024 *
      1024;
    this.store = new CallerRuntimeStore(
      options.stateDirectory,
      options.agentId,
    );
  }
  async initialize(): Promise<string[]> {
    await this.store.lock();
    try {
      await command(['version', '--format', '{{.Server.Version}}']);
      const [image] = JSON.parse(
        await command(['image', 'inspect', this.options.image]),
      );
      if (Object.keys(image.Config?.Volumes ?? {}).length)
        throw new Error(
          'caller image must not declare VOLUME mounts (unbounded storage)',
        );
      await this.credential();
      // Every container in this namespace belongs to a previous owner. Never
      // adopt its mutable mounts/config: remove it before accepting work.
      const stale = await command([
        'ps',
        '-a',
        '--format',
        '{{.Names}}',
        '--filter',
        `label=vicoop.caller-namespace=${this.store.namespace}`,
      ]);
      for (const id of stale.trim().split(/\s+/).filter(Boolean))
        await removeConfirmed(id);
      const networks = await command([
        'network',
        'ls',
        '-q',
        '--filter',
        `label=vicoop.caller-namespace=${this.store.namespace}`,
      ]);
      for (const id of networks.trim().split(/\s+/).filter(Boolean))
        await command(['network', 'rm', id]);
      const scopes = await this.store.scopes();
      if (scopes.length > this.maxScopes)
        throw new Error(
          'retained scopes exceed maxScopes; explicitly remove unused snapshots while stopped',
        );
      for (const id of scopes) {
        if ((await stat(this.store.path(id))).size > this.bytes * 2)
          throw new Error('retained snapshot exceeds configured size limit');
      }
      this.initialized = true;
      return scopes;
    } catch (error) {
      await this.store.unlock();
      throw error;
    }
  }
  private async credential(): Promise<string> {
    return callerCredentialEnvironment(this.options);
  }
  async start(
    scopeId: string,
    signal: AbortSignal,
  ): Promise<CallerTaskRuntime> {
    if (!this.initialized)
      throw new Error('caller runtime pool is not initialized');
    this.store.path(scopeId); // validate before touching Docker or paths
    signal.throwIfAborted();
    const name = `vb-caller-${randomUUID()}`;
    const snapshot = this.store.path(scopeId);
    const pending = this.store.path(scopeId, true);
    let removed = false;
    let committed = false;
    let removal: Promise<void> | undefined;
    const cancel = () =>
      (removal ??= removeConfirmed(name).then(() => {
        removed = true;
        this.active.delete(name);
      }));
    this.active.add(name);
    try {
      const key = await this.credential();
      signal.throwIfAborted();
      // No host mounts, network aliases, Docker socket, shared config, or
      // writable root. Only /state is snapshotted; credentials stay in env.
      await command([
        'network',
        'create',
        '--label',
        `vicoop.caller-namespace=${this.store.namespace}`,
        `${name}-net`,
      ]);
      signal.throwIfAborted();
      await command([
        'create',
        '--name',
        name,
        '--network',
        `${name}-net`,
        '--label',
        `vicoop.caller-namespace=${this.store.namespace}`,
        '--label',
        `vicoop.scope=${scopeId}`,
        '--label',
        'vicoop.component=caller-runtime',
        '--restart',
        'no',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        String(this.bytes + 512 * 1024 * 1024),
        '--memory-swap',
        String(this.bytes + 512 * 1024 * 1024),
        '--cpus',
        '1',
        '--user',
        '0',
        '--workdir',
        '/',
        '--tmpfs',
        `/state:rw,nosuid,nodev,size=${this.bytes},uid=1000,gid=1000,mode=0700`,
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=33554432,mode=1777',
        '--env',
        'HOME=/state/home',
        '--env',
        'CLAUDE_CONFIG_DIR=/state/claude',
        '--env',
        'DISABLE_AUTOUPDATER=1',
        '--env',
        'DISABLE_TELEMETRY=1',
        '--env',
        key,
        '--entrypoint',
        '/bin/sleep',
        this.options.image,
        String(Math.ceil(this.taskTimeoutMs / 1000) + 120),
      ]);
      await command(['start', name]);
      signal.throwIfAborted();
      try {
        const info = await stat(snapshot);
        if (info.size > this.bytes * 2)
          throw new Error('snapshot exceeds configured size limit');
        await archiveTransfer(
          [
            'exec',
            '-i',
            '--user',
            '1000:1000',
            name,
            'tar',
            '--no-same-owner',
            '-xf',
            '-',
            '-C',
            '/state',
          ],
          snapshot,
          'upload',
          this.bytes * 2,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await command([
        'exec',
        '--user',
        '1000:1000',
        name,
        'mkdir',
        '-p',
        '/state/workspace',
        '/state/home',
        '/state/claude',
      ]);
      signal.throwIfAborted();
      return {
        get committed() {
          return committed;
        },
        cancel,
        spawn: this.spawnFor(name, signal),
        finish: async (commit) => {
          try {
            if (commit && !signal.aborted && !removed) {
              await archiveTransfer(
                [
                  'exec',
                  '--user',
                  '1000:1000',
                  name,
                  'node',
                  '-e',
                  FREEZE_AND_SNAPSHOT,
                ],
                pending,
                'download',
                this.bytes * 2,
              );
            }
            await cancel();
            if (commit && !signal.aborted) {
              await rename(pending, snapshot);
              committed = true;
            }
          } finally {
            await cancel();
            await unlink(pending).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
        },
      };
    } catch (error) {
      try {
        await cancel();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'runtime initialization/cleanup failed',
        );
      }
      throw error;
    }
  }
  private spawnFor(name: string, signal: AbortSignal): ClaudeSpawnFn {
    return (executable, originalArgs, options) => {
      const handle = new EventEmitter() as EventEmitter & ClaudeChildHandle;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(handle, { stdin, stdout, stderr });
      let child: ReturnType<typeof spawn> | undefined;
      let canceled = false;
      let closed = false;
      const close = (code: number | null, sig: NodeJS.Signals | null) => {
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', abort);
        stdout.end();
        stderr.end();
        stdin.destroy();
        handle.emit('close', code, sig);
      };
      const abort = () => {
        canceled = true;
        child?.kill('SIGKILL');
        close(null, 'SIGKILL');
      };
      handle.kill = () => {
        abort();
        return true;
      };
      signal.addEventListener('abort', abort, { once: true });
      // Deferred work allows backend listeners and buffered stdin to attach.
      void (async () => {
        const args = [...originalArgs];
        for (let i = 0; i < args.length; i++) {
          if (
            args[i] !== '--append-system-prompt-file' &&
            args[i] !== '--system-prompt-file'
          )
            continue;
          const hostPath = args[++i];
          if (!hostPath || (await stat(hostPath)).size > 4 * 1024 * 1024)
            throw new Error('prompt staging file exceeds 4 MiB');
          const remote = `/tmp/prompt-${randomUUID()}`;
          await archiveTransfer(
            [
              'exec',
              '-i',
              '--user',
              '1000:1000',
              name,
              'sh',
              '-c',
              'cat > "$1"',
              'sh',
              remote,
            ],
            hostPath,
            'upload',
            4 * 1024 * 1024,
          );
          args[i] = remote;
        }
        if (canceled || signal.aborted) {
          close(null, 'SIGKILL');
          return;
        }
        const envArgs: string[] = [];
        for (const [key, value] of Object.entries(options.env ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error('invalid environment variable name');
          envArgs.push('-e', `${key}=${value}`);
        }
        child = spawn(
          'docker',
          [
            'exec',
            '-i',
            '--user',
            '1000:1000',
            '-w',
            '/state/workspace',
            ...envArgs,
            name,
            executable,
            ...args,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        stdin.pipe(child.stdin!);
        child.stdout!.pipe(stdout, { end: false });
        child.stderr!.pipe(stderr, { end: false });
        child.stdin!.on('error', () => {
          /* close/error determines the task outcome */
        });
        child.once('error', (error) => {
          handle.emit('error', error);
          close(null, null);
        });
        child.once('close', close);
      })().catch((error) => {
        if (!closed) {
          handle.emit('error', error);
          close(null, null);
        }
      });
      return handle;
    };
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.active].map(removeConfirmed),
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        'caller runtimes remain quarantined',
      );
    this.active.clear();
    this.initialized = false;
    await this.store.unlock();
  }
}

function bounded(n: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`invalid caller runtime ${field}`);
  return n;
}
async function command(args: string[]): Promise<string> {
  const result = await runDockerCommand(args);
  if (result.exitCode !== 0)
    throw new Error(
      `docker ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  return result.stdout;
}
async function removeConfirmed(id: string): Promise<void> {
  const result = await runDockerCommand(['rm', '-f', id]);
  if (result.exitCode !== 0 && !/No such container/i.test(result.stderr))
    throw new Error(`runtime removal failed: ${result.stderr}`);
  const found = await command([
    'ps',
    '-aq',
    '--filter',
    id.startsWith('vb-caller-') ? `name=^${id}$` : `id=${id}`,
  ]);
  if (found.trim()) throw new Error('runtime removal could not be confirmed');
  if (id.startsWith('vb-caller-')) {
    const net = await runDockerCommand(['network', 'rm', `${id}-net`]);
    if (net.exitCode !== 0 && !/not found|No such network/i.test(net.stderr))
      throw new Error('runtime network cleanup failed');
  }
}

/** Tar streams remain opaque on the host; cap output even for sparse files. */
async function archiveTransfer(
  args: string[],
  path: string,
  direction: 'upload' | 'download',
  limit: number,
): Promise<void> {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`snapshot transfer failed (${code}): ${stderr}`)),
    );
  });
  let count = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      done(
        count > limit
          ? new Error('snapshot exceeds configured size limit')
          : null,
        chunk,
      );
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    child.kill('SIGKILL');
  }, 30_000);
  try {
    if (direction === 'download') child.stdin!.end();
    else child.stdout!.resume();
    const io =
      direction === 'download'
        ? pipeline(
            child.stdout!,
            cap,
            createWriteStream(path, { flags: 'w', mode: 0o600 }),
            { signal: controller.signal },
          )
        : pipeline(createReadStream(path), cap, child.stdin!, {
            signal: controller.signal,
          });
    await Promise.all([exit, io]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    child.kill('SIGKILL');
  }
}

// Docker's archive API omits tmpfs contents. A same-UID supervisor first
// stops every workload process (PID 1 is root and cannot be stopped by it),
// verifies every workload thread is stopped, then archives the live tmpfs.
// No untrusted process remains runnable to mutate the tree during tar.
const FREEZE_AND_SNAPSHOT = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const until = Date.now() + 5000;
let previous = '';
for (;;) {
  try { process.kill(-1, 'SIGSTOP'); } catch (e) { if (!['ESRCH', 'EPERM'].includes(e.code)) throw e; }
  let ready = true;
  const threads = [];
  for (const pid of fs.readdirSync('/proc').filter(x => /^[0-9]+$/.test(x))) {
    if (+pid === process.pid || +pid === 1) continue;
    try {
      for (const tid of fs.readdirSync('/proc/' + pid + '/task')) {
        threads.push(pid + '/' + tid);
        const status = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/status', 'utf8');
        if (!/^State:\\s+[TtZ]\\b/m.test(status)) ready = false;
      }
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
  }
  const current = threads.sort().join(',');
  if (ready && current === previous) break;
  previous = ready ? current : '#unstable';
  if (Date.now() > until) throw new Error('workload freeze could not be confirmed');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const result = spawnSync('tar', ['-cf', '-', '-C', '/state', '.'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status === 0 ? 0 : 1);
`;
