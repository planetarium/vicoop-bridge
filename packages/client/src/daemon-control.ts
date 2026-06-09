// Unattended-operation lifecycle for `vicoop-client start --detach` (issue
// #190, tier 0). The detached daemon is spawned (in cli.ts) via Node's
// `spawn({ detached: true })`, which makes the child a fresh session /
// process-group leader (the `setsid` effect). That's what lets it outlive
// the session/pgrp reaping that kills a plain `nohup … &` in agent-driven
// exec sandboxes (#186) — `nohup` only sets SIGHUP→SIG_IGN, which is no
// defense against the SIGTERM/SIGKILL such environments send to the whole
// process group when the spawning shell turn ends.
//
// This module owns the pidfile: where it lives, its on-disk shape, and the
// stale-vs-live discrimination that keeps `stop`/`status` from acting on a
// PID the OS has since recycled to an unrelated process.
//
// Scope caveat (documented for operators in docs + the issue): a detached
// daemon survives session/pgrp teardown but NOT cgroup/container teardown.
// Surviving the latter is the tier-1 `service install` (launchd /
// systemd --user) job — an out-of-cgroup supervisor — not this one.
//
// POSIX-focused: `--detach` is rejected on win32 at the call site (cli.ts),
// and the PID-reuse command match below is a no-op there. The target
// environments for this feature are Linux/macOS agent sandboxes.

import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfigDir } from './config.js';
import { atomicWriteFile } from './fs-util.js';

const PID_FILENAME = 'vicoop.pid';
const LOG_FILENAME = 'vicoop.log';

// On-disk pidfile shape. Written by the *parent* immediately after fork
// (it already holds the child pid), which sidesteps the classic
// Type=forking race where a supervisor reads the pidfile before the child
// has written it.
export interface PidRecord {
  pid: number;
  // ms-epoch wall clock at spawn. Used for the `status` uptime readout and
  // as a diagnostic — deliberately NOT the PID-reuse guard (wall clock is
  // unreliable across reboots / clock changes); the command match is.
  startedAt: number;
  // The exact argv we launched the child with (execPath + args). Surfaced
  // by `status` and feeds the command-match heuristic.
  argv: string[];
  // Where the detached child's stdout+stderr were redirected.
  logPath: string;
  // Client semver that wrote the file, for cross-version diagnostics.
  version: string;
}

export function pidFilePath(dir: string = resolveConfigDir()): string {
  return join(dir, PID_FILENAME);
}

export function defaultLogPath(dir: string = resolveConfigDir()): string {
  return join(dir, LOG_FILENAME);
}

// Parse + shape-check the pidfile. Returns null for "missing / unreadable /
// not a JSON object / no usable pid" — every one of which the daemon
// lifecycle treats as "no detached daemon recorded". Non-pid fields are
// best-effort: an older or partially-written file still yields a record
// usable for the liveness check as long as `pid` is a positive integer.
export function readPidRecord(path: string = pidFilePath()): PidRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) {
    return null;
  }
  return {
    pid: o.pid,
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
    argv: Array.isArray(o.argv)
      ? o.argv.filter((x): x is string => typeof x === 'string')
      : [],
    logPath: typeof o.logPath === 'string' ? o.logPath : '',
    version: typeof o.version === 'string' ? o.version : '',
  };
}

// Atomic write at 0o600 — the argv may echo back operator-supplied tokens
// passed on the command line, so treat it like the other secret-adjacent
// files (config.json / owner-session.json).
export function writePidRecord(rec: PidRecord, path: string = pidFilePath()): void {
  atomicWriteFile(path, `${JSON.stringify(rec, null, 2)}\n`, 0o600);
}

export function removePidFile(path: string = pidFilePath()): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone — idempotent by design */
  }
}

