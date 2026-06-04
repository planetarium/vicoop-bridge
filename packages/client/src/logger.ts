export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const PREFIX = '[client]';
const timestamp = (): string => new Date().toISOString();
export const LOG_LEVEL_ENV = 'VICOOP_CLIENT_LOG_LEVEL';

export interface Logger {
  readonly level: LogLevel;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

// Subset of `Console` the logger writes to. Letting callers (and tests)
// inject this sink avoids monkey-patching the global console — important
// because Node's test runner can execute test files concurrently in
// separate processes, but a future refactor that drops process isolation
// would re-introduce cross-file flakiness on a global-patch approach.
export interface ConsoleSink {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  log(...args: unknown[]): void;
}

export function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

// Process-wide dedup of "ignoring invalid" warnings. Without this,
// `createLogger` (called per Client instance) would re-emit the same
// warning every time it ran, contradicting the PR's "warn once" promise
// in long-running processes that build multiple loggers.
const warnedKeys = new Set<string>();

// Test-only: clear the dedup state so warn-asserting tests don't suffer
// from prior tests' suppression. Underscored to signal non-public.
export function _resetLogLevelWarningsForTests(): void {
  warnedKeys.clear();
}

function warnOnce(sink: ConsoleSink, key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  sink.warn(timestamp(), PREFIX, message);
}

// JSON.stringify covers \n / \r / control chars and the standard JSON
// escapes, but the spec leaves U+2028 (Line Separator) and U+2029
// (Paragraph Separator) raw — and several log collectors / terminals
// render them as line breaks. Replace them with their `\uXXXX` escape
// sequences so the single-line invariant survives those sinks too.
// Exported for callers that already produced a JSON.stringify'd string
// (so the standard escapes are already applied) but still need the
// U+2028 / U+2029 hardening before the value lands in a log line.
// Internal `safeToken` / `safeForLog` callers should keep using those
// wrappers \u2014 this is a lower-level helper for places that build their
// own JSON payload.
export function escapeLineSeparators(s: string): string {
  return s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Quote+escape+truncate. Use for "what value was rejected"-style messages
// where the surrounding quotes help operators see the exact string the
// client received. Newlines and control chars are escaped; long inputs
// are truncated with an ellipsis.
function safeForLog(value: string, maxLen = 120): string {
  const escaped = escapeLineSeparators(JSON.stringify(value));
  if (escaped.length <= maxLen) return escaped;
  // Trim to maxLen and tack on an ellipsis. The result intentionally
  // doesn't preserve the closing quote — readers see the truncation.
  return `${escaped.slice(0, maxLen - 1)}…`;
}

// Escape+truncate without surrounding quotes. Use for lifecycle log
// tokens (taskId=, contextId=, parts=, errorClass=, …) where wire-derived
// values must not be able to break out of the log line. A plain ASCII
// taskId like `abc-123` is left unchanged; a hostile value like
// `evil\n[client] FAKE` is escaped to `evil\\n[client] FAKE`, preserving
// the single-line invariant.
export function safeToken(value: string, maxLen = 200): string {
  // JSON.stringify produces a fully escaped, double-quoted string; strip
  // the surrounding quotes to keep tokens lightweight while inheriting
  // every escape rule (\n, \r, \t, \", \\, \uXXXX for control chars).
  // The line-separator post-process closes the U+2028/U+2029 gap left by
  // JSON.stringify.
  const escaped = escapeLineSeparators(JSON.stringify(value).slice(1, -1));
  return escaped.length <= maxLen ? escaped : `${escaped.slice(0, maxLen - 1)}…`;
}

// Normalize a level string from any source (explicit option, env var) by
// trimming and lowercasing, then validating against the known set. An
// invalid non-empty value is reported via `warnOnce` (per distinct
// source+value) and returns `undefined` so the caller can fall through to
// the next priority. We validate explicit values too — even though TS
// `LogLevel` constrains them for typed callers, a plain-JS consumer can
// still pass anything, and an unrecognized string would otherwise produce
// `LEVEL_RANK[v] === undefined` and silently disable every level.
//
// `raw` is typed `unknown` rather than `string | undefined` so a JS caller
// passing a number/object/null doesn't crash the client at startup with a
// "raw.trim is not a function" TypeError; we warn and fall through to the
// next priority instead.
function tryParseLevel(
  raw: unknown,
  source: string,
  sink: ConsoleSink,
): LogLevel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    warnOnce(
      sink,
      `${source}:type:${typeof raw}`,
      `ignoring non-string ${source} of type ${typeof raw} (expected silent|error|warn|info|debug)`,
    );
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const v = trimmed.toLowerCase();
  if (isLogLevel(v)) return v;
  warnOnce(
    sink,
    `${source}:value:${trimmed}`,
    `ignoring invalid ${source}=${safeForLog(raw)} (expected silent|error|warn|info|debug)`,
  );
  return undefined;
}

export function resolveLogLevel(
  explicit?: LogLevel | string,
  sink: ConsoleSink = console,
): LogLevel {
  return (
    tryParseLevel(explicit, 'logLevel', sink) ??
    tryParseLevel(process.env[LOG_LEVEL_ENV], LOG_LEVEL_ENV, sink) ??
    'info'
  );
}

export function createLogger(
  level?: LogLevel | string,
  sink: ConsoleSink = console,
): Logger {
  const resolved = resolveLogLevel(level, sink);
  const threshold = LEVEL_RANK[resolved];
  const enabled = (l: LogLevel): boolean => threshold >= LEVEL_RANK[l];
  return {
    level: resolved,
    error: (...args) => {
      if (enabled('error')) sink.error(timestamp(), PREFIX, ...args);
    },
    warn: (...args) => {
      if (enabled('warn')) sink.warn(timestamp(), PREFIX, ...args);
    },
    info: (...args) => {
      if (enabled('info')) sink.log(timestamp(), PREFIX, ...args);
    },
    debug: (...args) => {
      if (enabled('debug')) sink.log(timestamp(), PREFIX, ...args);
    },
  };
}
