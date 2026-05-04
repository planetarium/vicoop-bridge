import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  inferMimeFromPath,
  parseBridgeAttachMarkers,
  readBoundedFileWithinRoots,
  SafeReadError,
  stripMarkersForPath,
} from './file-attach.js';

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-attach-test-'));
  // realpath the dir so tests don't trip over /private/var vs /var differences
  // on macOS where mkdtemp returns the symlinked form.
  return await fs.realpath(dir);
}

test('parseBridgeAttachMarkers: no markers returns empty paths', () => {
  const r = parseBridgeAttachMarkers('hello world, no markers here');
  assert.deepEqual(r.paths, []);
  assert.equal(r.markersByPath.size, 0);
});

test('parseBridgeAttachMarkers: single marker is extracted with surrounding whitespace trimmed', () => {
  const r = parseBridgeAttachMarkers('see this: [bridge-attach: /tmp/report.pdf  ] and more');
  assert.deepEqual(r.paths, ['/tmp/report.pdf']);
  assert.deepEqual(r.markersByPath.get('/tmp/report.pdf'), ['[bridge-attach: /tmp/report.pdf  ]']);
});

test('parseBridgeAttachMarkers: multiple distinct markers are returned in encounter order', () => {
  const r = parseBridgeAttachMarkers(
    'first [bridge-attach: /a/x.png] then [bridge-attach: /b/y.pdf] done',
  );
  assert.deepEqual(r.paths, ['/a/x.png', '/b/y.pdf']);
});

test('parseBridgeAttachMarkers: duplicate paths are deduped but all marker substrings tracked', () => {
  const r = parseBridgeAttachMarkers(
    '[bridge-attach: /tmp/a.txt] middle [bridge-attach: /tmp/a.txt]',
  );
  assert.deepEqual(r.paths, ['/tmp/a.txt']);
  assert.equal(r.markersByPath.get('/tmp/a.txt')!.length, 2);
});

test('parseBridgeAttachMarkers: empty path inside marker is ignored', () => {
  const r = parseBridgeAttachMarkers('garbage [bridge-attach:    ] inside');
  // Regex requires at least one non-`]`/non-newline char after the colon+space,
  // so a whitespace-only marker doesn't match in the first place.
  assert.deepEqual(r.paths, []);
});

test('parseBridgeAttachMarkers: marker with newline inside path does not match (avoid greedy multi-line capture)', () => {
  const r = parseBridgeAttachMarkers('open [bridge-attach: /a/x\n/b/y]');
  assert.deepEqual(r.paths, []);
});

test('stripMarkersForPath: removes only the requested path markers', () => {
  const original =
    'before [bridge-attach: /a/x.png] middle [bridge-attach: /b/y.pdf] after';
  const parsed = parseBridgeAttachMarkers(original);
  const stripped = stripMarkersForPath(original, parsed, '/a/x.png');
  assert.equal(stripped.includes('/a/x.png'), false);
  assert.equal(stripped.includes('/b/y.pdf'), true, 'unrelated marker must remain');
});

test('stripMarkersForPath: collapses whitespace-only lines created by stripping', () => {
  const original = 'paragraph one\n[bridge-attach: /a/x.png]\n\nparagraph two';
  const parsed = parseBridgeAttachMarkers(original);
  const stripped = stripMarkersForPath(original, parsed, '/a/x.png');
  assert.equal(stripped, 'paragraph one\n\nparagraph two');
});

test('readBoundedFileWithinRoots: happy path reads bytes and reports realPath under the configured root', async () => {
  const root = await tmpDir();
  const file = path.join(root, 'hello.txt');
  await fs.writeFile(file, 'hello bytes');
  const r = await readBoundedFileWithinRoots({
    filePath: file,
    allowedRoots: [root],
    maxBytes: 1024,
  });
  assert.equal(r.buffer.toString('utf8'), 'hello bytes');
  assert.equal(r.realPath, file);
  assert.equal(r.size, 'hello bytes'.length);
});

