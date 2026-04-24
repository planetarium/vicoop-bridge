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

// Short cap for GitHub API calls (just listing tags). A stalled DNS resolution
// or captive portal shouldn't strand the operator with a hung process.
const API_TIMEOUT_MS = 15_000;

// Generous cap for the actual release-asset download. `AbortSignal.timeout` is
// a total-operation timeout, so this needs to cover slow-but-real networks
// pulling a multi-MB bundle; lower it and we'd false-abort on plausible home
// connections. If the upstream is genuinely dead the operator notices within
// this window and can Ctrl-C sooner.
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

// Accepted release-tag shape. Restrictive on purpose: the tag is interpolated
// into local filenames (archive name, temp path joins) and an external URL,
// so we want to reject anything that could path-traverse or smuggle shell
// metacharacters before it's used. Permissive enough for semver-ish tags
// including pre-release/build suffixes (`client-v1.0.0-rc.1`, `...+sha.abc`).
const TAG_RE = /^client-v[A-Za-z0-9][A-Za-z0-9.+\-]*$/;

// Top-level entries a legitimate release bundle must contain. Missing any one
// of these is taken as "not an installed bundle" and aborts upgrade before
// anything on disk can move — guards against running the command from a dev
// workspace where `packages/client` lacks the synthesized bin wrapper.
const BUNDLE_MARKERS = ['bin/vicoop-client', 'dist/cli.js', 'package.json', 'node_modules'];

export interface UpgradeOptions {
  check: boolean;
  force: boolean;
  version?: string;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<number> {
  log(`current: ${clientVersion} (${installDir})`);

  try {
    assertLooksLikeInstall(installDir);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }

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

  // Preflight: the operations that actually matter are parent-directory
  // renames (moving $INSTALL_DIR aside + $INSTALL_DIR.new into place) and
  // reading through the current bundle (version.ts + preserveOperatorFiles).
  // So: parent must be writable + executable, installDir itself only needs
  // read + execute. A hardened chmod 555 install that the operator intends
  // to leave read-only passes here and upgrades cleanly.
  try {
    accessSync(installDir, fsConstants.R_OK | fsConstants.X_OK);
    accessSync(dirname(installDir), fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    err(`$INSTALL_DIR must be readable/executable and its parent must be writable (${installDir}).`);
    err('If this is a system-scope install, re-run with sudo.');
    return 1;
  }

  const newDir = `${installDir}.new`;
  const prevDir = `${installDir}.prev`;
  try {
    rmSync(newDir, { recursive: true, force: true });
  } catch (e) {
    err(`could not clean up stale ${newDir}: ${(e as Error).message}`);
    return 1;
  }

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
        [
          '-xzf',
          join(dlDir, archiveName),
          '-C',
          newDir,
          '--strip-components=1',
          // Under `sudo vicoop-client upgrade`, root would otherwise restore
          // the archive's stored uid/gid — typically the 1000-ish user that
          // built the release — leaving installed files owned by an
          // unprivileged local account. That's a privilege-escalation path
          // for a root-run service: any local user with that uid could
          // modify `dist/cli.js` between service restarts.
          // `--no-same-owner` forces the extracted files to the current
          // effective uid/gid. `--no-same-permissions` drops any stored
          // setuid/setgid bits; the archive has none today, but we want a
          // known-safe default.
          '--no-same-owner',
          '--no-same-permissions',
        ],
        { stdio: 'inherit' },
      );
      if (tarRes.error) {
        // Most common failure: `tar` missing on PATH. spawnSync flags it via
        // an ENOENT on `error.code`. Keep the message specific so an operator
        // knows to install `tar` instead of chasing a bad-archive hypothesis.
        const code = (tarRes.error as NodeJS.ErrnoException).code;
        const hint = code === 'ENOENT' ? ' (tar not found on PATH — install it and retry)' : '';
        err(`extraction failed: ${tarRes.error.message}${hint}`);
        return 1;
      }
      if (tarRes.signal) {
        err(`extraction failed: tar terminated by signal ${tarRes.signal}`);
        return 1;
      }
      if (tarRes.status !== 0) {
        err(`extraction failed: tar exited with status ${tarRes.status}`);
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
      try {
        rmSync(prevDir, { recursive: true, force: true });
      } catch (e) {
        err(`could not clear existing ${prevDir}: ${(e as Error).message}`);
        return 1;
      }
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
      // Cleanup paths must not mask the operation's real exit code. `rmSync`
      // with `force: true` silences ENOENT but still throws on EACCES /
      // EPERM / EBUSY, so a finally-block rmSync can turn a clean failure
      // (or a clean success) into an uncaught exception. Downgrade to a
      // warning instead.
      if (!swapDone) safeRemove(newDir);
    }
  } finally {
    safeRemove(dlDir);
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
  const candidate = v.startsWith('client-v') ? v : `client-v${v.replace(/^v/, '')}`;
  assertSafeTag(candidate, v);
  return candidate;
}

function assertSafeTag(tag: string, raw: string = tag): void {
  // The tag is interpolated into local paths (archive name / temp joins) and
  // an outbound URL. Reject anything that could path-traverse or inject shell
  // metacharacters before it reaches `join(dlDir, ...)`.
  if (!TAG_RE.test(tag) || tag.includes('..')) {
    throw new Error(`invalid version '${raw}': expected client-v<semver>, got '${tag}'`);
  }
}

async function resolveLatestTag(): Promise<string> {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': 'vicoop-client-upgrade', Accept: 'application/vnd.github+json' } },
    API_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`GitHub API request failed: ${res.status} ${res.statusText} (${url})`);
  const releases = (await res.json()) as Array<{ tag_name?: unknown }>;
  for (const r of releases) {
    if (typeof r.tag_name !== 'string' || !r.tag_name.startsWith('client-v')) continue;
    // Defensively validate the API response — a future rename or a
    // compromised upstream shouldn't get to interpolate arbitrary strings
    // into local filenames.
    assertSafeTag(r.tag_name);
    return r.tag_name;
  }
  throw new Error(`no client-v* release found in ${REPO}`);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Node surfaces AbortSignal.timeout expiry as TimeoutError; older
    // behavior / proxied fetches sometimes report AbortError. Translate
    // either into a human-friendly message so operators know to check the
    // network rather than chase a spurious stack trace.
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}

