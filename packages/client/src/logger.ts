export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const PREFIX = '[client]';
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

// Normalize a level string from any source (explicit option, env var) by
// trimming and lowercasing, then validating against the known set. An
// invalid non-empty value is reported via `sink.warn` once and returns
// `undefined` so the caller can fall through to the next priority. We
// validate explicit values too — even though TS `LogLevel` constrains them
// for typed callers, a plain-JS consumer can still pass anything, and an
// unrecognized string would otherwise produce `LEVEL_RANK[v] === undefined`
// and silently disable every level.
function tryParseLevel(
  raw: string | undefined,
  source: string,
  sink: ConsoleSink,
): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const v = trimmed.toLowerCase();
  if (isLogLevel(v)) return v;
  sink.warn(
    `${PREFIX} ignoring invalid ${source}=${raw} (expected silent|error|warn|info|debug)`,
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
      if (enabled('error')) sink.error(PREFIX, ...args);
    },
    warn: (...args) => {
      if (enabled('warn')) sink.warn(PREFIX, ...args);
    },
    info: (...args) => {
      if (enabled('info')) sink.log(PREFIX, ...args);
    },
    debug: (...args) => {
      if (enabled('debug')) sink.log(PREFIX, ...args);
    },
  };
}