test('readBoundedFileWithinRoots: relative path resolves against the first allowed root', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'a.txt'), 'A');
  const r = await readBoundedFileWithinRoots({
    filePath: 'a.txt',
    allowedRoots: [root],
    maxBytes: 1024,
  });
  assert.equal(r.buffer.toString('utf8'), 'A');
});

test('readBoundedFileWithinRoots: traversal escape is rejected with outside-roots', async () => {
  const root = await tmpDir();
  // Set up a sibling dir that should be unreachable.
  const outside = await tmpDir();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'no');
  const escapeAttempt = path.join(root, '..', path.basename(outside), 'secret.txt');
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: escapeAttempt, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'outside-roots',
  );
});

test('readBoundedFileWithinRoots: symlink terminal component is rejected (resolved target outside root)', async () => {
  // skip on win32: symlink creation typically requires admin, and our
  // test environment is unix-only for this case.
  if (process.platform === 'win32') return;
  const root = await tmpDir();
  const outside = await tmpDir();
  const target = path.join(outside, 'secret.txt');
  await fs.writeFile(target, 'leaked');
  const link = path.join(root, 'leak.txt');
  await fs.symlink(target, link);
  // realpath resolves the symlink to its outside-root target -> outside-roots.
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: link, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'outside-roots',
  );
});

test('readBoundedFileWithinRoots: hardlink (nlink>1) is rejected so a model cannot smuggle outside paths in', async () => {
  if (process.platform === 'win32') return;
  const root = await tmpDir();
  const original = path.join(root, 'orig.txt');
  await fs.writeFile(original, 'shared inode');
  // Create a second hardlink so nlink becomes 2 - same content, two paths.
  const hardlink = path.join(root, 'alias.txt');
  await fs.link(original, hardlink);
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: hardlink, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'hardlink',
  );
});

test('readBoundedFileWithinRoots: directory rejected with not-file', async () => {
  const root = await tmpDir();
  const sub = path.join(root, 'sub');
  await fs.mkdir(sub);
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: sub, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'not-file',
  );
});

test('readBoundedFileWithinRoots: oversized file rejected with too-large', async () => {
  const root = await tmpDir();
  const big = path.join(root, 'big.bin');
  await fs.writeFile(big, Buffer.alloc(2048));
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: big, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'too-large',
  );
});

test('readBoundedFileWithinRoots: missing file rejected with not-found', async () => {
  const root = await tmpDir();
  const missing = path.join(root, 'nope.txt');
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: missing, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'not-found',
  );
});

test('readBoundedFileWithinRoots: empty allowedRoots rejected upfront', async () => {
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: '/etc/hosts', allowedRoots: [], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'outside-roots',
  );
});

test('readBoundedFileWithinRoots: empty filePath rejected as invalid-path', async () => {
  const root = await tmpDir();
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: '', allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'invalid-path',
  );
});

test('readBoundedFileWithinRoots: NUL byte in path rejected as invalid-path', async () => {
  const root = await tmpDir();
  // Build the path string at runtime to avoid putting a literal NUL in source.
  const nulPath = `${root}/evil${String.fromCharCode(0)}name.txt`;
  await assert.rejects(
    readBoundedFileWithinRoots({ filePath: nulPath, allowedRoots: [root], maxBytes: 1024 }),
    (err: unknown) => err instanceof SafeReadError && err.code === 'invalid-path',
  );
});

test('inferMimeFromPath: known extensions map to specific mimes; unknown falls back to octet-stream', () => {
  assert.equal(inferMimeFromPath('/x/cat.png'), 'image/png');
  assert.equal(inferMimeFromPath('/x/REPORT.PDF'), 'application/pdf');
  assert.equal(inferMimeFromPath('/x/notes.md'), 'text/markdown');
  assert.equal(inferMimeFromPath('/x/blob.unknownext'), 'application/octet-stream');
  assert.equal(inferMimeFromPath('/x/no-extension'), 'application/octet-stream');
});
