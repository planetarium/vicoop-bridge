import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clientVersion, installDir } from './version.js';

const REPO = 'planetarium/vicoop-bridge';

// Top-level entries that the release bundle owns. Anything else under
// $INSTALL_DIR is assumed operator-placed and preserved on upgrade.
const SHIPPED_TOP_LEVEL = new Set(['bin', 'cards', 'dist', 'node_modules', 'package.json', 'README.md']);

// Cap for the new-bundle --version probe. It's meant to be instantaneous;
// anything close to the timeout indicates a regression we'd rather surface
// than block on.
const HEALTHCHECK_TIMEOUT_MS = 10_000;

export interface UpgradeOptions {
  check: boolean;
  force: boolean;
  version?: string;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<number> {
  log(`current: ${clientVersion} (${installDir})`);

  const targetTag = opts.version
    ? normalizeTag(opts.version)
    : await resolveLatestTag();
  const targetVersion = targetTag.replace(/^client-v/, '');
  log(`target:  ${targetVersion} (${targetTag})`);

  if (opts.check) {
    if (targetVersion === clientVersion) {
      log('up to date');
    } else {
      log(`update available: ${clientVersion} -> ${targetVersion}`);
    }
    return 0;
  }

  if (targetVersion === clientVersion && !opts.force) {
    log('already on target version (pass --force to reinstall)');
    return 0;
  }

  if (!canWrite(installDir) || !canWrite(dirname(installDir))) {
    err(`$INSTALL_DIR or its parent is not writable (${installDir}).`);
    err('If this is a system-scope install, re-run with sudo.');
    return 1;
  }

  const newDir = `${installDir}.new`;
  const prevDir = `${installDir}.prev`;
  rmSync(newDir, { recursive: true, force: true });

  const dlDir = mkdtempSync(join(tmpdir(), 'vicoop-upgrade-'));

  // `swapDone` gates the .new cleanup: any exit path before the atomic swap
  // completes (explicit `return`, thrown exception, failed rollback) must
  // leave the original install in place and remove .new. The outer finally
  // checks this flag so we don't have to duplicate cleanup at every failure
  // site.
  let swapDone = false;

  try {
    try {
      const archiveName = `vicoop-bridge-client-${targetVersion}.tgz`;
      const checksumName = `${archiveName}.sha256`;
      const baseUrl = `https://github.com/${REPO}/releases/download/${targetTag}`;

      log(`downloading ${archiveName}`);
      await download(`${baseUrl}/${archiveName}`, join(dlDir, archiveName));
      await download(`${baseUrl}/${checksumName}`, join(dlDir, checksumName));

      log('verifying checksum');
      const expected = parseChecksum(readFileSync(join(dlDir, checksumName), 'utf8'));
      const actual = await sha256File(join(dlDir, archiveName));
      if (expected !== actual) {
        err(`checksum mismatch: expected ${expected}, got ${actual}`);
        return 1;
      }

      log(`extracting into ${newDir}`);
      mkdirSync(newDir, { recursive: true });
      const tarRes = spawnSync(
        'tar',
        ['-xzf', join(dlDir, archiveName), '-C', newDir, '--strip-components=1'],
        { stdio: 'inherit' },
      );
      if (tarRes.status !== 0) {
        err('extraction failed');
        return 1;
      }

      preserveOperatorFiles(installDir, newDir);

      const health = runHealthcheck(newDir, targetVersion);
      if (!health.ok) {
        err(`new bundle failed --version healthcheck; aborting${health.detail ? ` (${health.detail})` : ''}`);
        return 1;
      }

      // Atomic swap. Both renames inside a guarded block so any failure
      // restores the original install dir; the outer `finally` still deletes
      // `.new` since `swapDone` stays false.
      rmSync(prevDir, { recursive: true, force: true });
      let movedOriginal = false;
      try {
        log(`swap: ${installDir} -> ${prevDir}`);
        renameSync(installDir, prevDir);
        movedOriginal = true;
        log(`swap: ${newDir} -> ${installDir}`);
        renameSync(newDir, installDir);
        swapDone = true;
      } catch (e) {
        err(`swap failed, rolling back: ${(e as Error).message}`);
        if (movedOriginal && !existsSync(installDir)) {
          try {
            renameSync(prevDir, installDir);
          } catch (rollbackErr) {
            err(`rollback rename failed: ${(rollbackErr as Error).message}`);
          }
        }
        return 1;
      }
    } catch (e) {
      err(`upgrade failed: ${(e as Error).message}`);
      return 1;
    } finally {
      if (!swapDone) {
        rmSync(newDir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(dlDir, { recursive: true, force: true });
  }

  const unit = detectSystemdUnit();
  if (unit) {
    log(`restarting systemd unit (${unit.scope} scope)`);
    if (!tryRestartSystemd(unit.scope)) {
      err('systemctl try-restart failed; restart the service manually');
    }
  } else {
    log('no systemd unit detected — restart your client manually to pick up the new version');
  }

  log(`upgraded ${clientVersion} -> ${targetVersion}`);
  log(`previous install kept at ${prevDir} (delete when satisfied)`);
  return 0;
}

export function normalizeTag(v: string): string {
  return v.startsWith('client-v') ? v : `client-v${v.replace(/^v/, '')}`;
}

async function resolveLatestTag(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { 'User-Agent': 'vicoop-client-upgrade', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API request failed: ${res.status} ${res.statusText}`);
  const releases = (await res.json()) as Array<{ tag_name?: unknown }>;
  for (const r of releases) {
    if (typeof r.tag_name === 'string' && r.tag_name.startsWith('client-v')) return r.tag_name;
  }
  throw new Error(`no client-v* release found in ${REPO}`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export function parseChecksum(contents: string): string {
  // Matches install.sh: take the first whitespace-separated token from the first line.
  const first = contents.trim().split(/\s+/)[0];
  if (!first || !/^[0-9a-f]{64}$/i.test(first)) {
    throw new Error(`could not parse sha256 hash from checksum file (got: ${contents.slice(0, 80)})`);
  }
  return first.toLowerCase();
}

export function preserveOperatorFiles(oldDir: string, newDir: string): void {
  for (const entry of readdirSync(oldDir)) {
    if (SHIPPED_TOP_LEVEL.has(entry)) continue;
    const src = join(oldDir, entry);
    const dst = join(newDir, entry);
    if (existsSync(dst)) continue;
    cpSync(src, dst, { recursive: true });
  }

  const oldCards = join(oldDir, 'cards');
  const newCards = join(newDir, 'cards');
  if (!existsSync(oldCards) || !existsSync(newCards)) return;
  for (const entry of readdirSync(oldCards)) {
    const dst = join(newCards, entry);
    if (existsSync(dst)) continue;
    cpSync(join(oldCards, entry), dst, { recursive: true });
  }
}

interface HealthcheckResult {
  ok: boolean;
  detail?: string;
}

function runHealthcheck(newDir: string, expected: string): HealthcheckResult {
  const cli = join(newDir, 'dist', 'cli.js');
  const r = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
    timeout: HEALTHCHECK_TIMEOUT_MS,
  });
  // spawnSync's `timeout` option kills the child with SIGTERM on expiry; flag
  // that path separately so the operator can distinguish a hang from a normal
  // non-zero exit.
  if (r.signal === 'SIGTERM' || r.error?.message?.includes('ETIMEDOUT')) {
    return { ok: false, detail: `timeout after ${HEALTHCHECK_TIMEOUT_MS}ms` };
  }
  if (r.status !== 0) {
    const stderrSnippet = (r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 200);
    return { ok: false, detail: `exit ${r.status}${stderrSnippet ? `; stderr: ${stderrSnippet}` : ''}` };
  }
  const got = r.stdout.trim();
  if (got !== expected) {
    return { ok: false, detail: `reported '${got}', expected '${expected}'` };
  }
  return { ok: true };
}

function detectSystemdUnit(): { scope: 'system' | 'user' } | null {
  if (existsSync('/etc/systemd/system/vicoop-client.service')) return { scope: 'system' };
  const home = process.env.HOME;
  if (home) {
    const userCfg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
    if (existsSync(join(userCfg, 'systemd', 'user', 'vicoop-client.service'))) {
      return { scope: 'user' };
    }
  }
  return null;
}

function tryRestartSystemd(scope: 'system' | 'user'): boolean {
  const args = scope === 'user'
    ? ['--user', 'try-restart', 'vicoop-client.service']
    : ['try-restart', 'vicoop-client.service'];
  const r = spawnSync('systemctl', args, { stdio: 'inherit' });
  return r.status === 0;
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function log(msg: string): void {
  process.stderr.write(`==> ${msg}\n`);
}

function err(msg: string): void {
  process.stderr.write(`error: ${msg}\n`);
}
