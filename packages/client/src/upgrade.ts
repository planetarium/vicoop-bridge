import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  chmodSync,
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
  statSync,
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

// Fixed prefix used by changesets/action for monorepo package releases. The
// version portion (after the prefix) is what gets interpolated into local
// filenames; the prefix itself only appears in the GitHub download URL and is
// url-encoded there (the `/` would otherwise split the URL path).
const TAG_PREFIX = '@vicoop-bridge/client@';

// Accepted release-tag shape. Restrictive on purpose: the version portion is
// interpolated into local filenames (archive name, temp path joins), so we
// reject anything that could path-traverse or smuggle shell metacharacters
// before it's used. The literal `/` in the prefix is the only `/` allowed;
// the version character class still excludes it. Permissive enough for
// semver-ish tags including pre-release/build suffixes
// (`@vicoop-bridge/client@1.0.0-rc.1`, `...+sha.abc`).
//
// Derived from TAG_PREFIX so the prefix lives in one place. `@` and `/`
// aren't regex metacharacters in JavaScript, so interpolating the prefix
// verbatim is safe; if the prefix ever picks up a real metacharacter (`.`
// `*` `?` etc.) this needs explicit escaping.
const TAG_RE = new RegExp(`^${TAG_PREFIX}[A-Za-z0-9][A-Za-z0-9.+\\-]*$`);

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
  const targetVersion = versionFromTag(targetTag);
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
      // The tag contains `/` and `@`; both must be percent-encoded as a single
      // path segment so the URL points at one release, not into a subpath.
      const baseUrl = `https://github.com/${REPO}/releases/download/${encodeURIComponent(targetTag)}`;

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

      // Portable replacement for `tar --no-same-owner`: busybox tar lacks
      // the long option, so we normalize ownership after the fact. Non-root
      // tar already extracts as the current uid/gid (kernel enforces), so
      // the chown only actually matters under `sudo vicoop-client upgrade`
      // — where the archive's stored uid (typically ~1000, whatever built
      // the release) would otherwise end up owning a root-run service's
      // files. That's a privilege-escalation vector: any local user with
      // that uid could modify `dist/cli.js` between restarts.
      //
      // Under root we also strip setuid/setgid bits that tar may have
      // restored from the archive. After the chown above, any such bits
      // would become root-owned suid files under $INSTALL_DIR — much worse
      // than the build-host-uid case. The archive has no setuid bits today;
      // this is a defense-in-depth invariant so we don't silently start
      // shipping a privileged binary if someone adds one.
      if (process.getuid?.() === 0) {
        const chownRes = spawnSync('chown', ['-R', '0:0', newDir], { stdio: 'inherit' });
        if (chownRes.error || chownRes.signal || chownRes.status !== 0) {
          const detail = chownRes.error?.message ?? `signal ${chownRes.signal ?? 'none'}, status ${chownRes.status}`;
          err(`chown -R 0:0 on ${newDir} failed (${detail}) — refusing to leave root-extracted files with non-root ownership`);
          return 1;
        }
        try {
          stripSuidBits(newDir);
        } catch (e) {
          err(`failed to strip setuid/setgid bits under ${newDir}: ${(e as Error).message}`);
          return 1;
        }
      }

      preserveOperatorFiles(installDir, newDir);

      // Re-strip setuid/setgid after preservation. `cpSync` preserves mode
      // bits, so any operator file that had suid/sgid bits set in the old
      // install would arrive in newDir with those bits intact — and under
      // `sudo vicoop-client upgrade` that file's dest would be owned by
      // root (cpSync as root) or left owner-preserved, either way yielding
      // a privileged binary inside the next install. Second strip closes
      // that gap; non-root path is a no-op beyond the directory walk.
      if (process.getuid?.() === 0) {
        try {
          stripSuidBits(newDir);
        } catch (e) {
          err(`failed to strip setuid/setgid bits under ${newDir} after preserving operator files: ${(e as Error).message}`);
          return 1;
        }
      }

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
    log(
      'no systemd unit detected — your running client (if any) keeps the previous bundle ' +
        'until you stop it and start it again with your usual command',
    );
  }

  log(`upgraded ${clientVersion} -> ${targetVersion}`);
  log(`previous install kept at ${prevDir} (delete when satisfied)`);
  return 0;
}