export function assertLooksLikeInstall(dir: string): void {
  for (const rel of BUNDLE_MARKERS) {
    if (!existsSync(join(dir, rel))) {
      throw new Error(
        `${dir} does not look like an installed vicoop-client bundle ` +
          `(missing ${rel}). Run install.sh for first-time setup; upgrade only manages existing installs.`,
      );
    }
  }
  // The workspace package.json at packages/client has the same name, so this
  // isn't definitive on its own — but combined with the bin/vicoop-client
  // check above (which the dev workspace lacks) it's enough to catch a
  // `tsx src/cli.ts upgrade` or `node packages/client/dist/cli.js upgrade`
  // run-from-source invocation before it mutates anything.
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    if (pkg.name !== '@vicoop-bridge/client') {
      throw new Error(`${dir}/package.json has unexpected name '${String(pkg.name)}' — refusing to upgrade`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${dir}/package.json is not valid JSON — refusing to upgrade`);
    }
    throw e;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText || ''} (${url})`.trim());
  }
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
  const stderrSnippet = (r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 200);
  const withStderr = (msg: string) => (stderrSnippet ? `${msg}; stderr: ${stderrSnippet}` : msg);

  // spawnSync's `timeout` option kills the child with SIGTERM on expiry; flag
  // that path separately so the operator can distinguish a hang from a normal
  // non-zero exit. Older Node versions surface the timeout via
  // `error.message` instead of setting `signal`.
  if (r.signal === 'SIGTERM' || r.error?.message?.includes('ETIMEDOUT')) {
    return { ok: false, detail: `timeout after ${HEALTHCHECK_TIMEOUT_MS}ms` };
  }
  // `r.error` is set when spawn itself failed (ENOENT on the node binary, for
  // example). Report it separately from "process ran and exited non-zero".
  if (r.error) {
    return { ok: false, detail: withStderr(`spawn failed: ${r.error.message}`) };
  }
  // Any other terminating signal (SIGKILL from the OOM killer, SIGBUS from a
  // native-module crash, etc.) — make the signal visible instead of falling
  // through to `exit null`.
  if (r.signal) {
    return { ok: false, detail: withStderr(`terminated by signal ${r.signal}`) };
  }
  if (r.status !== 0) {
    return { ok: false, detail: withStderr(`exit ${r.status}`) };
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

function safeRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    log(`warning: failed to clean up ${path}: ${(e as Error).message}`);
  }
}

function log(msg: string): void {
  process.stderr.write(`==> ${msg}\n`);
}

function err(msg: string): void {
  process.stderr.write(`error: ${msg}\n`);
}
