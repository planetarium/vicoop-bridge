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

export function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

export function resolveLogLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  const raw = process.env[LOG_LEVEL_ENV];
  if (!raw) return 'info';
  const v = raw.toLowerCase();
  if (isLogLevel(v)) return v;
  // The env var came from the operator; surface the misconfiguration once at
  // logger creation rather than silently falling back, so an unexpected level
  // string ("verbose", "trace") doesn't quietly degrade observability.
  console.warn(
    `${PREFIX} ignoring invalid ${LOG_LEVEL_ENV}=${raw} (expected silent|error|warn|info|debug)`,
  );
  return 'info';
}

export function createLogger(level?: LogLevel): Logger {
  const resolved = resolveLogLevel(level);
  const threshold = LEVEL_RANK[resolved];
  const enabled = (l: LogLevel): boolean => threshold >= LEVEL_RANK[l];
  return {
    level: resolved,
    error: (...args) => {
      if (enabled('error')) console.error(PREFIX, ...args);
    },
    warn: (...args) => {
      if (enabled('warn')) console.warn(PREFIX, ...args);
    },
    info: (...args) => {
      if (enabled('info')) console.log(PREFIX, ...args);
    },
    debug: (...args) => {
      if (enabled('debug')) console.log(PREFIX, ...args);
    },
  };
}
