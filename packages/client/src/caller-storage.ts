import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallerRuntimeOptions } from './caller-runtime-config.js';
import type { CallerRuntimeStore } from './caller-runtime-store.js';
import type { AsyncDockerRun } from './docker-command.js';

const Record = z.object({
  uuid: z.string().uuid(),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  pool: z.string(),
  size: z.number().int().positive(),
}).strict();

/** Only the operator helper sees the backing pool and daemon devices. */
export class CallerStorage {
  constructor(private readonly options: CallerRuntimeOptions,
    private readonly store: CallerRuntimeStore, private readonly run: AsyncDockerRun) {}

  async record(id: string) {
    const raw = await this.store.fixedStorage(id);
    if (!raw) throw new Error('legacy or incomplete caller storage; automatic migration is not supported; preserve/export existing data before opting into fixed images');
    const record = Record.parse(JSON.parse(raw));
    const policy = this.options.fixedImageStorage;
    if (!policy || record.pool !== policy.poolVolume || record.size !== this.options.storageMiB * 1048576 ||
        record.key !== this.key(id))
      throw new Error('retained caller storage configuration changed; restore its original pool and capacity');
    return record;
  }
  private key(id: string) {
    return createHash('sha256').update(`${this.store.namespace}:${id}`).digest('hex');
  }
  async reserve(id: string) {
    const policy = this.options.fixedImageStorage!;
    await this.store.recordFixedStorage(id, JSON.stringify({
      uuid: randomUUID(), key: this.key(id), pool: policy.poolVolume,
      size: this.options.storageMiB * 1048576,
    }));
  }
  async initialize() {
    const policy = this.options.fixedImageStorage!;
    const result = await this.run(['volume', 'inspect', policy.poolVolume]);
    if (result.exitCode !== 0) throw new Error('storage pool missing; create the dedicated operator-managed pool before starting');
    const [volume] = JSON.parse(result.stdout);
    if (volume.Name !== policy.poolVolume || volume.Driver !== 'local' ||
        Object.keys(volume.Options ?? {}).length || volume.Labels?.['vicoop.component'] !== 'caller-storage-pool')
      throw new Error('storage pool ownership or driver mismatch');
    if (policy.capacityMiB < this.options.storageMiB) throw new Error('storage pool capacity is smaller than a scope');
  }
  async device(id: string) { return `/dev/disk/by-uuid/${(await this.record(id)).uuid}`; }
  async manage(action: 'create' | 'attach' | 'check' | 'delete', id: string, signal?: AbortSignal) {
    const policy = this.options.fixedImageStorage!;
    const record = await this.record(id);
    const name = `vb-storage-${randomUUID()}`;
    signal?.throwIfAborted();
    try {
      const result = await this.run(['run', '--name', name, '--rm', '--privileged',
        '--network', 'none', '--read-only', '--log-driver', 'none',
        '--tmpfs', '/mnt:rw,nosuid,nodev', '--tmpfs', '/tmp:rw,nosuid,nodev',
        '--mount', 'type=bind,src=/dev,dst=/dev',
        '--mount', `type=volume,src=${policy.poolVolume},dst=/pool`,
        policy.image, action, record.key, record.uuid, String(record.size),
        String(policy.capacityMiB * 1048576), String(policy.reserveMiB * 1048576)],
      { signal, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(`caller storage ${action} failed: ${result.stderr.trim()}`);
      signal?.throwIfAborted();
    } finally {
      // Killing the local docker CLI does not stop a remote privileged helper.
      // Do not release the caller lease until daemon-side termination is confirmed.
      const removed = await this.run(['rm', '-f', name], { timeoutMs: 30_000 });
      if (removed.exitCode !== 0 && !/No such (container|object)/i.test(removed.stderr))
        throw new Error('storage helper termination unconfirmed; inspect Docker before retrying');
    }
  }
}
