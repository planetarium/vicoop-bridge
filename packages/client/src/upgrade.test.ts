import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertLooksLikeInstall,
  assetName,
  normalizeTag,
  parseAtomTags,
  parseChecksum,
  resolvePlatformAsset,
  runUpgrade,
  sha256File,
  stripSuidBits,
} from './upgrade.js';

test('normalizeTag accepts full tag, bare version, and v-prefixed version', () => {
  assert.equal(normalizeTag('@vicoop-bridge/client@0.3.0'), '@vicoop-bridge/client@0.3.0');
  assert.equal(normalizeTag('0.3.0'), '@vicoop-bridge/client@0.3.0');
  assert.equal(normalizeTag('v0.3.0'), '@vicoop-bridge/client@0.3.0');
  // Full tag with a stray `v` after the prefix should normalize the same as
  // the bare-v form — otherwise the archive filename would carry the `v`
  // and miss the real release asset.
  assert.equal(normalizeTag('@vicoop-bridge/client@v0.3.0'), '@vicoop-bridge/client@0.3.0');
  assert.equal(normalizeTag('1.0.0-alpha.1'), '@vicoop-bridge/client@1.0.0-alpha.1');
  assert.equal(normalizeTag('1.0.0+build.sha'), '@vicoop-bridge/client@1.0.0+build.sha');
});

test('normalizeTag wrong-scope error names the expected prefix, not a doubled string', () => {
  assert.throws(
    () => normalizeTag('@evil/client@0.3.0'),
    /expected tag to start with @vicoop-bridge\/client@/,
  );
});

