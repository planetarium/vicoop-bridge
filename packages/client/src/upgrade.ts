import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clientVersion, installDir } from './version.js';

const REPO = 'planetarium/vicoop-bridge';

// Cap for the new-binary --version probe. Should be near-instant; anything
// close to this timeout is a regression we'd rather surface than block on.
const HEALTHCHECK_TIMEOUT_MS = 10_000;

// Short cap for the small metadata fetches (the release-feed lookup and the
// checksum file), as opposed to the large binary download below. A stalled
// DNS resolution or captive portal shouldn't strand the operator on a hung
// process.
const METADATA_TIMEOUT_MS = 15_000;

// Generous cap for the actual asset download. `AbortSignal.timeout` is a
// total-operation timeout, so this has to cover slow-but-real networks
// pulling a ~60MB binary; lower it and we'd false-abort on plausible home
// connections.
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const TAG_PREFIX = '@vicoop-bridge/client@';

// Accepted tag shape. The version portion is interpolated into the asset
// filename, so we reject anything that could path-traverse or smuggle shell
// metacharacters. The `/` inside the prefix is the only slash allowed; the
// version character class still excludes it. Permissive enough for
// pre-release / build-metadata variants (`...-rc.1`, `...+sha.abc`).
const TAG_RE = new RegExp(`^${TAG_PREFIX}[A-Za-z0-9][A-Za-z0-9.+\\-]*$`);

export interface UpgradeOptions {
  check: boolean;
  force: boolean;
  version?: string;
}

interface PlatformAsset {
  // Slug used in the asset filename (`macos-arm64`, `linux-x64`, ...).
  slug: string;
  // Extension appended to the binary on this platform (`.exe` on win32).
  ext: string;
}

