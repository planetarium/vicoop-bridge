import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runDockerCommand, type AsyncDockerRun } from './docker-command.js';
import { scopeDigest } from './caller-runtime-store.js';
import type { DockerCallerRuntimePool } from './caller-runtime-docker.js';

export interface SetupEntry { path: string; data?: string; executable?: boolean }
const MAX_BYTES = 16 * 1024 * 1024;
/** Snapshot regular files only; no source symlinks or shell execution. */
export async function readSetupDirectory(directory: string): Promise<SetupEntry[]> {
  const root = resolve(directory);
  const entries: SetupEntry[] = [];
  let bytes = 0;
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('setup sources must not contain symlinks');
    if (entries.length >= 10000) throw new Error('setup exceeds 10000 entries');
    if (info.isDirectory()) {
      if (relative) entries.push({ path: relative });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name);
    } else if (info.isFile() && relative) {
      bytes += info.size;
      if (bytes > MAX_BYTES) throw new Error('setup exceeds 16 MiB');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const data = await file.readFile();
        if (data.length !== info.size) throw new Error('setup source changed while reading');
        entries.push({ path: relative, data: data.toString('base64'), executable: !!(info.mode & 0o111) });
      } finally { await file.close(); }
    } else throw new Error('setup source must be a directory containing regular files');
  }
  if (!(await lstat(root)).isDirectory()) throw new Error('setup source must be a directory');
  await visit(root, '');
  return entries;
}

// Runs as the workload UID while the daemon is stopped. Preflight the entire
// tree before writes; never follow existing workload-created symlinks. Root
// is an argument to allow exercising exactly this code in filesystem tests.
export const SETUP_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = process.argv[1];
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const { entries, replace } = JSON.parse(input);
    const check = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
    if (!check(root)?.isDirectory() || check(root).isSymbolicLink()) throw Error();
    for (const e of entries) {
      const parts = e.path.split('/');
      if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw Error();
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const info = check(current);
        if (info?.isSymbolicLink()) throw Error();
        const directory = i < parts.length - 1 || e.data === undefined;
        if (info && (directory ? !info.isDirectory() : !info.isFile() || !replace)) throw Error();
      }
    }
    for (const e of entries) {
      const dest = path.join(root, e.path);
      if (e.data === undefined) fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      else {
        const tmp = path.join(path.dirname(dest), '.setup-' + crypto.randomUUID());
        try {
          fs.writeFileSync(tmp, Buffer.from(e.data, 'base64'), { flag: 'wx', mode: e.executable ? 0o700 : 0o600 });
          if (replace) fs.renameSync(tmp, dest);
          else { fs.linkSync(tmp, dest); fs.unlinkSync(tmp); }
        } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      }
    }
  } catch { process.stderr.write('setup failed: check destination collisions, symlinks, permissions and free space\n'); process.exitCode = 1; }
});
`;

export async function setupCallerEnvironment(
  pool: DockerCallerRuntimePool,
  args: { principalId: string; version: string; from?: string; replace?: boolean; pending?: boolean },
  run: AsyncDockerRun = runDockerCommand,
): Promise<{ id: string; version: string; ready: boolean; unchanged?: boolean }> {
  if (!args.version || args.version.length > 128) throw new Error('setup version must contain 1–128 characters');
  if (args.pending ? args.from !== undefined || args.replace : !args.from)
    throw new Error('select --pending or --from DIRECTORY (optionally --replace)');
  const id = scopeDigest(pool.store.agentId, args.principalId);
  const previous = await pool.store.preparation(id);
  if (!args.pending && previous?.ready && previous.version === args.version)
    return { id, ...previous, unchanged: true };
  await pool.store.setPrincipalPreparation(args.principalId, args.version);
  if (args.pending) return { id, version: args.version, ready: false };
  try {
    const entries = await readSetupDirectory(args.from!);
    const container = await pool.prepare(args.principalId);
    const result = await run(['exec', '-i', '--user', '1000:1000', '-e', 'NODE_OPTIONS=', '-e', 'NODE_PATH=', '-e', 'LD_PRELOAD=', '-e', 'LD_LIBRARY_PATH=', container.name, '/usr/local/bin/node', '-e', SETUP_SCRIPT, '/workspace'], {
      timeoutMs: 120000,
      input: Buffer.from(JSON.stringify({ entries, replace: args.replace ?? false })),
    });
    if (result.exitCode !== 0) throw new Error('setup copy failed');
    await pool.checkStorage(container.id);
    // Confirm all remote processes have stopped before publishing readiness.
    await pool.stop(container.id);
    await pool.store.setPreparation(container.id, args.version, true);
    return { id: container.id, version: args.version, ready: true };
  } catch {
    // Do not leak source bytes, Docker output, or credential paths.
    throw new Error('caller setup failed; scope remains pending. Inspect destination collisions, symlinks, permissions and storage; retry with --replace after reviewing partial changes.');
  }
}
