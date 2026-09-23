import {
  chownSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readlinkSync, statfsSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { openCallerDatabase } from './caller-runtime-sqlite.js';

export interface StorageRequest {
  action: 'create' | 'attach' | 'check' | 'delete';
  key: string;
  uuid: string;
  size: number;
  budget: number;
  reserve: number;
}
function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function parseStorageRequest(args: readonly string[]): StorageRequest {
  const [action, key, uuid, sizeText, budgetText, reserveText] = args;
  requireState(args.length === 6 && ['create', 'attach', 'check', 'delete'].includes(action), 'invalid action');
  requireState(/^[a-f0-9]{64}$/.test(key), 'invalid storage key');
  requireState(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid), 'invalid UUID');
  requireState([sizeText, budgetText, reserveText].every(v => /^[0-9]+$/.test(v)), 'invalid capacity');
  const [size, budget, reserve] = [sizeText, budgetText, reserveText].map(Number);
  requireState([size, budget, reserve].every(Number.isSafeInteger) && size >= 64 * 1048576 &&
    size <= 65536 * 1048576 && budget >= size && reserve >= 0, 'invalid capacity');
  return { action: action as StorageRequest['action'], key, uuid, size, budget, reserve };
}
function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function syncPath(path: string, directory = false) {
  const fd = openSync(path, constants.O_RDONLY | (directory ? constants.O_DIRECTORY : 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function prepareStoragePool(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  requireState(!isSymlink(root), 'symlink pool directory');
}
const linux = (...args: string[]): string => execFileSync(args[0], args.slice(1), {
  encoding: 'utf8', timeout: 250_000, maxBuffer: 1024 * 1024,
}).trim();

/** Trusted daemon-side manager. The CLI holds util-linux flock across this call.
 * Tests substitute paths and Linux tools; SQLite/filesystem state remains real.
 */
export async function runStorageManager(request: StorageRequest, options: {
  root?: string;
  aliases?: string;
  mount?: string;
  run?: (...args: string[]) => string;
} = {}): Promise<{ uuid: string; bytes: number } | undefined> {
  const { action, key, uuid, size, budget, reserve } = request;
  const root = options.root ?? '/pool/managed';
  const aliases = options.aliases ?? '/dev/disk/by-uuid';
  const mount = options.mount ?? '/mnt/image';
  const run = options.run ?? linux;
  prepareStoragePool(root);
  const db = await openCallerDatabase(join(root, 'catalog.sqlite'));
  try {
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS policy (budget INTEGER, reserve INTEGER);
      CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, uuid TEXT UNIQUE, size INTEGER, state TEXT);`);
    const policy = db.prepare('SELECT budget,reserve FROM policy').get() as { budget: number; reserve: number } | undefined;
    if (!policy) db.prepare('INSERT INTO policy VALUES (?,?)').run(budget, reserve);
    else requireState(policy.budget === budget && policy.reserve === reserve, 'pool policy differs from existing catalog');
    syncPath(root, true);
    let row = db.prepare('SELECT uuid,size,state FROM images WHERE key=?').get(key) as
      { uuid: string; size: number; state: string } | undefined;
    const image = join(root, `${key}.img`);
    requireState(!isSymlink(image), 'symlink image');
    if (row) {
      requireState(row.uuid === uuid && row.size === size, 'retained storage identity/capacity mismatch');
    } else if (action === 'delete') {
      requireState(!existsSync(image), 'unrecorded image; inspect pool');
      return;
    } else if (action === 'create') {
      requireState(!existsSync(image), 'unrecorded image; inspect pool');
      const { used } = db.prepare('SELECT coalesce(sum(size),0) AS used FROM images').get() as { used: number };
      const space = statfsSync(root);
      requireState(used + size <= budget, 'pool capacity exhausted');
      requireState(space.bavail * space.bsize >= size + reserve, 'pool free-space reserve would be exhausted');
      db.prepare('INSERT INTO images VALUES (?,?,?,?)').run(key, uuid, size, 'allocating');
      // Autocommit + synchronous FULL charges the intent before any allocation.
      // Interrupted formatting is never retried over potentially retained data.
      const fd = openSync(image, 'wx', 0o600);
      try { run('fallocate', '--length', String(size), image); fsyncSync(fd); }
      finally { closeSync(fd); }
      syncPath(root, true);
      run('mkfs.ext4', '-q', '-F', '-b', '4096', '-i', '16384', '-m', '0',
        '-U', uuid, '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', image);
      mkdirSync(mount, { recursive: true, mode: 0o700 });
      const loop = run('losetup', '--find', '--show', '--nooverlap', image);
      try {
        run('mount', '-t', 'ext4', '-o', 'nodev,nosuid,nodiscard', loop, mount);
        try {
          for (const directory of ['workspace', 'sessions', 'sessions/config']) {
            const target = join(mount, directory);
            mkdirSync(target, { mode: 0o700 });
            chownSync(target, 1000, 1000);
          }
          run('sync', '-f', mount);
        } finally { run('umount', mount); }
      } finally { run('losetup', '-d', loop); }
      syncPath(image);
      requireState(statSync(image).blocks * 512 >= size, 'backing filesystem did not retain allocation');
      db.prepare("UPDATE images SET state='ready' WHERE key=?").run(key);
      row = { uuid, size, state: 'ready' };
    } else {
      throw new Error('retained storage catalog entry missing');
    }

    const alias = join(aliases, uuid);
    if (action === 'delete') {
      // The client first removes validated Docker consumers and their volume.
      if (existsSync(image)) {
        if (isSymlink(alias)) requireState(/^\/dev\/loop[0-9]+$/.test(readlinkSync(alias)), 'unexpected UUID alias target');
        const loops = run('losetup', '-j', image).split('\n').filter(Boolean);
        for (const line of loops) {
          const loop = line.split(':', 1)[0];
          run('losetup', '-d', loop);
          for (let attempt = 0; attempt < 50; attempt++) {
            if (!run('losetup', '-j', image)) break;
            await setTimeout(100);
          }
          requireState(!run('losetup', '-j', image), 'image still attached; deletion refused');
        }
        // A stale alias can point to a loop recycled by another scope. Remove
        // only our alias; detach only devices identified by this image's inode.
        if (isSymlink(alias)) unlinkSync(alias);
        unlinkSync(image);
        syncPath(root, true);
      }
      db.prepare('DELETE FROM images WHERE key=?').run(key);
      return;
    }

    requireState(row.state === 'ready', 'incomplete allocation; explicitly remove scope before retrying');
    requireState(existsSync(image), 'retained image missing, resized or no longer allocated');
    const stat = statSync(image);
    requireState(stat.isFile() && stat.size === size && stat.blocks * 512 >= size,
      'retained image missing, resized or no longer allocated');
    requireState(run('blkid', '-p', '-s', 'UUID', '-o', 'value', image) === uuid, 'filesystem UUID mismatch');
    requireState(run('blkid', '-p', '-s', 'TYPE', '-o', 'value', image) === 'ext4', 'filesystem type mismatch');
    if (action === 'check') return;
    const loop = run('losetup', '--find', '--show', '--nooverlap', image);
    requireState(run('blkid', '-p', '-s', 'UUID', '-o', 'value', loop) === uuid, 'attached device UUID mismatch');
    mkdirSync(aliases, { recursive: true, mode: 0o700 });
    if (isSymlink(alias)) {
      requireState(/^\/dev\/loop[0-9]+$/.test(readlinkSync(alias)), 'unexpected UUID alias target');
      unlinkSync(alias);
    } else requireState(!existsSync(alias), 'UUID alias is not a symlink');
    symlinkSync(loop, alias);
    return { uuid, bytes: size };
  } finally { db.close(); }
}
