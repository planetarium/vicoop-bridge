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

const HelperRecord = z.object({
  name: z.string().regex(/^vb-storage-[a-f0-9-]{36}$/),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export class CallerStorageHelperUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super('storage helper termination unconfirmed; scope quarantined until Docker reconciliation succeeds', { cause });
  }
}

/** Only the operator helper sees the backing pool and daemon devices. */
export class CallerStorage {
  private readonly active = new Set<string>();
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
  private labels(id: string, name: string) {
    return {
      'vicoop.component': 'caller-storage-helper',
      'vicoop.caller-namespace': this.store.namespace,
      'vicoop.scope': id,
      'vicoop.helper': name,
    };
  }
  async reconcile(id: string): Promise<void> {
    if (this.active.has(id)) throw new CallerStorageHelperUnconfirmedError();
    await this.cleanup(id);
  }
  private async cleanup(id: string): Promise<void> {
    const raw = await this.store.storageHelper(id);
    if (!raw) return;
    try {
      const helper = HelperRecord.parse(JSON.parse(raw));
      const inspected = await this.run(['container', 'inspect', helper.name], { timeoutMs: 30_000 });
      if (inspected.exitCode !== 0) {
        if (!/No such (container|object)/i.test(inspected.stderr)) throw new Error('cannot inspect storage helper');
        // Creation and starting are separate requests. An unacknowledged create
        // may leave a late STOPPED container, but cannot run privileged work.
        await this.store.clearStorageHelper(id);
        return;
      }
      const [container] = JSON.parse(inspected.stdout);
      if (!/^[a-f0-9]{64}$/.test(container.Id) || container.Name !== `/${helper.name}` ||
          container.Config?.Image !== helper.image ||
          Object.entries(this.labels(id, helper.name)).some(([key, value]) => container.Config?.Labels?.[key] !== value))
        throw new Error('storage helper ownership mismatch');
      // Remove by immutable ID. A delayed start request cannot start a
      // replacement container after this ID is deleted.
      const removed = await this.run(['rm', '-f', container.Id], { timeoutMs: 30_000 });
      if (removed.exitCode !== 0 && !/No such (container|object)/i.test(removed.stderr))
        throw new Error('cannot remove storage helper');
      const checked = await this.run(['container', 'inspect', container.Id], { timeoutMs: 30_000 });
      if (checked.exitCode === 0 || !/No such (container|object)/i.test(checked.stderr))
        throw new Error('storage helper removal not confirmed');
      await this.store.clearStorageHelper(id);
    } catch (error) {
      throw new CallerStorageHelperUnconfirmedError(error);
    }
  }
  async manage(action: 'create' | 'attach' | 'check' | 'delete', id: string, signal?: AbortSignal) {
    const policy = this.options.fixedImageStorage!;
    const record = await this.record(id);
    if (await this.store.storageHelper(id)) throw new CallerStorageHelperUnconfirmedError();
    const name = `vb-storage-${randomUUID()}`;
    signal?.throwIfAborted();
    if (this.active.has(id)) throw new CallerStorageHelperUnconfirmedError();
    this.active.add(id);
    try {
      await this.store.recordStorageHelper(id, JSON.stringify({ name, image: policy.image }));
      try {
        const created = await this.run(['create', '--name', name, '--privileged',
          ...Object.entries(this.labels(id, name)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--network', 'none', '--read-only', '--log-driver', 'none',
          '--tmpfs', '/mnt:rw,nosuid,nodev', '--tmpfs', '/tmp:rw,nosuid,nodev',
          '--mount', 'type=bind,src=/dev,dst=/dev',
          '--mount', `type=volume,src=${policy.poolVolume},dst=/pool`,
          policy.image, action, record.key, record.uuid, String(record.size),
          String(policy.capacityMiB * 1048576), String(policy.reserveMiB * 1048576)],
        { signal, timeoutMs: 30_000 });
        if (created.exitCode !== 0) throw new Error(`cannot create caller storage helper: ${created.stderr.trim()}`);
        const containerId = created.stdout.trim();
        if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('invalid storage helper container ID');
        signal?.throwIfAborted();
        const result = await this.run(['start', '--attach', containerId], { signal, timeoutMs: 300_000 });
        if (result.exitCode !== 0) throw new Error(`caller storage ${action} failed: ${result.stderr.trim()}`);
        signal?.throwIfAborted();
      } finally {
        // Persisted intent survives process death. Do not clear it unless Docker
        // confirms removal; stop/close/startup retry the same reconciliation.
        await this.cleanup(id);
      }
    } finally { this.active.delete(id); }
  }
}