test('normalizeTag rejects path-traversal and shell-metacharacter payloads', () => {
  for (const bad of [
    '../etc/passwd',
    '@vicoop-bridge/client@../0.3.0',
    '@vicoop-bridge/client@0.3.0/../../etc',
    '@vicoop-bridge/client@..',
    '0.3.0/../evil',
    '@vicoop-bridge/client@ 0.3.0',
    '@vicoop-bridge/client@0.3.0;rm -rf /',
    '@vicoop-bridge/client@0.3.0\nfoo',
    '@vicoop-bridge/client@',
    '@vicoop-bridge/client@0.3.0/extra',
    '@evil/client@0.3.0',
    '@vicoop-bridge/server@0.3.0',
    '',
  ]) {
    assert.throws(() => normalizeTag(bad), /invalid version/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

// A trimmed-down copy of the real `releases.atom` shape: a feed-level <id>
// (which must NOT be mistaken for a release), then entries newest-first whose
// release tag lives in the entry <id> as `...Repository/<repoId>/<tag>`.
const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/planetarium/vicoop-bridge/releases</id>
  <title>Release notes from vicoop-bridge</title>
  <entry>
    <id>tag:github.com,2008:Repository/1211055185/@vicoop-bridge/client@0.35.3</id>
    <title>@vicoop-bridge/client@0.35.3</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1211055185/@vicoop-bridge/client@0.35.2</id>
    <title>a custom release name, not the tag</title>
  </entry>
</feed>`;

test('parseAtomTags reads release tags from entry ids, newest first', () => {
  assert.deepEqual(parseAtomTags(ATOM_FIXTURE), [
    '@vicoop-bridge/client@0.35.3',
    '@vicoop-bridge/client@0.35.2',
  ]);
});

test('parseAtomTags ignores the feed-level id and prefers the id over a custom title', () => {
  const tags = parseAtomTags(ATOM_FIXTURE);
  // The feed-level <id> (the releases URL) must not leak in as a tag.
  assert.ok(!tags.some((t) => t.includes('https://')));
  // Second entry has a non-tag <title>; the id still yields the real tag.
  assert.equal(tags[1], '@vicoop-bridge/client@0.35.2');
});

test('parseAtomTags returns [] for an empty or entry-less feed', () => {
  assert.deepEqual(parseAtomTags(''), []);
  assert.deepEqual(
    parseAtomTags('<feed><id>tag:github.com,2008:https://x/releases</id></feed>'),
    [],
  );
});

test('parseChecksum extracts hash from `<hash>  <path>` and bare-hash forms', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseChecksum(`${hash}  vicoop-client-0.3.0-linux-x64`), hash);
  assert.equal(parseChecksum(`${hash}\n`), hash);
  assert.equal(parseChecksum(`${'F'.repeat(64)}  whatever`), 'f'.repeat(64));
});

test('parseChecksum rejects malformed input', () => {
  assert.throws(() => parseChecksum(''), /could not parse sha256/);
  assert.throws(() => parseChecksum('not-a-hash  file'), /could not parse sha256/);
  assert.throws(() => parseChecksum('a'.repeat(63) + '  file'), /could not parse sha256/);
  assert.throws(() => parseChecksum('a'.repeat(64) + 'z  file'), /could not parse sha256/);
});

test('sha256File streams the file and matches a known-answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-sha-'));
  try {
    const path = join(dir, 'f.bin');
    writeFileSync(path, 'hello world');
    const want = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    assert.equal(await sha256File(path), want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlatformAsset maps every supported (platform, arch) pair', () => {
  assert.deepEqual(resolvePlatformAsset('darwin', 'arm64'), { slug: 'macos-arm64', ext: '' });
  assert.deepEqual(resolvePlatformAsset('darwin', 'x64'),   { slug: 'macos-x64',   ext: '' });
  assert.deepEqual(resolvePlatformAsset('linux',  'arm64'), { slug: 'linux-arm64', ext: '' });
  assert.deepEqual(resolvePlatformAsset('linux',  'x64'),   { slug: 'linux-x64',   ext: '' });
  assert.deepEqual(resolvePlatformAsset('win32',  'x64'),   { slug: 'windows-x64', ext: '.exe' });
});

test('resolvePlatformAsset rejects unsupported combinations', () => {
  // 32-bit windows, ppc64, freebsd, etc. — nothing in the build matrix.
  assert.throws(() => resolvePlatformAsset('win32', 'ia32'), /unsupported platform/);
  assert.throws(() => resolvePlatformAsset('freebsd' as NodeJS.Platform, 'x64'), /unsupported platform/);
  assert.throws(() => resolvePlatformAsset('linux', 'ppc64'), /unsupported platform/);
});

test('assetName builds the published filename for each platform', () => {
  assert.equal(assetName('0.16.0', { slug: 'macos-arm64', ext: '' }), 'vicoop-client-0.16.0-macos-arm64');
  assert.equal(assetName('0.16.0', { slug: 'linux-x64',   ext: '' }), 'vicoop-client-0.16.0-linux-x64');
  assert.equal(assetName('0.16.0', { slug: 'windows-x64', ext: '.exe' }), 'vicoop-client-0.16.0-windows-x64.exe');
});

test('assertLooksLikeInstall accepts an execPath ending in the expected binary name', () => {
  const expected = process.platform === 'win32' ? 'vicoop-client.exe' : 'vicoop-client';
  assert.doesNotThrow(() => assertLooksLikeInstall(`/opt/vicoop/${expected}`));
  assert.doesNotThrow(() => assertLooksLikeInstall(`/data/vicoop-bridge-client/${expected}`));
});

test('assertLooksLikeInstall rejects dev-workspace invocations (tsx / node / bun)', () => {
  // `tsx src/cli.ts upgrade` lands here with execPath = the node binary.
  assert.throws(() => assertLooksLikeInstall('/usr/local/bin/node'), /expected 'vicoop-client/);
  assert.throws(() => assertLooksLikeInstall('/opt/homebrew/bin/bun'), /expected 'vicoop-client/);
  // Wrong basename inside an otherwise-plausible install dir.
  assert.throws(() => assertLooksLikeInstall('/opt/vicoop/vicoop-client-old'), /expected 'vicoop-client/);
});

test('stripSuidBits clears setuid and setgid bits while leaving other modes untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-suid-'));
  try {
    const plain = join(dir, 'plain');
    const suid = join(dir, 'suid');
    const sgid = join(dir, 'sgid');
    const both = join(dir, 'both');
    writeFileSync(plain, '');
    writeFileSync(suid, '');
    writeFileSync(sgid, '');
    writeFileSync(both, '');

    chmodSync(plain, 0o755);
    chmodSync(suid, 0o4755);
    chmodSync(sgid, 0o2755);
    chmodSync(both, 0o6755);

    stripSuidBits(plain);
    stripSuidBits(suid);
    stripSuidBits(sgid);
    stripSuidBits(both);

    const mode = (p: string) => statSync(p).mode & 0o7777;
    assert.equal(mode(plain), 0o755, 'plain file unchanged');
    assert.equal(mode(suid), 0o755, 'setuid cleared');
    assert.equal(mode(sgid), 0o755, 'setgid cleared');
    assert.equal(mode(both), 0o755, 'both cleared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The bundled-direct image (#244) sets VICOOP_BRIDGE_IMAGE on the
// runtime. The env guard short-circuits before any network IO so we
// can exercise it without a fixture server. Exit code 2 is the
// agreed-upon "use docker pull instead" signal — operators / scripts
// can distinguish it from generic upgrade failures (exit 1).
test('runUpgrade exits 2 with image guidance when VICOOP_BRIDGE_IMAGE is set', async () => {
  const prev = process.env.VICOOP_BRIDGE_IMAGE;
  const prevWrite = process.stderr.write.bind(process.stderr);
  process.env.VICOOP_BRIDGE_IMAGE = '0.19.0-test';
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runUpgrade({ check: false, force: false });
    assert.equal(code, 2);
    assert.match(captured, /container image \(0\.19\.0-test\)/);
    assert.match(captured, /docker pull/);
  } finally {
    process.stderr.write = prevWrite;
    if (prev === undefined) {
      delete process.env.VICOOP_BRIDGE_IMAGE;
    } else {
      process.env.VICOOP_BRIDGE_IMAGE = prev;
    }
  }
});
