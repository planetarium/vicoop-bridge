import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shutdownAndReleasePidFile } from './daemon-shutdown.js';
import { createLogger } from './logger.js';
const logger = createLogger('silent');

test('only completed shutdown removes the owned pidfile', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-pid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'daemon.pid');
  for (const shutdown of [undefined, async () => {}]) {
    writeFileSync(path, 'owned-pid-record');
    assert.equal(await shutdownAndReleasePidFile(shutdown, logger, { timeoutMs: 100, removePidFile: () => rmSync(path) }), true);
    assert.equal(existsSync(path), false);
  }
});

test('failed or timed-out cleanup preserves the pidfile, even if late cleanup resolves', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-failed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'daemon.pid');
  writeFileSync(path, 'owned-pid-record');
  let resolve!: () => void;
  const pending = new Promise<void>(r => { resolve = r; });
  for (const shutdown of [async () => { throw new Error('cleanup unconfirmed'); }, () => pending]) {
    assert.equal(await shutdownAndReleasePidFile(shutdown, logger, { timeoutMs: 10, removePidFile: () => rmSync(path) }), false);
    assert.equal(existsSync(path), true);
  }
  resolve();
  await pending;
  assert.equal(existsSync(path), true);
});
