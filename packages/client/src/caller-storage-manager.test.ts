import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, lstat, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCallerDatabase } from './caller-runtime-sqlite.js';
import { parseStorageRequest, runStorageManager, type StorageRequest } from './caller-storage-manager.js';

const request: StorageRequest = {
  action: 'delete', key: 'a'.repeat(64), uuid: '12345678-1234-1234-1234-123456789abc',
  size: 64 * 1048576, budget: 128 * 1048576, reserve: 64 * 1048576,
};

test('deletion retry after detach removes stale alias without detaching recycled device', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'managed'), aliases = join(directory, 'by-uuid');
  await mkdir(root); await mkdir(aliases);
  const image = join(root, `${request.key}.img`), alias = join(aliases, request.uuid);
  await writeFile(image, 'retained'); await symlink('/dev/loop7', alias);
  const db = await openCallerDatabase(join(root, 'catalog.sqlite'));
  db.exec('CREATE TABLE policy (budget INTEGER, reserve INTEGER); CREATE TABLE images (key TEXT PRIMARY KEY, uuid TEXT UNIQUE, size INTEGER, state TEXT)');
  db.prepare('INSERT INTO policy VALUES (?,?)').run(request.budget, request.reserve);
  db.prepare('INSERT INTO images VALUES (?,?,?,?)').run(request.key, request.uuid, request.size, 'ready');
  db.close();
  let attached = true;
  const detached: string[] = [];
  const run = (...args: string[]) => {
    if (args[0] === 'losetup' && args[1] === '-j' && args[2] === image)
      return attached ? `/dev/loop7: []: (${image})` : '';
    if (args[0] === 'losetup' && args[1] === '-d' && args[2] === '/dev/loop7') {
      assert(attached, 'must not detach recycled loop belonging to B');
      attached = false; detached.push(args[2]);
      throw new Error('injected crash after detach');
    }
    throw new Error(`unexpected Linux mutation: ${args}`);
  };
  await assert.rejects(runStorageManager(request, { root, aliases, run }), /injected crash/);
  assert.equal(await readFile(image, 'utf8'), 'retained');
  assert((await lstat(alias)).isSymbolicLink());
  // loop7 now belongs to B; querying/detaching it by the stale alias is wrong.
  await runStorageManager(request, { root, aliases, run });
  assert.deepEqual(detached, ['/dev/loop7']);
  await assert.rejects(lstat(image), { code: 'ENOENT' });
  await assert.rejects(lstat(alias), { code: 'ENOENT' });
  const reopened = await openCallerDatabase(join(root, 'catalog.sqlite'));
  assert.deepEqual(reopened.prepare('SELECT * FROM images').all(), []);
  reopened.close();
});

test('failed allocation stays charged and cannot be reformatted on retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-admission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'managed'), aliases = join(directory, 'by-uuid');
  const allocation = { ...request, action: 'create' as const, budget: request.size };
  const calls: string[][] = [];
  const run = (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'fallocate') throw new Error('injected allocation failure');
    if (args[0] === 'losetup' && args[1] === '-j') return '';
    throw new Error(`unexpected Linux mutation: ${args}`);
  };
  await assert.rejects(runStorageManager(allocation, { root, aliases, run }), /injected allocation failure/);
  await assert.rejects(runStorageManager(allocation, { root, aliases, run }), /incomplete allocation/);
  await assert.rejects(runStorageManager({ ...allocation, key: 'b'.repeat(64), uuid: '23456789-1234-1234-1234-123456789abc' }, { root, aliases, run }), /pool capacity exhausted/);
  assert.equal(calls.length, 1, 'no repeated allocation or formatting');
  await runStorageManager({ ...allocation, action: 'delete' }, { root, aliases, run });
  const db = await openCallerDatabase(join(root, 'catalog.sqlite'));
  assert.deepEqual(db.prepare('SELECT * FROM images').all(), []);
  db.close();
});

test('storage helper validates CLI identity and capacity before filesystem operations', () => {
  const args = ['create', request.key, request.uuid, String(request.size), String(request.budget), String(request.reserve)];
  assert.deepEqual(parseStorageRequest(args), { ...request, action: 'create' });
  for (const [index, value] of [[0, 'format'], [1, '../escape'], [2, 'bad-uuid'], [3, '-1'], [4, 'Infinity'], [5, '1.5']] as const) {
    const invalid = [...args]; invalid[index] = value;
    assert.throws(() => parseStorageRequest(invalid));
  }
  assert.throws(() => parseStorageRequest([...args, 'unexpected']));
});