// Liveness check. `kill(pid, 0)` sends no signal but performs the same
// permission + existence checks as a real signal: ESRCH ⇒ no such process,
// EPERM ⇒ the process exists but we may not signal it (still "alive" for our
// purposes). Any other error is treated as not-alive.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Best-effort defense against PID reuse. `processAlive` only proves *some*
// process holds that PID — once the daemon dies and the OS recycles its PID,
// that could be anything (a shell, a worker, an editor). Before we signal it
// (`stop`) or report it as our daemon (`status`), confirm the live process's
// command line still looks like a vicoop-client daemon.
//
// POSIX-only via `ps`; returns true on win32 (no `ps`) so the caller falls
// back to liveness-only there. Returns false when `ps` can't confirm
// (process vanished mid-check, ps absent, perms) — the conservative choice,
// since acting on an unconfirmed PID is the failure mode we're guarding
// against.
export function processCommandMatches(pid: number, _rec: PidRecord): boolean {
  if (process.platform === 'win32') return true;
  let out: string;
  try {
    out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return false;
  }
  if (!out) return false;
  // Both shipping shapes carry a recognizable entrypoint marker:
  //   - installed Bun single-file build:  …/vicoop-client start …
  //   - node-from-source / dev:           node …/dist/cli.js start …
  // Require the daemon entrypoint marker AND the `start` subcommand so an
  // unrelated recycled process (`nginx: worker`, `node some-other-app`)
  // doesn't match.
  const hasEntrypoint = out.includes('vicoop-client') || out.includes('cli.js');
  const hasStart = /(^|\s)start(\s|$)/.test(out);
  return hasEntrypoint && hasStart;
}

// Injectable liveness seam so the lifecycle helpers below can be unit-tested
// without spawning real OS processes or shelling out to `ps`.
export interface LivenessProbe {
  alive(pid: number): boolean;
  matches(pid: number, rec: PidRecord): boolean;
}

const defaultProbe: LivenessProbe = {
  alive: processAlive,
  matches: processCommandMatches,
};

export type DaemonState =
  // pidfile present, process alive and confirmed ours
  | { status: 'running'; record: PidRecord }
  // pidfile present, but the process is gone or no longer looks like ours
  // (crash, manual kill, or PID reuse). Safe to clean up; never to signal.
  | { status: 'stale'; record: PidRecord }
  // no pidfile at all
  | { status: 'stopped' };

export function inspectDaemon(
  path: string = pidFilePath(),
  probe: LivenessProbe = defaultProbe,
): DaemonState {
  const record = readPidRecord(path);
  if (!record) return { status: 'stopped' };
  if (probe.alive(record.pid) && probe.matches(record.pid, record)) {
    return { status: 'running', record };
  }
  return { status: 'stale', record };
}

export type StopOutcome =
  | 'not-running' // no pidfile
  | 'already-gone' // pidfile present but stale; cleaned up, nothing signaled
  | 'stopped' // exited within the SIGTERM grace window
  | 'killed'; // ignored SIGTERM; escalated to SIGKILL

export interface StopResult {
  outcome: StopOutcome;
  pid?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// SIGTERM → grace → SIGKILL, then remove the pidfile. Refuses to signal a
// stale/recycled PID: an unconfirmed pidfile is cleaned up and reported as
// `already-gone` rather than risking a kill of an unrelated process.
//
// The `kill` / `probe` / `wait` seams are injectable for tests; defaults
// are the real `process.kill`, the real liveness probe, and a setTimeout
// sleep.
export async function stopDaemon(
  opts: {
    path?: string;
    termGraceMs?: number;
    pollMs?: number;
    probe?: LivenessProbe;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<StopResult> {
  const path = opts.path ?? pidFilePath();
  const termGraceMs = opts.termGraceMs ?? 10_000;
  const pollMs = opts.pollMs ?? 200;
  const probe = opts.probe ?? defaultProbe;
  const wait = opts.wait ?? sleep;
  const kill =
    opts.kill ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });

  const state = inspectDaemon(path, probe);
  if (state.status === 'stopped') return { outcome: 'not-running' };
  if (state.status === 'stale') {
    removePidFile(path);
    return { outcome: 'already-gone', pid: state.record.pid };
  }

  const pid = state.record.pid;
  try {
    kill(pid, 'SIGTERM');
  } catch {
    // Raced us to exit between inspect and signal — treat as already gone.
    removePidFile(path);
    return { outcome: 'already-gone', pid };
  }

  // Poll for graceful exit within the grace window.
  const polls = Math.max(1, Math.ceil(termGraceMs / pollMs));
  for (let i = 0; i < polls; i++) {
    await wait(pollMs);
    if (!probe.alive(pid)) {
      removePidFile(path);
      return { outcome: 'stopped', pid };
    }
  }

  // Ignored SIGTERM — escalate. SIGKILL can't be caught, so a short final
  // settle is enough before we drop the pidfile regardless.
  try {
    kill(pid, 'SIGKILL');
  } catch {
    /* exited between the last poll and here */
  }
  await wait(pollMs);
  removePidFile(path);
  return { outcome: 'killed', pid };
}

// Human-friendly "up 2h 3m 4s" for `status`. Always ends with a seconds
// component so a sub-minute uptime still reads as a duration. Guards
// non-finite / negative inputs (e.g. an absent or future `startedAt`).
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