export function resolvePlatformAsset(
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformAsset {
  if (plat === 'darwin' && arch === 'arm64') return { slug: 'macos-arm64', ext: '' };
  if (plat === 'darwin' && arch === 'x64')   return { slug: 'macos-x64',   ext: '' };
  if (plat === 'linux'  && arch === 'arm64') return { slug: 'linux-arm64', ext: '' };
  if (plat === 'linux'  && arch === 'x64')   return { slug: 'linux-x64',   ext: '' };
  if (plat === 'win32'  && arch === 'x64')   return { slug: 'windows-x64', ext: '.exe' };
  throw new Error(`upgrade: unsupported platform/arch combination ${plat}/${arch}`);
}

export function assetName(version: string, asset: PlatformAsset = resolvePlatformAsset()): string {
  return `vicoop-client-${version}-${asset.slug}${asset.ext}`;
}

// The vicoop-bridge-client container image (bundled-direct profile,
// #244) bakes its semver into VICOOP_BRIDGE_IMAGE. The bridge client
// binary lives in the image's layer, so writing a new one via this
// self-upgrade path "works" until the next `docker recreate` reverts
// it — a confusing UX trap. Refuse early and point the operator at
// the right channel (image tag bump via docker pull). The external-
// runtime profile (#249) leaves this env unset, so bare-metal upgrade
// is unaffected.
const CONTAINER_IMAGE_ENV = 'VICOOP_BRIDGE_IMAGE';
const CONTAINER_IMAGE_REPO = 'ghcr.io/planetarium/vicoop-bridge-client';

export async function runUpgrade(opts: UpgradeOptions): Promise<number> {
  const imageVersion = process.env[CONTAINER_IMAGE_ENV];
  if (imageVersion) {
    err(
      `running inside vicoop-bridge container image (${imageVersion}); ` +
        'self-upgrade is disabled because the binary lives in the image layer ' +
        'and will revert on container recreate.',
    );
    err('to update, bump the image tag:');
    err(`  docker pull ${CONTAINER_IMAGE_REPO}:<tag>`);
    err('  docker compose up -d   # or restart the container');
    return 2;
  }

  const execPath = process.execPath;
  log(`current: ${clientVersion} (${execPath})`);

  try {
    assertLooksLikeInstall(execPath);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }

  let asset: PlatformAsset;
  try {
    asset = resolvePlatformAsset();
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

  // Stage the new binary alongside the current one so the final rename is on
  // the same filesystem (atomic). Operator's `cards/`, config, etc. living in
  // installDir are untouched by a single-file swap.
  const newPath = `${execPath}.new`;
  const prevPath = `${execPath}.prev`;

  try {
    accessSync(installDir, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    err(`install directory must be writable/executable to upgrade (${installDir}).`);
    err('If this is a system-scope install, re-run with sudo.');
    return 1;
  }

  // Clean up a stale .new from a previous interrupted upgrade.
  if (existsSync(newPath)) {
    try {
      unlinkSync(newPath);
    } catch (e) {
      err(`could not remove stale ${newPath}: ${(e as Error).message}`);
      return 1;
    }
  }

  const archiveName = assetName(targetVersion, asset);
  const checksumName = `${archiveName}.sha256`;
  // The tag contains `/` and `@`; both must be percent-encoded as a single
  // path segment so the URL points at one release, not into a subpath.
  const baseUrl = `https://github.com/${REPO}/releases/download/${encodeURIComponent(targetTag)}`;

  // `swapDone` gates cleanup of `.new`. Any exit path before the swap
  // completes must leave the current binary in place and remove `.new`.
  let swapDone = false;

  try {
    try {
      log(`downloading ${archiveName}`);
      await download(`${baseUrl}/${archiveName}`, newPath);

      log('verifying checksum');
      const checksumText = await downloadText(`${baseUrl}/${checksumName}`);
      const expected = parseChecksum(checksumText);
      const actual = await sha256File(newPath);
      if (expected !== actual) {
        err(`checksum mismatch: expected ${expected}, got ${actual}`);
        return 1;
      }

      // chmod +x so the healthcheck can spawn it. 0o755 mirrors install.sh.
      try {
        chmodSync(newPath, 0o755);
      } catch (e) {
        err(`could not chmod +x ${newPath}: ${(e as Error).message}`);
        return 1;
      }

      // Under sudo, normalize ownership so the staged binary doesn't end up
      // owned by the operator's uid while the install runs as root.
      // Defense-in-depth: also strip suid/sgid bits.
      if (process.getuid?.() === 0) {
        const chownRes = spawnSync('chown', ['0:0', newPath], { stdio: 'inherit' });
        if (chownRes.error || chownRes.signal || chownRes.status !== 0) {
          const detail = chownRes.error?.message ?? `signal ${chownRes.signal ?? 'none'}, status ${chownRes.status}`;
          err(`chown 0:0 on ${newPath} failed (${detail}) — refusing to leave root-extracted file with non-root ownership`);
          return 1;
        }
        try {
          stripSuidBits(newPath);
        } catch (e) {
          err(`failed to strip setuid/setgid bits on ${newPath}: ${(e as Error).message}`);
          return 1;
        }
      }

      const health = runHealthcheck(newPath, targetVersion);
      if (!health.ok) {
        err(`new binary failed --version healthcheck; aborting${health.detail ? ` (${health.detail})` : ''}`);
        return 1;
      }

      // Atomic swap. On unix the running process keeps executing from the
      // unlinked inode, so replacing the file mid-flight is safe; the next
      // launch picks up the new binary. Windows can't rename an executable
      // that's currently mapped — that case is handled by install.sh, not
      // here (this branch will fail loudly with EBUSY-equivalent).
      if (existsSync(prevPath)) {
        try {
          unlinkSync(prevPath);
        } catch (e) {
          err(`could not clear existing ${prevPath}: ${(e as Error).message}`);
          return 1;
        }
      }
      let movedOriginal = false;
      try {
        log(`swap: ${execPath} -> ${prevPath}`);
        renameSync(execPath, prevPath);
        movedOriginal = true;
        log(`swap: ${newPath} -> ${execPath}`);
        renameSync(newPath, execPath);
        swapDone = true;
      } catch (e) {
        err(`swap failed, rolling back: ${(e as Error).message}`);
        if (movedOriginal && !existsSync(execPath)) {
          try {
            renameSync(prevPath, execPath);
          } catch (rollbackErr) {
            err(`rollback rename failed: ${(rollbackErr as Error).message}`);
          }
        }
        return 1;
      }
    } catch (e) {
      err(`upgrade failed: ${(e as Error).message}`);
      return 1;
    }
  } finally {
    // Cleanup must not mask a real failure. `rmSync force: true` silences
    // ENOENT but still throws on EACCES / EBUSY, so a finally-block rmSync
    // can turn a clean error into an uncaught exception. Downgrade to a
    // warning instead.
    if (!swapDone) safeRemove(newPath);
  }

  log(
    'a running client (if any) keeps the previous binary in memory until ' +
      'you stop it and start it again with your usual command',
  );

  log(`upgraded ${clientVersion} -> ${targetVersion}`);
  log(`previous binary kept at ${prevPath} (delete when satisfied)`);
  return 0;
}

export function normalizeTag(v: string): string {
  // A leading `@` signals the operator meant to pass a full scoped tag. If
  // the prefix doesn't match, surface that directly — otherwise the prefix
  // is prepended unconditionally and the error message reads like the
  // double-prefixed `@vicoop-bridge/client@@evil/client@0.3.0`.
  if (v.startsWith('@') && !v.startsWith(TAG_PREFIX)) {
    throw new Error(`invalid version '${v}': expected tag to start with ${TAG_PREFIX}`);
  }
  // Peel the prefix if present so the leading-`v` strip applies whether the
  // operator typed the bare version, the v-prefixed bare version, or the
  // full tag — `@vicoop-bridge/client@v0.3.0` should normalize the same as
  // `@vicoop-bridge/client@0.3.0`.
  const versionPart = (v.startsWith(TAG_PREFIX) ? v.slice(TAG_PREFIX.length) : v).replace(/^v/, '');
  const candidate = `${TAG_PREFIX}${versionPart}`;
  assertSafeTag(candidate, v);
  return candidate;
}

function versionFromTag(tag: string): string {
  return tag.slice(TAG_PREFIX.length);
}

function assertSafeTag(tag: string, raw: string = tag): void {
  if (!TAG_RE.test(tag) || tag.includes('..')) {
    throw new Error(
      `invalid version '${raw}': expected ${TAG_PREFIX}<version> with only [A-Za-z0-9.+-] in the version (no '..'), got '${tag}'`,
    );
  }
}

// Pull release tags out of a GitHub `releases.atom` feed, in feed order
// (newest first). The tag is read from each `<entry>`'s `<id>`
// (`tag:github.com,2008:Repository/<repoId>/<TAG>`) rather than `<title>`,
// because a release title can be a custom name while the id always carries
// the literal git tag. Exported for unit testing without network IO.
export function parseAtomTags(xml: string): string[] {
  const tags: string[] = [];
  const idRe = /<id>\s*tag:github\.com,\d+:Repository\/\d+\/([\s\S]*?)\s*<\/id>/;
  for (const entry of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/g)) {
    const m = idRe.exec(entry[0]);
    if (m) tags.push(m[1].trim());
  }
  return tags;
}

async function resolveLatestTag(): Promise<string> {
  // Resolve the latest release from the public Atom feed on github.com
  // instead of api.github.com. The REST API caps *unauthenticated* requests
  // at 60/hr per IP, which bricks self-update on shared provider egress IPs
  // exactly when an operator is rolling out a release (#405); the web feed
  // carries its own, far more generous anonymous limit and needs no token.
  //
  // Tradeoff vs the old `/releases` API call: the feed doesn't expose
  // draft/prerelease flags, so we can't filter them out here. That's a
  // non-issue for this repo — GitHub releases are client-only and always
  // published as full (non-prerelease) releases via `changeset tag`. The
  // TAG_PREFIX filter still drops any unrelated tag that shows up in the
  // feed, and assertSafeTag rejects anything malformed.
  const url = `https://github.com/${REPO}/releases.atom`;
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': 'vicoop-client-upgrade', Accept: 'application/atom+xml' } },
    METADATA_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`GitHub releases feed request failed: ${res.status} ${res.statusText} (${url})`);
  }
  const xml = await res.text();
  for (const tag of parseAtomTags(xml)) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    assertSafeTag(tag);
    return tag;
  }
  throw new Error(`no published ${TAG_PREFIX}* release found in ${REPO} feed (${url})`);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}

