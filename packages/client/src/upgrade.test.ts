import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTag, parseChecksum, preserveOperatorFiles, sha256File } from './upgrade.js';

test('normalizeTag accepts full tag, bare version, and v-prefixed version', () => {
  assert.equal(normalizeTag('client-v0.3.0'), 'client-v0.3.0');
  assert.equal(normalizeTag('0.3.0'), 'client-v0.3.0');
  assert.equal(normalizeTag('v0.3.0'), 'client-v0.3.0');
  assert.equal(normalizeTag('1.0.0-alpha.1'), 'client-v1.0.0-alpha.1');
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
