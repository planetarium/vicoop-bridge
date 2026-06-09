import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LivenessProbe,
  type PidRecord,
  formatUptime,
  inspectDaemon,
  processAlive,
  readPidRecord,
  removePidFile,
  stopDaemon,
  writePidRecord,
} from './daemon-control.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'vicoop-daemon-'));
}

const sampleRecord: PidRecord = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  argv: ['/usr/bin/node', '/opt/vicoop/cli.js', 'start', '--backend', 'claude'],
  logPath: '/home/op/.vicoop/vicoop.log',
  version: '0.29.0',
};

// A probe that reports everything alive + ours, for "running" assertions.
const aliveProbe: LivenessProbe = { alive: () => true, matches: () => true };

test('readPidRecord returns null for missing / malformed files', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    assert.equal(readPidRecord(path), null, 'missing file');

    writeFileSync(path, 'not json');
    assert.equal(readPidRecord(path), null, 'invalid json');

    writeFileSync(path, '[1,2,3]');
    assert.equal(readPidRecord(path), null, 'json array, not object');

    writeFileSync(path, JSON.stringify({ startedAt: 1 }));
    assert.equal(readPidRecord(path), null, 'no pid field');

    writeFileSync(path, JSON.stringify({ pid: 0 }));
    assert.equal(readPidRecord(path), null, 'non-positive pid');

    writeFileSync(path, JSON.stringify({ pid: 12.5 }));
    assert.equal(readPidRecord(path), null, 'non-integer pid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPidRecord defaults best-effort fields when partial', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    // Only `pid` present — older / truncated file. Still usable for liveness.
    writeFileSync(path, JSON.stringify({ pid: 777 }));
    const rec = readPidRecord(path);
    assert.deepEqual(rec, {
      pid: 777,
      startedAt: 0,
      argv: [],
      logPath: '',
      version: '',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePidRecord round-trips and writes 0600', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    assert.deepEqual(readPidRecord(path), sampleRecord);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removePidFile is idempotent', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    removePidFile(path);
    assert.equal(readPidRecord(path), null);
    // Second removal of an already-absent file must not throw.
    removePidFile(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processAlive is true for our own pid', () => {
  assert.equal(processAlive(process.pid), true);
});

test('processAlive is false for an exited process', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // Brief settle so the OS has reaped the (parented) child.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(processAlive(pid), false);
});

test('inspectDaemon: stopped when no pidfile', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(inspectDaemon(join(dir, 'vicoop.pid')), {
      status: 'stopped',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectDaemon: running when alive and command matches', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const state = inspectDaemon(path, aliveProbe);
    assert.equal(state.status, 'running');
    assert.equal(
      state.status === 'running' ? state.record.pid : undefined,
      4242,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectDaemon: stale when alive but command does not match (PID reuse)', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const reusedPid: LivenessProbe = { alive: () => true, matches: () => false };
    assert.equal(inspectDaemon(path, reusedPid).status, 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectDaemon: stale when the process is gone', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const deadProbe: LivenessProbe = { alive: () => false, matches: () => true };
    assert.equal(inspectDaemon(path, deadProbe).status, 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopDaemon: not-running when no pidfile', async () => {
  const dir = tmpDir();
  try {
    const r = await stopDaemon({ path: join(dir, 'vicoop.pid') });
    assert.equal(r.outcome, 'not-running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopDaemon: stale pidfile is cleaned without signaling', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    let signaled = false;
    const r = await stopDaemon({
      path,
      probe: { alive: () => false, matches: () => true },
      kill: () => {
        signaled = true;
      },
    });
    assert.equal(r.outcome, 'already-gone');
    assert.equal(r.pid, 4242);
    assert.equal(signaled, false, 'must not signal a stale PID');
    assert.equal(readPidRecord(path), null, 'pidfile cleaned up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopDaemon: SIGTERM, process exits within grace', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const signals: NodeJS.Signals[] = [];
    let polls = 0;
    // Alive for inspect + the first poll, then "exits".
    const probe: LivenessProbe = {
      alive: () => polls++ < 2,
      matches: () => true,
    };
    const r = await stopDaemon({
      path,
      probe,
      pollMs: 1,
      termGraceMs: 100,
      wait: async () => {},
      kill: (_pid, sig) => {
        signals.push(sig);
      },
    });
    assert.equal(r.outcome, 'stopped');
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(readPidRecord(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopDaemon: escalates to SIGKILL when SIGTERM is ignored', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const signals: NodeJS.Signals[] = [];
    const r = await stopDaemon({
      path,
      probe: { alive: () => true, matches: () => true }, // never dies
      pollMs: 1,
      termGraceMs: 5,
      wait: async () => {},
      kill: (_pid, sig) => {
        signals.push(sig);
      },
    });
    assert.equal(r.outcome, 'killed');
    assert.ok(signals.includes('SIGTERM'));
    assert.ok(signals.includes('SIGKILL'));
    assert.equal(readPidRecord(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopDaemon: SIGTERM throwing (raced exit) is treated as already-gone', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const r = await stopDaemon({
      path,
      probe: { alive: () => true, matches: () => true },
      kill: () => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
    });
    assert.equal(r.outcome, 'already-gone');
    assert.equal(readPidRecord(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatUptime renders compact durations', () => {
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(5_000), '5s');
  assert.equal(formatUptime(65_000), '1m 5s');
  assert.equal(formatUptime(3_600_000 + 120_000 + 3_000), '1h 2m 3s');
  assert.equal(formatUptime(86_400_000 + 3_000), '1d 3s');
  assert.equal(formatUptime(-1), 'unknown');
  assert.equal(formatUptime(Number.NaN), 'unknown');
});
