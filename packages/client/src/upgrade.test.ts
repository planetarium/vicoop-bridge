import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLooksLikeInstall, normalizeTag, parseChecksum, preserveOperatorFiles, sha256File, stripSuidBits } from './upgrade.js';
import { chmodSync, statSync } from 'node:fs';

test('normalizeTag accepts full tag, bare version, and v-prefixed version', () => {
  assert.equal(normalizeTag('client-v0.3.0'), 'client-v0.3.0');
  assert.equal(normalizeTag('0.3.0'), 'client-v0.3.0');
  assert.equal(normalizeTag('v0.3.0'), 'client-v0.3.0');
  assert.equal(normalizeTag('1.0.0-alpha.1'), 'client-v1.0.0-alpha.1');
  assert.equal(normalizeTag('1.0.0+build.sha'), 'client-v1.0.0+build.sha');
});

test('normalizeTag rejects path-traversal and shell-metacharacter payloads', () => {
  for (const bad of [
    '../etc/passwd',
    'client-v../0.3.0',
    'client-v0.3.0/../../etc',
    'client-v..',
    '0.3.0/../evil',
    'client-v 0.3.0',
    'client-v0.3.0;rm -rf /',
    'client-v0.3.0\nfoo',
    'client-v',
    '',
  ]) {
    assert.throws(() => normalizeTag(bad), /invalid version/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('parseChecksum extracts hash from `<hash>  <path>` and bare-hash forms', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseChecksum(`${hash}  vicoop-bridge-client-0.3.0.tgz`), hash);
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
    // Known sha256 of "hello world".
    const want = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    assert.equal(await sha256File(path), want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserveOperatorFiles keeps operator-added cards and top-level non-bundle files', () => {
  const base = mkdtempSync(join(tmpdir(), 'vicoop-preserve-'));
  try {
    const oldDir = join(base, 'old');
    const newDir = join(base, 'new');

    // Old install: shipped bundle entries + operator additions.
    mkdirSync(join(oldDir, 'cards'), { recursive: true });
    mkdirSync(join(oldDir, 'bin'), { recursive: true });
    mkdirSync(join(oldDir, 'dist'), { recursive: true });
    mkdirSync(join(oldDir, 'node_modules'), { recursive: true });
    writeFileSync(join(oldDir, 'package.json'), '{"version":"0.3.0"}');
    writeFileSync(join(oldDir, 'cards', 'openclaw.json'), '{"marker":"old-shipped"}');
    writeFileSync(join(oldDir, 'cards', 'my-custom.json'), '{"marker":"operator"}');
    writeFileSync(join(oldDir, 'operator-notes.txt'), 'hello');

    // Fresh bundle just extracted: has new shipped cards, none of operator's additions.
    mkdirSync(join(newDir, 'cards'), { recursive: true });
    mkdirSync(join(newDir, 'bin'), { recursive: true });
    mkdirSync(join(newDir, 'dist'), { recursive: true });
    mkdirSync(join(newDir, 'node_modules'), { recursive: true });
    writeFileSync(join(newDir, 'package.json'), '{"version":"0.4.0"}');
    writeFileSync(join(newDir, 'cards', 'openclaw.json'), '{"marker":"new-shipped"}');

    preserveOperatorFiles(oldDir, newDir);

    // Shipped card untouched — new bundle wins.
    assert.equal(JSON.parse(readFileSync(join(newDir, 'cards', 'openclaw.json'), 'utf8')).marker, 'new-shipped');
    // Operator-added card copied over.
    assert.equal(readFileSync(join(newDir, 'cards', 'my-custom.json'), 'utf8'), '{"marker":"operator"}');
    // Top-level operator file preserved.
    assert.equal(readFileSync(join(newDir, 'operator-notes.txt'), 'utf8'), 'hello');
    // Shipped top-level files not duplicated.
    assert.equal(JSON.parse(readFileSync(join(newDir, 'package.json'), 'utf8')).version, '0.4.0');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('preserveOperatorFiles handles missing cards/ on either side without throwing', () => {
  const base = mkdtempSync(join(tmpdir(), 'vicoop-preserve-'));
  try {
    const oldDir = join(base, 'old');
    const newDir = join(base, 'new');
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, 'operator.txt'), 'x');

    preserveOperatorFiles(oldDir, newDir);
    assert.equal(readFileSync(join(newDir, 'operator.txt'), 'utf8'), 'x');
    // No cards/ gets fabricated.
    assert.ok(!readdirSync(newDir).includes('cards'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('assertLooksLikeInstall accepts a bundle-shaped directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-marker-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'vicoop-client'), '#!/usr/bin/env bash\nexec node ../dist/cli.js\n');
    writeFileSync(join(dir, 'dist', 'cli.js'), '// stub');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@vicoop-bridge/client', version: '0.3.0' }));
    assert.doesNotThrow(() => assertLooksLikeInstall(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertLooksLikeInstall rejects directories missing bundle markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-marker-'));
  try {
    // Dev-workspace-shaped: has dist/, package.json, node_modules, but no bin/vicoop-client.
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), '// stub');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@vicoop-bridge/client', version: '0.3.0' }));
    assert.throws(() => assertLooksLikeInstall(dir), /bin\/vicoop-client/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertLooksLikeInstall rejects bundles with wrong package name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-marker-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'vicoop-client'), '# stub');
    writeFileSync(join(dir, 'dist', 'cli.js'), '// stub');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'some-other-package', version: '0.3.0' }));
    assert.throws(() => assertLooksLikeInstall(dir), /unexpected name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stripSuidBits clears setuid and setgid bits while leaving other modes untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-suid-'));
  try {
    const plain = join(dir, 'plain');
    const suid = join(dir, 'suid');
    const sgid = join(dir, 'sgid');
    const both = join(dir, 'both');
    const nestedDir = join(dir, 'nested');
    const nested = join(nestedDir, 'binary');
    mkdirSync(nestedDir);
    writeFileSync(plain, '');
    writeFileSync(suid, '');
    writeFileSync(sgid, '');
    writeFileSync(both, '');
    writeFileSync(nested, '');

    chmodSync(plain, 0o755);
    chmodSync(suid, 0o4755);
    chmodSync(sgid, 0o2755);
    chmodSync(both, 0o6755);
    chmodSync(nested, 0o4750);

    stripSuidBits(dir);

    // Mask to the low 12 bits so platform-added type bits don't interfere.
    const mode = (p: string) => statSync(p).mode & 0o7777;
    assert.equal(mode(plain), 0o755, 'plain file unchanged');
    assert.equal(mode(suid), 0o755, 'setuid cleared');
    assert.equal(mode(sgid), 0o755, 'setgid cleared');
    assert.equal(mode(both), 0o755, 'both cleared');
    assert.equal(mode(nested), 0o750, 'recurses into subdirectories');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserveOperatorFiles recurses into operator-added subdirectories', () => {
  const base = mkdtempSync(join(tmpdir(), 'vicoop-preserve-'));
  try {
    const oldDir = join(base, 'old');
    const newDir = join(base, 'new');
    mkdirSync(join(oldDir, 'custom-state', 'nested'), { recursive: true });
    writeFileSync(join(oldDir, 'custom-state', 'nested', 'data.bin'), 'payload');
    mkdirSync(newDir);

    preserveOperatorFiles(oldDir, newDir);
    assert.equal(readFileSync(join(newDir, 'custom-state', 'nested', 'data.bin'), 'utf8'), 'payload');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
