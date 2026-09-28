import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemonShutdown, shutdownAndReleasePidFile } from './daemon-shutdown.js';
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

for (const triggers of [[true, false], [false, true], [false, false]]) {
  test(`overlapping shutdown triggers ${triggers} share cleanup and preserve fatal status`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'shutdown-overlap-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'daemon.pid');
    writeFileSync(path, 'owned');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stops = 0, cleanups = 0, removals = 0;
    const exits: number[] = [];
    const shutdown = createDaemonShutdown({ logger, timeoutMs: 1000,
      stop: () => { stops++; },
      shutdown: async () => { cleanups++; await gate; },
      removePidFile: () => { removals++; rmSync(path); },
      exit: code => { exits.push(code); },
    });
    const first = shutdown(triggers[0]);
    await Promise.resolve();
    const second = shutdown(triggers[1]);
    assert.equal(first, second);
    assert.equal(stops, 1);
    assert.equal(cleanups, 1);
    assert.equal(existsSync(path), true);
    assert.deepEqual(exits, []);
    release();
    await first;
    assert.equal(removals, 1);
    assert.equal(existsSync(path), false);
    assert.deepEqual(exits, [triggers.includes(true) ? 1 : 0]);
  });
}

test('fatal cleanup failure or timeout preserves pidfile and exits once despite signals', async () => {
  for (const cleanup of [async () => { throw Error('failure'); }, () => new Promise<void>(() => {})]) {
    let removed = false, calls = 0;
    const exits: number[] = [];
    const shutdown = createDaemonShutdown({ logger, timeoutMs: 10,
      stop: () => {}, shutdown: () => { calls++; return cleanup(); },
      removePidFile: () => { removed = true; }, exit: code => { exits.push(code); },
    });
    await Promise.all([shutdown(true), shutdown(), shutdown()]);
    assert.equal(calls, 1);
    assert.equal(removed, false);
    assert.deepEqual(exits, [1]);
  }
});

test('stop failure and synchronous re-entry still run backend cleanup once', async () => {
  let calls = 0;
  const exits: number[] = [];
  const shutdown = createDaemonShutdown({ logger, timeoutMs: 100,
    stop: () => { void shutdown(true); throw Error('stop failed'); },
    shutdown: async () => { calls++; }, exit: code => { exits.push(code); },
  });
  await shutdown();
  assert.equal(calls, 1);
  assert.deepEqual(exits, [1]);
});
