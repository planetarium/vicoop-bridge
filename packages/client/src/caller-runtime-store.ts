import { createHash, randomUUID } from 'node:crypto';
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
      const expected = { version: 2, agentId: this.agentId, host: hostname() };
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (
          manifest.version !== 2 ||
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
  async reserve(id: string, kind: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    const path = join(this.directory, `${id}.json`);
    const record = { id, kind, namespace: this.namespace };
    try {
      const previous = JSON.parse(await readFile(path, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(record))
        throw new Error('caller state identity mismatch');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(path, JSON.stringify(record), {
        mode: 0o600,
        flag: 'wx',
      });
    }
  }
  async forget(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    await unlink(join(this.directory, `${id}.json`));
  }
}