export function normalizeTag(v: string): string {
  // A leading `@` signals the operator meant to pass a full scoped tag. If
  // the prefix doesn't match (e.g. `@evil/client@0.3.0`), surface that
  // directly — otherwise the prefix is prepended unconditionally and
  // assertSafeTag's "got" value reads like the double-prefixed
  // `@vicoop-bridge/client@@evil/client@0.3.0`, which is hard to parse.
  if (v.startsWith('@') && !v.startsWith(TAG_PREFIX)) {
    throw new Error(`invalid version '${v}': expected tag to start with ${TAG_PREFIX}`);
  }
  // Peel the prefix if present so the leading-`v` strip applies whether the
  // operator typed the bare version, the v-prefixed bare version, or the
  // full tag (`@vicoop-bridge/client@v0.3.0` should resolve the same as
  // `@vicoop-bridge/client@0.3.0`). Without this peel, the full-tag form
  // would slip a `v` into the archive filename and miss the real asset.
  const versionPart = (v.startsWith(TAG_PREFIX) ? v.slice(TAG_PREFIX.length) : v).replace(/^v/, '');
  const candidate = `${TAG_PREFIX}${versionPart}`;
  assertSafeTag(candidate, v);
  return candidate;
}

function versionFromTag(tag: string): string {
  // assertSafeTag is the gate that proves the prefix is present; callers
  // should only pass tags that have already passed that check.
  return tag.slice(TAG_PREFIX.length);
}

function assertSafeTag(tag: string, raw: string = tag): void {
  // The bare version portion of the tag is interpolated into local paths
  // (archive name / temp joins); reject anything that could path-traverse or
  // inject shell metacharacters before it reaches `join(dlDir, ...)`. The
  // version regex is intentionally looser than strict semver — we want to
  // accept future pre-release and build-metadata variants — so the error
  // describes the literal character set rather than implying semver. The
  // single `/` in the prefix is fine because the download URL goes through
  // encodeURIComponent before being used.
  if (!TAG_RE.test(tag) || tag.includes('..')) {
    throw new Error(
      `invalid version '${raw}': expected ${TAG_PREFIX}<version> with only [A-Za-z0-9.+-] in the version (no '..'), got '${tag}'`,
    );
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
  const body = (await res.json()) as unknown;
  // GitHub returns an object (`{ message, documentation_url, ... }`) for
  // rate-limit / abuse / auth errors with a 2xx-shaped body on some legacy
  // paths, so don't trust the HTTP status alone — confirm we got an array
  // before iterating, otherwise `for...of` would throw "X is not
  // iterable" which is harder to act on than the upstream error message.
  if (!Array.isArray(body)) {
    const msg = (body as { message?: unknown })?.message;
    const detail = typeof msg === 'string' ? msg : JSON.stringify(body).slice(0, 200);
    throw new Error(`GitHub API returned a non-array payload at ${url}: ${detail}`);
  }
  const releases = body as Array<{ tag_name?: unknown; draft?: unknown; prerelease?: unknown }>;
  for (const r of releases) {
    if (typeof r.tag_name !== 'string' || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    // Skip drafts (no uploaded assets — the .tgz download would 404) and
    // prereleases (assets exist but operators on the default channel don't
    // want them). `--version <tag>` with an explicit prerelease tag still
    // lets an operator pin one when they want to test it.
    if (r.draft === true || r.prerelease === true) continue;
    // Defensively validate the API response — a future rename or a
    // compromised upstream shouldn't get to interpolate arbitrary strings
    // into local filenames.
    assertSafeTag(r.tag_name);
    return r.tag_name;
  }
  throw new Error(`no published (non-draft, non-prerelease) ${TAG_PREFIX}* release found in ${REPO}`);
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
    // `||` rather than `??` so an empty `XDG_CONFIG_HOME=` (common
    // accidental mis-export, and what shells treat as unset via
    // `${XDG_CONFIG_HOME:-...}`) falls back to $HOME/.config instead of
    // turning the path relative.
    const userCfg = process.env.XDG_CONFIG_HOME || join(home, '.config');
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
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    const hint = code === 'ENOENT' ? ' (systemctl not on PATH)' : '';
    err(`systemctl spawn failed${hint}: ${r.error.message}`);
    return false;
  }
  if (r.signal) {
    err(`systemctl terminated by signal ${r.signal}`);
    return false;
  }
  if (r.status !== 0) {
    err(`systemctl try-restart exited with status ${r.status}`);
    return false;
  }
  return true;
}

// Recursively clear the setuid (04000) and setgid (02000) bits on every file
// under `dir`. Exported for tests.
export function stripSuidBits(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      stripSuidBits(p);
    } else if (entry.isFile()) {
      const mode = statSync(p).mode;
      if (mode & 0o6000) chmodSync(p, mode & ~0o6000);
    }
  }
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
