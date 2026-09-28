import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STORAGE_IMAGE_FILES } from './caller-storage-assets.js';
import { CallerRuntimeConfig, type CallerRuntimeOptions } from './caller-runtime-config.js';
import { CallerRuntimeStore, scopeDigest } from './caller-runtime-store.js';
import { CallerStorage } from './caller-storage.js';
import type { AsyncDockerRun } from './docker-command.js';
import type { InstallableBackendKind } from './backends-manifest.js';
import type { Logger } from './logger.js';
import { writeConfig } from './config.js';

export interface StorageInitOptions {
  storagePool?: string;
  storageMiB?: number;
  storageCapacityMiB?: number;
  storageReserveMiB?: number;
}
const capacityLabel = 'vicoop.storage-capacity-mib';
const reserveLabel = 'vicoop.storage-reserve-mib';
export const DEFAULT_STORAGE_POOL = 'vicoop-caller-storage';

/** A daemon-wide pool is deliberately retained, even when saving client config fails.
 * Docker volume creation publishes immutable policy labels atomically; #509's
 * daemon-side flock/catalog serializes admission and validates that policy again.
 */
export async function prepareCallerStorage(
  runtime: CallerRuntimeOptions, opts: StorageInitOptions & { rebuild?: boolean },
  store: CallerRuntimeStore, kind: InstallableBackendKind, run: AsyncDockerRun, log: Logger,
): Promise<NonNullable<CallerRuntimeOptions['fixedImageStorage']>> {
  const command = async (args: string[], timeoutMs = 30_000) => {
    const result = await run(args, { timeoutMs });
    if (result.exitCode !== 0) throw new Error(`storage initialization: docker ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const previous = runtime.fixedImageStorage;
  const poolVolume = opts.storagePool ?? previous?.poolVolume ?? DEFAULT_STORAGE_POOL;
  if (previous && poolVolume !== previous.poolVolume)
    throw new Error('existing storage pool cannot be changed by init; restore the original policy');
  const desired = {
    image: previous?.image ?? `sha256:${'0'.repeat(64)}`, poolVolume,
    capacityMiB: opts.storageCapacityMiB ?? previous?.capacityMiB ?? runtime.storageMiB * runtime.maxScopes,
    reserveMiB: opts.storageReserveMiB ?? previous?.reserveMiB ?? Math.max(1024, Math.ceil((opts.storageCapacityMiB ?? runtime.storageMiB * runtime.maxScopes) / 10)),
    reservationBoundary: 'docker-filesystem' as const,
  };
  CallerRuntimeConfig.parse({ ...runtime, fixedImageStorage: desired });
  if (previous && (desired.capacityMiB !== previous.capacityMiB || desired.reserveMiB !== previous.reserveMiB))
    throw new Error('existing storage pool policy is immutable; use its original capacity and reserve');
  // Do not adopt the unpublished ordinary-volume format, even for stopped scopes.
  const storage = new CallerStorage({ ...runtime, fixedImageStorage: desired }, store, run);
  for (const id of await store.scopes()) await storage.record(id);

  let image = previous?.image;
  if (!image || opts.rebuild) {
    const context = await mkdtemp(join(tmpdir(), 'vicoop-storage-build-'));
    try {
      for (const [name, content] of Object.entries(STORAGE_IMAGE_FILES)) {
        const target = join(context, name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
      log.info('Building the bundled storage helper in Docker (no host language runtime required).');
      const iid = join(context, 'image-id');
      await command(['build', '--iidfile', iid, '-f', join(context, 'packages/client/container/storage/Dockerfile'), context], 20 * 60_000);
      image = (await readFile(iid, 'utf8')).trim();
    } finally { await rm(context, { recursive: true, force: true }); }
  }
  desired.image = image;
  CallerRuntimeConfig.parse({ ...runtime, fixedImageStorage: desired });
  const [helper] = JSON.parse(await command(['image', 'inspect', image]));
  if (helper?.Id !== image) throw new Error('storage helper immutable image identity mismatch');
  let inspected = await run(['volume', 'inspect', poolVolume]);
  if (inspected.exitCode !== 0) {
    if (!/No such volume/i.test(inspected.stderr)) throw new Error(`cannot inspect storage pool: ${inspected.stderr.trim()}`);
    log.info(`Creating shared storage pool ${poolVolume}; it is retained for reuse if initialization fails.`);
    await command(['volume', 'create', '--driver', 'local', '--label', 'vicoop.component=caller-storage-pool',
      '--label', `${capacityLabel}=${desired.capacityMiB}`, '--label', `${reserveLabel}=${desired.reserveMiB}`, poolVolume]);
    inspected = await run(['volume', 'inspect', poolVolume]);
  }
  if (inspected.exitCode !== 0) throw new Error(`cannot confirm storage pool ${poolVolume}; retry init after restoring Docker connectivity`);
  const [volume] = JSON.parse(inspected.stdout);
  if (volume?.Name !== poolVolume || volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length ||
      volume.Labels?.['vicoop.component'] !== 'caller-storage-pool') throw new Error('storage pool ownership or driver mismatch');
  // Unspecified settings inherit an already-created pool's policy across agents.
  // #509 pools without policy labels are checked against their SQLite catalog.
  for (const [field, label, explicit] of [
    ['capacityMiB', capacityLabel, opts.storageCapacityMiB], ['reserveMiB', reserveLabel, opts.storageReserveMiB],
  ] as const) {
    const value = volume.Labels?.[label];
    if (value !== undefined) {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error('invalid managed storage pool policy label');
      if ((explicit !== undefined || previous) && desired[field] !== Number(value))
        throw new Error('storage pool policy differs from existing pool; use its original capacity and reserve');
      desired[field] = Number(value);
    }
  }
  CallerRuntimeConfig.parse({ ...runtime, fixedImageStorage: desired });
  if (desired.capacityMiB < runtime.storageMiB) throw new Error('storage pool capacity is smaller than a scope');
  log.info(`Storage pool ${poolVolume}: ${desired.capacityMiB} MiB capacity, ${desired.reserveMiB} MiB free-space reserve. Reservation boundary: Docker backing filesystem only; physical space outside thin VM/block devices is not reserved.`);
  await probeStorage({ ...runtime, fixedImageStorage: desired }, store.agentId, kind, run);
  return desired;
}

/** Separate durable state keeps interrupted disposable probes out of caller state.
 * Re-running init reconciles the recorded helper before deleting only its image.
 */
async function probeStorage(runtime: CallerRuntimeOptions, agentId: string, kind: InstallableBackendKind, run: AsyncDockerRun) {
  const directory = join(runtime.stateDirectory, 'storage-init');
  const store = new CallerRuntimeStore(directory, agentId);
  await store.lock();
  const path = join(directory, 'probe.json');
  const id = scopeDigest(agentId, 'storage-initialization-probe');
  try {
    let original: string | undefined;
    try { original = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if ((await store.scopes()).length) {
      if (!original) throw new Error('probe recovery policy missing');
      const old = CallerRuntimeConfig.parse(JSON.parse(original));
      const recovery = new CallerStorage(old, store, run);
      await recovery.initialize();
      for (const scope of await store.scopes()) {
        if (scope !== id) throw new Error('unexpected storage probe identity');
        await recovery.reconcile(scope);
        if (await store.fixedStorage(scope)) await recovery.manage('delete', scope);
        await store.forget(scope);
      }
    }
    const options = { ...runtime, stateDirectory: directory };
    writeConfig(path, options, original);
    const storage = new CallerStorage(options, store, run);
    await storage.initialize();
    await store.reserve(id, kind, 'storage-initialization-probe');
    await storage.reserve(id);
    try { await storage.manage('probe', id); }
    finally {
      await storage.reconcile(id);
      await storage.manage('delete', id);
      await store.forget(id);
    }
  } catch (error) {
    throw new Error(`Fixed storage probe failed: ${error instanceof Error ? error.message : error}. Requires rootful Linux Docker, privileged helpers, loop devices and ext4, plus room for one ${runtime.storageMiB} MiB scope and the pool reserve. Prior config is unchanged. Recovery state: ${directory}; restore Docker access and rerun init with the same policy (use --rebuild if a development helper predates probe support). Never remove the shared pool.`, { cause: error });
  } finally { await store.unlock(); }
}
