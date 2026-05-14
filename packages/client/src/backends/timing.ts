import { safeToken, type Logger } from '../logger.js';

export interface TimingRecorderOptions {
  readonly logger: Logger;
  readonly backend: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly now?: () => number;
}

export interface TimingRecorder {
  mark(name: string): void;
  finish(meta?: Record<string, string | number | boolean | undefined>): void;
}

// Per-task timing recorder: stamp named milestones with their elapsed time
// from `handle()` entry, then emit a single structured `[client] timing …`
// line at the terminal emit. One line per task keeps log volume bounded
// while preserving the full phase distribution for offline analysis
// (grep / awk / cut). `mark()` is idempotent per name — only the first
// arrival is recorded, which is the meaningful one for one-shot
// milestones like first-stdout-byte.
//
// Emitted at `debug` so the default `info` level does not gain a
// per-task log line in production; operators opt in via
// `VICOOP_CLIENT_LOG_LEVEL=debug` when investigating overhead.
export function createTimingRecorder(opts: TimingRecorderOptions): TimingRecorder {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const seen = new Set<string>();
  const marks: Array<[string, number]> = [];
  let finished = false;
  return {
    mark(name: string): void {
      if (finished) return;
      if (seen.has(name)) return;
      seen.add(name);
      marks.push([name, now() - t0]);
    },
    finish(meta = {}): void {
      if (finished) return;
      finished = true;
      const total = now() - t0;
      const fields: string[] = [
        `backend=${opts.backend}`,
        `taskId=${safeToken(opts.taskId)}`,
        `contextId=${safeToken(opts.contextId)}`,
      ];
      for (const [name, ms] of marks) {
        fields.push(`${name}Ms=${ms}`);
      }
      fields.push(`totalMs=${total}`);
      for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue;
        const raw = typeof v === 'string' ? safeToken(v) : String(v);
        fields.push(`${k}=${raw}`);
      }
      opts.logger.debug(`timing ${fields.join(' ')}`);
    },
  };
}
