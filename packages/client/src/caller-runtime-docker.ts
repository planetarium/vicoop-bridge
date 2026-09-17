import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { runDockerCommand, type AsyncDockerRun } from './docker-command.js';
import { CallerRuntimeStore } from './caller-runtime-store.js';
import { brokerFirewallScript } from './execution-runtime-boundary.js';
import { PROVIDER_ENV_PATTERN } from './provider-environment.js';
import type { CallerRuntimeOptions } from './caller-runtime-config.js';

export type CallerKind = 'claude' | 'codex';
export interface CallerContainer {
  id: string;
  name: string;
  recovered: boolean;
}

// This pool owns containers, not executions. Callers hold a per-scope lease
// while acquiring, executing, checking storage, or stopping a container.
export class DockerCallerRuntimePool {
  readonly store: CallerRuntimeStore;
  private readonly containers = new Map<string, CallerContainer>();
  private readonly run: AsyncDockerRun;
  private locked = false;
  constructor(
    readonly kind: CallerKind,
    readonly options: CallerRuntimeOptions,
    agentId: string,
    run: AsyncDockerRun = runDockerCommand,
  ) {
    this.store = new CallerRuntimeStore(options.stateDirectory, agentId);
    this.run = (args, options) => run(args, { timeoutMs: 10000, ...options });
  }
  private async command(args: string[]): Promise<string> {
    const result = await this.run(args);
    if (result.exitCode !== 0)
      throw new Error(
        `caller Docker ${args[0]} failed; inspect managed runtime resources`,
      );
    return result.stdout;
  }
  name(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    return `vb-caller-${this.store.namespace.slice(0, 16)}-${id}`;
  }
  private labels(id: string): Record<string, string> {
    return {
      'vicoop.component': 'caller-runtime',
      'vicoop.caller-namespace': this.store.namespace,
      'vicoop.scope': id,
      'vicoop.kind': this.kind,
    };
  }
  private labelArgs(id: string): string[] {
    return Object.entries(this.labels(id)).flatMap(([k, v]) => [
      '--label',
      `${k}=${v}`,
    ]);
  }
  async initialize(reconcile = true): Promise<string[]> {
    if (process.platform === 'win32')
      throw new Error('caller-container requires Linux or macOS Docker');
    await this.store.lock();
    this.locked = true;
    try {
      const [image] = JSON.parse(
        await this.command(['image', 'inspect', this.options.image]),
      );
      if (
        Object.keys(image.Config?.Volumes ?? {}).length ||
        image.Config?.Env?.some((v: string) =>
          PROVIDER_ENV_PATTERN.test(v.split('=', 1)[0]),
        )
      )
        throw new Error(
          'caller image must not declare volumes or provider environment',
        );
      const ids = await this.store.scopes();
      if (ids.length > this.options.maxScopes)
        throw new Error('retained scopes exceed maxScopes');
      const resources = await this.command([
        'ps',
        '-a',
        '--format',
        '{{.Names}}',
        '--filter',
        `label=vicoop.caller-namespace=${this.store.namespace}`,
      ]);
      const known = new Set(ids.map((id) => this.name(id)));
      if (
        resources
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .some((name) => !known.has(name))
      )
        throw new Error(
          'unrecorded caller container requires offline inspection',
        );
      // Only a dead previous owner may be reconciled (store.lock enforces this).
      // Validate before stopping. Never delete or adopt mismatched resources.
      for (const id of ids) {
        await this.store.reserve(id, this.kind);
        const info = await this.inspect(this.name(id));
        if (info) {
          this.validate(info, id);
          if (!reconcile && info.State.Running)
            throw new Error(
              'stop the daemon and managed containers before offline administration',
            );
          if (reconcile) await this.stop(id);
        }
      }
      return ids;
    } catch (error) {
      await this.store.unlock();
      this.locked = false;
      throw error;
    }
  }
  private async inspect(name: string): Promise<any | undefined> {
    const result = await this.run(['container', 'inspect', name]);
    if (result.exitCode === 0) return JSON.parse(result.stdout)[0];
    if (/No such (object|container)/i.test(result.stderr)) return undefined;
    throw new Error('cannot inspect caller container');
  }
  private validate(c: any, id: string): void {
    const fail = () => {
      throw new Error(
        'caller container ownership or isolation boundary mismatch',
      );
    };
    const h = c.HostConfig,
      config = c.Config;
    if (
      Object.entries(this.labels(id)).some(
        ([k, v]) => config?.Labels?.[k] !== v,
      ) ||
      (c.Image !== this.options.image.replace(/^.*@/, '') &&
        config?.Image !== this.options.image) ||
      config?.User !== '1000:1000' ||
      JSON.stringify(config.Entrypoint) !== JSON.stringify(['/usr/bin/tini']) ||
      JSON.stringify(config.Cmd) !==
        JSON.stringify(['--', '/bin/sleep', 'infinity']) ||
      !h?.ReadonlyRootfs ||
      h.Privileged ||
      h.NetworkMode !== `${this.name(id)}-net` ||
      h.PidMode ||
      h.UsernsMode ||
      !['', 'private', undefined].includes(h.IpcMode) ||
      h.Devices?.length ||
      h.DeviceRequests?.length ||
      h.VolumesFrom?.length ||
      Object.keys(h.PortBindings ?? {}).length ||
      h.RestartPolicy?.Name !== 'no' ||
      !h.SecurityOpt?.includes('no-new-privileges') ||
      h.SecurityOpt?.some((v: string) => /unconfined/.test(v)) ||
      h.CapAdd?.some(
        (v: string) => !['NET_ADMIN'].includes(v.replace(/^CAP_/, '')),
      ) ||
      !h.CapAdd?.some((v: string) => v.replace(/^CAP_/, '') === 'NET_ADMIN') ||
      h.Memory !== this.options.memoryMiB * 1048576 ||
      h.MemorySwap !== h.Memory ||
      h.PidsLimit !== this.options.pids ||
      h.NanoCpus !== this.options.cpus * 1e9 ||
      config.Env?.some((v: string) =>
        PROVIDER_ENV_PATTERN.test(v.split('=', 1)[0]),
      )
    )
      fail();
    const mounts = new Map<string, string>([
      ['/workspace', `${this.name(id)}-workspace`],
      [`/data/sessions/${this.kind}`, `${this.name(id)}-sessions`],
    ]);
    for (const m of c.Mounts ?? []) {
      if (m.Type === 'tmpfs' && ['/tmp', '/home/node'].includes(m.Destination))
        continue;
      if (m.Type !== 'volume' || mounts.get(m.Destination) !== m.Name || !m.RW)
        fail();
      mounts.delete(m.Destination);
    }
    if (
      mounts.size ||
      Object.keys(h.Tmpfs ?? {}).some(
        (p) => !['/tmp', '/home/node'].includes(p),
      )
    )
      fail();
    if (
      !config.Env?.includes(
        `${this.kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}=/data/sessions/${this.kind}/config`,
      )
    )
      fail();
  }
  private async volumeExists(id: string, suffix: string): Promise<boolean> {
    const found = await this.run([
      'volume',
      'inspect',
      `${this.name(id)}-${suffix}`,
    ]);
    if (found.exitCode !== 0) {
      if (/no such volume/i.test(found.stderr)) return false;
      throw new Error('cannot inspect caller volume');
    }
    const [volume] = JSON.parse(found.stdout);
    if (
      Object.entries(this.labels(id)).some(
        ([k, v]) => volume.Labels?.[k] !== v,
      ) ||
      volume.Driver !== 'local' ||
      Object.keys(volume.Options ?? {}).length
    )
      throw new Error('caller volume ownership or storage boundary mismatch');
    return true;
  }
  async acquire(
    id: string,
    signal?: AbortSignal,
    principalId?: string,
  ): Promise<CallerContainer> {
    if (!this.locked) throw new Error('caller pool is not initialized');
    signal?.throwIfAborted();
    const command = (args: string[]) => {
      signal?.throwIfAborted();
      return this.command(args);
    };
    const name = this.name(id);
    await this.store.reserve(id, this.kind, principalId); // reserve before the first Docker mutation
    let info = await this.inspect(name);
    const recovered = !!info;
    if (!info) {
      for (const suffix of ['workspace', 'sessions']) {
        const volume = `${name}-${suffix}`;
        if (!(await this.volumeExists(id, suffix))) {
          await command(['volume', 'create', ...this.labelArgs(id), volume]);
        }
      }
      const network = await this.run(['network', 'inspect', `${name}-net`]);
      if (network.exitCode === 0) {
        const [n] = JSON.parse(network.stdout);
        if (
          Object.entries(this.labels(id)).some(
            ([k, v]) => n.Labels?.[k] !== v,
          ) ||
          Object.keys(n.Containers ?? {}).length
        )
          throw new Error('caller network ownership mismatch');
      } else {
        if (!/No such network|not found/i.test(network.stderr))
          throw new Error('cannot inspect caller network');
        await command([
          'network',
          'create',
          ...this.labelArgs(id),
          `${name}-net`,
        ]);
      }
      await command([
        'create',
        '--name',
        name,
        ...this.labelArgs(id),
        '--network',
        `${name}-net`,
        '--restart',
        'no',
        '--read-only',
        '--user',
        '1000:1000',
        '--security-opt',
        'no-new-privileges',
        '--cap-add',
        'NET_ADMIN',
        '--memory',
        String(this.options.memoryMiB * 1048576),
        '--memory-swap',
        String(this.options.memoryMiB * 1048576),
        '--cpus',
        String(this.options.cpus),
        '--pids-limit',
        String(this.options.pids),
        '--log-driver',
        'none',
        '--mount',
        `type=volume,source=${name}-workspace,target=/workspace`,
        '--mount',
        `type=volume,source=${name}-sessions,target=/data/sessions/${this.kind}`,
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
        '--tmpfs',
        '/home/node:rw,nosuid,nodev,size=16777216,uid=1000,gid=1000,mode=0700',
        '--env',
        `${this.kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}=/data/sessions/${this.kind}/config`,
        '--env',
        'HOME=/home/node',
        '--env',
        'DISABLE_AUTOUPDATER=1',
        '--workdir',
        '/workspace',
        '--entrypoint',
        '/usr/bin/tini',
        this.options.image,
        '--',
        '/bin/sleep',
        'infinity',
      ]);
      info = await this.inspect(name);
    }
    signal?.throwIfAborted();
    this.validate(info, id);
    for (const suffix of ['workspace', 'sessions'])
      if (!(await this.volumeExists(id, suffix)))
        throw new Error('caller volume missing');
    if (!info.State.Running) await command(['start', name]);
    await command([
      'exec',
      '--user',
      '0',
      name,
      '/bin/sh',
      '-c',
      brokerFirewallScript(),
    ]);
    await this.checkStorage(id);
    signal?.throwIfAborted();
    const container = { id, name, recovered };
    this.containers.set(id, container);
    return container;
  }
  async checkStorage(id: string): Promise<void> {
    const output = await this.command([
      'exec',
      '--user',
      '0',
      this.name(id),
      '/usr/bin/du',
      '-skx',
      '/workspace',
      `/data/sessions/${this.kind}`,
    ]);
    const sizes = output
      .trim()
      .split('\n')
      .map((line) => Number(line.split(/\s+/)[0]));
    if (
      sizes.length !== 2 ||
      sizes.some((n) => !Number.isFinite(n)) ||
      sizes.reduce((a, b) => a + b, 0) > this.options.storageMiB * 1024
    )
      throw new Error('caller storage limit exceeded');
  }
  async stop(id: string): Promise<void> {
    const name = this.name(id),
      info = await this.inspect(name);
    if (!info) {
      this.containers.delete(id);
      return;
    }
    this.validate(info, id);
    await this.command(['stop', '-t', '0', name]);
    const stopped = await this.inspect(name);
    if (stopped?.State.Running)
      throw new Error('caller termination unconfirmed');
    this.containers.delete(id);
  }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    await Promise.all(
      (await this.store.scopes()).map(async (id) => {
        try {
          await this.stop(id);
        } catch (e) {
          errors.push(e);
        }
      }),
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        'caller shutdown unconfirmed; ownership retained',
      );
    if (this.locked) {
      await this.store.unlock();
      this.locked = false;
    }
  }
  // Offline administration must hold the same owner lock as the daemon.
  async remove(id: string, deleteData: boolean): Promise<void> {
    if (!this.locked) throw new Error('caller pool is not initialized');
    await this.stop(id);
    const name = this.name(id);
    if (await this.inspect(name)) await this.command(['rm', name]);
    const network = await this.run(['network', 'inspect', `${name}-net`]);
    if (network.exitCode === 0) {
      const [n] = JSON.parse(network.stdout);
      if (
        Object.entries(this.labels(id)).some(([k, v]) => n.Labels?.[k] !== v) ||
        Object.keys(n.Containers ?? {}).length
      )
        throw new Error('caller network ownership mismatch');
      await this.command(['network', 'rm', `${name}-net`]);
    } else if (!/No such network|not found/i.test(network.stderr))
      throw new Error('cannot inspect caller network');
    if (deleteData) {
      for (const suffix of ['workspace', 'sessions'])
        if (await this.volumeExists(id, suffix))
          await this.command(['volume', 'rm', `${name}-${suffix}`]);
      await this.store.forget(id);
    }
  }
  async inputDirectory(id: string): Promise<string> {
    const path = `/tmp/vicoop-input-${randomUUID()}`;
    await this.command([
      'exec',
      '--user',
      '1000:1000',
      this.name(id),
      '/bin/mkdir',
      '-m',
      '700',
      path,
    ]);
    return path;
  }
  async inputWrite(id: string, path: string, data: Buffer): Promise<void> {
    if (
      !/^\/tmp\/vicoop-input-[a-f0-9-]+\/image-\d+\.[a-z]+$/.test(path) ||
      data.length > 20 * 1048576
    )
      throw new Error('invalid caller input');
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn(
        'docker',
        [
          'exec',
          '-i',
          '--user',
          '1000:1000',
          this.name(id),
          '/usr/local/bin/node',
          '-e',
          'const fs=require("fs");const s=fs.createWriteStream(process.argv[1],{flags:"wx",mode:384});s.on("error",()=>process.exit(1));process.stdin.pipe(s);',
          path,
        ],
        { stdio: ['pipe', 'ignore', 'ignore'] },
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('input transfer timed out'));
      }, 30000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('close', (c) => {
        clearTimeout(timer);
        c === 0 ? resolve() : reject(new Error('input transfer failed'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(data);
    });
  }
  async inputRemove(id: string, path: string): Promise<void> {
    if (!/^\/tmp\/vicoop-input-[a-f0-9-]+$/.test(path))
      throw new Error('invalid caller input directory');
    await this.command([
      'exec',
      '--user',
      '1000:1000',
      this.name(id),
      '/bin/rm',
      '-rf',
      '--',
      path,
    ]);
  }
}