// Validates that the running process is actually our installed binary, not
// a `tsx src/cli.ts upgrade` or `node dist/cli.js upgrade` run from a dev
// workspace. The binary is the only thing in installDir we own; if `tsx`
// or `node` invoked us, `process.execPath` points at that interpreter, not
// at our installed file.
export function assertLooksLikeInstall(execPath: string): void {
  const expectedBase = process.platform === 'win32' ? 'vicoop-client.exe' : 'vicoop-client';
  const actualBase = basename(execPath);
  if (actualBase !== expectedBase) {
    throw new Error(
      `current executable is '${actualBase}' at ${execPath}, expected '${expectedBase}'. ` +
        `Upgrade only manages installs created by install.sh; run install.sh for first-time setup.`,
    );
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText || ''} (${url})`.trim());
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

async function downloadText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, METADATA_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText || ''} (${url})`.trim());
  }
  return res.text();
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export function parseChecksum(contents: string): string {
  // Take the first whitespace-separated token from the first line.
  const first = contents.trim().split(/\s+/)[0];
  if (!first || !/^[0-9a-f]{64}$/i.test(first)) {
    throw new Error(`could not parse sha256 hash from checksum file (got: ${contents.slice(0, 80)})`);
  }
  return first.toLowerCase();
}

interface HealthcheckResult {
  ok: boolean;
  detail?: string;
}

function runHealthcheck(newBinary: string, expected: string): HealthcheckResult {
  const r = spawnSync(newBinary, ['--version'], {
    encoding: 'utf8',
    timeout: HEALTHCHECK_TIMEOUT_MS,
  });
  const stderrSnippet = (r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 200);
  const withStderr = (msg: string) => (stderrSnippet ? `${msg}; stderr: ${stderrSnippet}` : msg);

  if (r.signal === 'SIGTERM' || r.error?.message?.includes('ETIMEDOUT')) {
    return { ok: false, detail: `timeout after ${HEALTHCHECK_TIMEOUT_MS}ms` };
  }
  if (r.error) {
    return { ok: false, detail: withStderr(`spawn failed: ${r.error.message}`) };
  }
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

// Clears setuid (04000) and setgid (02000) bits on the file at `path`.
// Exported for tests.
export function stripSuidBits(path: string): void {
  const mode = statSync(path).mode;
  if (mode & 0o6000) chmodSync(path, mode & ~0o6000);
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
