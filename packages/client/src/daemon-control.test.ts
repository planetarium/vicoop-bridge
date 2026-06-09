import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LivenessProbe,
  type PidRecord,
  claimPidFile,
  detachChildArgv,
  formatUptime,
  inspectDaemon,
  isEmbeddedEntryPoint,
  processAlive,
  processIsOurs,
  processStartId,
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
  procStartId: '998877',
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
      procStartId: '',
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

test('processStartId is stable + non-empty for our own pid (linux/darwin)', () => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const a = processStartId(process.pid);
  assert.ok(a.length > 0, 'expected a start id on linux/darwin');
  // Same process queried twice ⇒ identical identity.
  assert.equal(processStartId(process.pid), a);
});

test('processIsOurs: start-id match is authoritative over the heuristic', () => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const id = processStartId(process.pid);
  // Same pid + recorded start id that matches the live one ⇒ ours, even though
  // the test runner's command line is NOT a vicoop-client daemon (so the
  // fallback heuristic alone would say "not ours").
  assert.equal(
    processIsOurs(process.pid, { ...sampleRecord, pid: process.pid, procStartId: id }),
    true,
  );
  // Recorded start id that does NOT match the live one ⇒ a recycled PID. The
  // mismatch is authoritative; the heuristic must not rescue it.
  assert.equal(
    processIsOurs(process.pid, {
      ...sampleRecord,
      pid: process.pid,
      procStartId: 'not-the-real-start-id',
    }),
    false,
  );
});

test('claimPidFile: claims an unheld pidfile and writes the placeholder', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    const r = claimPidFile(sampleRecord, { path });
    assert.equal(r.ok, true);
    // The placeholder is on disk and readable.
    assert.deepEqual(readPidRecord(path), sampleRecord);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimPidFile: refuses when a live+ours daemon already holds it', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    writePidRecord(sampleRecord, path);
    const r = claimPidFile(sampleRecord, { path, probe: aliveProbe });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false ? r.reason : undefined, 'running');
    assert.equal(r.ok === false ? r.record.pid : undefined, 4242);
    // Existing record untouched.
    assert.deepEqual(readPidRecord(path), sampleRecord);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimPidFile: clears a stale pidfile and claims it', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'vicoop.pid');
    // A corpse: present on disk but the process is gone / not ours.
    writePidRecord({ ...sampleRecord, pid: 4242 }, path);
    const deadProbe: LivenessProbe = { alive: () => false, matches: () => true };
    const placeholder = { ...sampleRecord, pid: 5555 };
    const r = claimPidFile(placeholder, { path, probe: deadProbe });
    assert.equal(r.ok, true);
    assert.deepEqual(readPidRecord(path), placeholder);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isEmbeddedEntryPoint detects Bun compiled-binary entry paths', () => {
  assert.equal(isEmbeddedEntryPoint('/$bunfs/root/vicoop-client-0.30.0-macos-arm64'), true);
  assert.equal(isEmbeddedEntryPoint('B:\\~BUN\\root\\vicoop-client'), true);
  assert.equal(isEmbeddedEntryPoint('B:/~BUN/root/vicoop-client'), true);
  // Real script paths are NOT embedded entries.
  assert.equal(isEmbeddedEntryPoint('/opt/vicoop/dist/cli.js'), false);
  assert.equal(isEmbeddedEntryPoint('/usr/local/bin/vicoop-client'), false);
  assert.equal(isEmbeddedEntryPoint(undefined), false);
});

test('detachChildArgv reconstructs node argv (keeps the script path)', () => {
  // node dist/cli.js start --detach --backend echo
  const argv = ['/usr/bin/node', '/opt/vicoop/dist/cli.js', 'start', '--detach', '--backend', 'echo'];
  assert.deepEqual(detachChildArgv(argv), [
    '/opt/vicoop/dist/cli.js',
    'start',
    '--backend',
    'echo',
  ]);
});

test('detachChildArgv reconstructs Bun compiled argv (drops the $bunfs entry)', () => {
  // The 0.30.0 regression: argv[1] is the embedded virtual entry, which must
  // NOT be passed back or the relaunched CLI parses it as a subcommand.
  const argv = [
    '/Users/op/.vicoop/bin/vicoop-client',
    '/$bunfs/root/vicoop-client-0.30.0-macos-arm64',
    'start',
    '--detach',
    '--backend',
    'echo',
  ];
  assert.deepEqual(detachChildArgv(argv), ['start', '--backend', 'echo']);
});

test('detachChildArgv strips the short -d detach flag too', () => {
  const argv = ['/usr/bin/node', '/opt/vicoop/dist/cli.js', 'start', '-d', '-c', '/tmp/cfg.json'];
  // `-c` (config) is preserved — the child needs it; only the detach trigger
  // is dropped.
  assert.deepEqual(detachChildArgv(argv), ['/opt/vicoop/dist/cli.js', 'start', '-c', '/tmp/cfg.json']);
});

test('detachChildArgv strips --log-file and its value (both forms)', () => {
  const spaced = ['node', 'cli.js', 'start', '--log-file', '/tmp/x.log', '--detach', '--backend', 'echo'];
  assert.deepEqual(detachChildArgv(spaced), ['cli.js', 'start', '--backend', 'echo']);
  const eq = ['node', 'cli.js', 'start', '--log-file=/tmp/x.log', '--backend', 'echo', '--detach'];
  assert.deepEqual(detachChildArgv(eq), ['cli.js', 'start', '--backend', 'echo']);
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
