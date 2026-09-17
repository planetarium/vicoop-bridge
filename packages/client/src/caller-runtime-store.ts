import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostname } from 'node:os';
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  readdir,
  stat,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const scopeDigest = (agentId: string, principalId: string): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'vicoop-execution-scope',
        'direct-principal-v1',
        agentId,
        principalId,
      ]),
    )
    .digest('hex');

const LegacyScopeRecord = z
  .object({
    id: z.string(),
    kind: z.enum(['claude', 'codex']),
    namespace: z.string(),
  })
  .strict();
const ScopeRecord = LegacyScopeRecord.extend({
  version: z.literal(3),
  agentId: z.string().min(1),
  // null means identity has not yet been observed on a validated request.
  principalId: z.string().min(1).nullable(),
}).strict();

/** Exclusive host ownership record; workload storage lives only in Docker volumes. */
export class CallerRuntimeStore {
  directory: string;
  namespace: string;
  private readonly token = randomUUID();
  private locked = false;
  constructor(
    directory: string,
    readonly agentId: string,
  ) {
    this.directory = resolve(directory);
    this.namespace = createHash('sha256')
      .update(JSON.stringify([hostname(), this.directory, agentId]))
      .digest('hex');
  }
  async lock(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(this.directory);
    this.namespace = createHash('sha256')
      .update(JSON.stringify([hostname(), this.directory, this.agentId]))
      .digest('hex');
    const mode = await stat(this.directory);
    if (mode.mode & 0o077)
      throw new Error(
        'caller runtime state directory must be private (chmod 700)',
      );
    // Serialize *all* owner-file changes. A crash during this short critical
    // section fails closed; the operator must inspect/remove .guard manually.
    const guard = join(this.directory, '.guard');
    await mkdir(guard, { mode: 0o700 });
    try {
      let owner: { pid: number; host: string; agentId: string } | undefined;
      try {
        owner = JSON.parse(
          await readFile(join(this.directory, 'owner.json'), 'utf8'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (owner) {
        if (
          owner.host !== hostname() ||
          owner.agentId !== this.agentId ||
          !Number.isSafeInteger(owner.pid) ||
          owner.pid <= 0
        ) {
          throw new Error(
            'caller runtime owner is incompatible; inspect state before recovery',
          );
        }
        try {
          process.kill(owner.pid, 0);
          throw new Error('caller runtime state already has a live owner');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      const manifestPath = join(this.directory, 'manifest.json');
      const expected = { version: 3, agentId: this.agentId, host: hostname() };
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (
          ![2, 3].includes(manifest.version) ||
          manifest.agentId !== this.agentId ||
          manifest.host !== hostname()
        ) {
          throw new Error(
            'caller state manifest is incompatible with this agent/host/version',
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(manifestPath, JSON.stringify(expected), {
          mode: 0o600,
          flag: 'wx',
        });
      }
      // Upgrade the manifest first: old readers must reject identity-bearing records.
      // Record migration is lazy and restart-safe; v3 readers also accept legacy records.
      await this.atomicWrite(manifestPath, expected);
      const next = join(this.directory, `.owner-${this.token}`);
      await writeFile(
        next,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          agentId: this.agentId,
          token: this.token,
        }),
        { mode: 0o600 },
      );
      await rename(next, join(this.directory, 'owner.json'));
      this.locked = true;
    } finally {
      await rm(guard, { recursive: true });
    }
  }
  async unlock(): Promise<void> {
    if (!this.locked) return;
    const guard = join(this.directory, '.guard');
    await mkdir(guard, { mode: 0o700 });
    try {
      const owner = JSON.parse(
        await readFile(join(this.directory, 'owner.json'), 'utf8'),
      );
      if (owner.token !== this.token)
        throw new Error('caller runtime owner changed');
      await unlink(join(this.directory, 'owner.json'));
      this.locked = false;
    } finally {
      await rm(guard, { recursive: true });
    }
  }
  async scopes(): Promise<string[]> {
    return (await readdir(this.directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }
  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const next = join(this.directory, `.record-${randomUUID()}`);
    try {
      await writeFile(next, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(next, path);
    } finally {
      await rm(next, { force: true });
    }
  }
  async reserve(id: string, kind: string, principalId?: string): Promise<void> {
    if (!this.locked)
      throw new Error('caller state requires exclusive ownership');
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    if (
      principalId !== undefined &&
      (!principalId || scopeDigest(this.agentId, principalId) !== id)
    )
      throw new Error('caller state identity mismatch');
    const path = join(this.directory, `${id}.json`);
    let record = ScopeRecord.parse({
      version: 3,
      id,
      kind,
      namespace: this.namespace,
      agentId: this.agentId,
      principalId: principalId ?? null,
    });
    let previous: unknown;
    try {
      previous = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous !== undefined) {
      const legacy = LegacyScopeRecord.safeParse(previous);
      const stored = legacy.success ? legacy.data : ScopeRecord.parse(previous);
      if (
        stored.id !== id ||
        stored.kind !== kind ||
        stored.namespace !== this.namespace
      )
        throw new Error('caller state identity mismatch');
      if (!legacy.success) {
        const stored = ScopeRecord.parse(previous);
        if (
          stored.agentId !== this.agentId ||
          (stored.principalId !== null &&
            scopeDigest(stored.agentId, stored.principalId) !== id) ||
          (stored.principalId !== null &&
            principalId !== undefined &&
            stored.principalId !== principalId)
        )
          throw new Error('caller state identity mismatch');
        // Administrative/startup calls must never erase an established mapping.
        record = {
          ...record,
          principalId: stored.principalId ?? principalId ?? null,
        };
        if (stored.principalId === record.principalId) return;
      }
    }
    await this.atomicWrite(path, record);
  }
  async forget(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    await unlink(join(this.directory, `${id}.json`));
  }
}
