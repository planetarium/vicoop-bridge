import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostname } from 'node:os';
import {
  chmod,
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
import {
  openCallerDatabase,
  type CallerDatabase,
} from './caller-runtime-sqlite.js';

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
  agentId: z.string().min(1),
  // null means identity has not yet been observed on a validated request.
  principalId: z.string().min(1).nullable(),
}).strict();
const JsonScopeRecord = ScopeRecord.extend({ version: z.literal(3) }).strict();

/** Exclusive host ownership record; workload storage lives only in Docker volumes. */
export class CallerRuntimeStore {
  directory: string;
  namespace: string;
  private readonly token = randomUUID();
  private locked = false;
  private database?: CallerDatabase;
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
    if (this.locked)
      throw new Error('caller runtime state already has a live owner');
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
      await this.openStorage();
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
    } catch (error) {
      this.database?.close();
      this.database = undefined;
      throw error;
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
      this.database?.close();
      this.database = undefined;
      await unlink(join(this.directory, 'owner.json'));
      this.locked = false;
    } finally {
      await rm(guard, { recursive: true });
    }
  }
  private db(): CallerDatabase {
    if (!this.locked || !this.database)
      throw new Error('caller state requires exclusive ownership');
    return this.database;
  }
  async scopes(): Promise<string[]> {
    return this.db()
      .prepare('SELECT id FROM scopes ORDER BY id')
      .all()
      .map(
        (row) =>
          z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(row).id,
      );
  }
  private validateRecord(value: unknown, id?: string) {
    const record = ScopeRecord.parse(value);
    if (
      !/^[a-f0-9]{64}$/.test(record.id) ||
      (id !== undefined && record.id !== id) ||
      record.agentId !== this.agentId ||
      record.namespace !== this.namespace ||
      (record.principalId !== null &&
        scopeDigest(this.agentId, record.principalId) !== record.id)
    )
      throw new Error('caller state identity mismatch');
    return record;
  }
  private async openStorage(): Promise<void> {
    const manifestPath = join(this.directory, 'manifest.json');
    const databasePath = join(this.directory, 'state.sqlite');
    const Manifest = z
      .object({
        version: z.union([z.literal(2), z.literal(3), z.literal(4)]),
        agentId: z.literal(this.agentId),
        host: z.literal(hostname()),
        migration: z.literal('json').optional(),
      })
      .strict();
    let manifest: z.infer<typeof Manifest> | undefined;
    try {
      const parsed = Manifest.safeParse(
        JSON.parse(await readFile(manifestPath, 'utf8')),
      );
      if (!parsed.success)
        throw new Error(
          'caller state manifest is incompatible with this agent/host/version',
        );
      manifest = parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const migrating =
      !manifest || manifest.version !== 4 || manifest.migration === 'json';
    const names = (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    const exists = await stat(databasePath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      },
    );
    if (
      (!manifest && (exists || names.length)) ||
      (manifest?.version === 4 && !migrating && !exists) ||
      (manifest && manifest.version !== 4 && exists)
    )
      throw new Error(
        'caller state storage is incomplete or incompatible; inspect before recovery',
      );
    const expected = { version: 4, agentId: this.agentId, host: hostname() };
    // Block JSON-only clients before any SQLite mutation. This marker survives
    // interruption; the committed DB version tells retries whether import finished.
    if (migrating)
      await this.atomicWrite(manifestPath, { ...expected, migration: 'json' });
    if (!exists) await writeFile(databasePath, '', { mode: 0o600, flag: 'wx' });
    await chmod(databasePath, 0o600);
    const db = (this.database = await openCallerDatabase(databasePath));
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    const version = z
      .object({ user_version: z.number() })
      .parse(db.prepare('PRAGMA user_version').get()).user_version;
    if (version !== 4 && !(migrating && version === 0))
      throw new Error('caller SQLite schema is incompatible');
    if (version === 0) {
      // Validate every source before importing anything; never infer principals.
      const records = [];
      for (const name of names) {
        const value = JSON.parse(
          await readFile(join(this.directory, name), 'utf8'),
        );
        const legacy = LegacyScopeRecord.safeParse(value);
        let record;
        if (legacy.success) {
          record = { ...legacy.data, agentId: this.agentId, principalId: null };
        } else {
          const { version: _version, ...identity } =
            JsonScopeRecord.parse(value);
          record = identity;
        }
        records.push(this.validateRecord(record, name.slice(0, -5)));
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            agentId TEXT NOT NULL, host TEXT NOT NULL, namespace TEXT NOT NULL);
          CREATE TABLE scopes (
            id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'),
            kind TEXT NOT NULL CHECK (kind IN ('claude', 'codex')),
            namespace TEXT NOT NULL, agentId TEXT NOT NULL CHECK (length(agentId) > 0),
            principalId TEXT CHECK (principalId IS NULL OR length(principalId) > 0),
            UNIQUE (agentId, principalId, kind));
        `);
        db.prepare('INSERT INTO metadata VALUES (1, ?, ?, ?)').run(
          this.agentId,
          hostname(),
          this.namespace,
        );
        const insert = db.prepare(
          'INSERT INTO scopes (id, kind, namespace, agentId, principalId) VALUES (?, ?, ?, ?, ?)',
        );
        for (const r of records)
          insert.run(r.id, r.kind, r.namespace, r.agentId, r.principalId);
        db.exec('PRAGMA user_version = 4; COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    const metadata = z
      .object({
        agentId: z.literal(this.agentId),
        host: z.literal(hostname()),
        namespace: z.literal(this.namespace),
      })
      .strict();
    metadata.parse(
      db
        .prepare(
          'SELECT agentId, host, namespace FROM metadata WHERE singleton = 1',
        )
        .get(),
    );
    for (const row of db.prepare('SELECT * FROM scopes').all())
      this.validateRecord(row);
    if (migrating) await this.atomicWrite(manifestPath, expected);
    // Legacy JSON files remain as an inert migration backup, never read again.
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
  async reserve(id: string, kind: string, principalId?: string): Promise<boolean> {
    if (!this.locked)
      throw new Error('caller state requires exclusive ownership');
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    if (
      principalId !== undefined &&
      (!principalId || scopeDigest(this.agentId, principalId) !== id)
    )
      throw new Error('caller state identity mismatch');
    const db = this.db();
    const record = this.validateRecord({
      id,
      kind,
      namespace: this.namespace,
      agentId: this.agentId,
      principalId: principalId ?? null,
    });
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM scopes WHERE id = ?').get(id);
      if (previous) {
        const stored = this.validateRecord(previous, id);
        if (
          stored.kind !== kind ||
          (stored.principalId !== null &&
            principalId !== undefined &&
            stored.principalId !== principalId)
        )
          throw new Error('caller state identity mismatch');
        if (stored.principalId === null && principalId !== undefined)
          db.prepare('UPDATE scopes SET principalId = ? WHERE id = ?').run(
            principalId,
            id,
          );
      } else {
        db.prepare(
          'INSERT INTO scopes (id, kind, namespace, agentId, principalId) VALUES (?, ?, ?, ?, ?)',
        ).run(
          record.id,
          record.kind,
          record.namespace,
          record.agentId,
          record.principalId,
        );
      }
      db.exec('COMMIT');
      return !previous;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async forget(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid scope ID');
    this.db().prepare('DELETE FROM scopes WHERE id = ?').run(id);
    // A migrated JSON backup also contains user identity; delete it with the scope.
    await rm(join(this.directory, `${id}.json`), { force: true });
  }
}
