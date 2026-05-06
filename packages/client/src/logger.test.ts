import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetLogLevelWarningsForTests,
  type ConsoleSink,
  createLogger,
  isLogLevel,
  LOG_LEVEL_ENV,
  resolveLogLevel,
  safeToken,
} from './logger.js';

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
  sink: ConsoleSink;
}

// Capturing sink. Tests inject this instead of monkey-patching the global
// console so a parallel test file in the same process (or a future change
// to test-runner isolation) cannot interleave global mutations.
function makeSink(): Captured {
  const log: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const join = (args: unknown[]): string =>
    args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  return {
    log,
    warn,
    error,
    sink: {
      log: (...a: unknown[]) => log.push(join(a)),
      warn: (...a: unknown[]) => warn.push(join(a)),
      error: (...a: unknown[]) => error.push(join(a)),
    },
  };
}

// `process.env` is process-global; this helper restores the previous value
// in a `finally` so each test leaves the environment as it found it. The
// node:test runner isolates test files in separate processes by default,
// so a single test's env mutation cannot leak to another file.
function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('isLogLevel accepts the documented levels and rejects anything else', () => {
  for (const level of ['silent', 'error', 'warn', 'info', 'debug']) {
    assert.equal(isLogLevel(level), true, level);
  }
  for (const bad of ['', 'verbose', 'trace', 'INFO', 'log', 'fatal']) {
    assert.equal(isLogLevel(bad), false, bad);
  }
});

test('resolveLogLevel: explicit value wins over env and default', () => {
  withEnv(LOG_LEVEL_ENV, 'debug', () => {
    const c = makeSink();
    assert.equal(resolveLogLevel('warn', c.sink), 'warn');
    assert.deepEqual(c.warn, []);
  });
});

test('resolveLogLevel: env var is honored when no explicit value', () => {
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, 'debug', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'debug');
  });
  withEnv(LOG_LEVEL_ENV, 'SILENT', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'silent');
  });
  assert.deepEqual(c.warn, []);
});

test('resolveLogLevel: defaults to info when env is unset or empty', () => {
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, undefined, () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'info');
  });
  withEnv(LOG_LEVEL_ENV, '   ', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'info');
  });
  assert.deepEqual(c.warn, []);
});

test('resolveLogLevel: trims whitespace from env values', () => {
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, ' debug ', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'debug');
  });
  withEnv(LOG_LEVEL_ENV, '\tWarn\n', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'warn');
  });
  assert.deepEqual(c.warn, []);
});

test('resolveLogLevel: invalid env value falls back to info and warns once', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, 'verbose', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'info');
  });
  assert.equal(c.warn.length, 1);
  assert.match(c.warn[0], /ignoring invalid VICOOP_CLIENT_LOG_LEVEL="verbose"/);
});

test('resolveLogLevel: invalid explicit value warns then falls through to env', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, 'debug', () => {
    assert.equal(resolveLogLevel('TRACE' as 'debug', c.sink), 'debug');
  });
  assert.equal(c.warn.length, 1);
  assert.match(c.warn[0], /ignoring invalid logLevel="TRACE"/);
});

test('resolveLogLevel: invalid explicit value with no env falls back to info', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, undefined, () => {
    assert.equal(resolveLogLevel('verbose' as 'debug', c.sink), 'info');
  });
  assert.equal(c.warn.length, 1);
  assert.match(c.warn[0], /ignoring invalid logLevel="verbose"/);
});

test('resolveLogLevel: sanitizes newlines/control chars in invalid value (no log injection)', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, 'evil\n[client] FAKE INJECTED LINE', () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'info');
  });
  assert.equal(c.warn.length, 1);
  // Single line — newline must be escaped, not literal.
  assert.equal(c.warn[0].includes('\n'), false, 'warn message must not contain raw newlines');
  assert.match(c.warn[0], /\\n\[client\] FAKE INJECTED LINE/);
});

test('resolveLogLevel: truncates very long invalid values', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  const long = 'x'.repeat(500);
  withEnv(LOG_LEVEL_ENV, long, () => {
    assert.equal(resolveLogLevel(undefined, c.sink), 'info');
  });
  assert.equal(c.warn.length, 1);
  // Bounded length: prefix line + escaped+truncated value should be short.
  assert.ok(c.warn[0].length < 250, `warn line should be bounded, got ${c.warn[0].length} chars`);
  assert.match(c.warn[0], /…/);
});

test('resolveLogLevel: warns at most once per distinct invalid value across calls', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, 'fatal', () => {
    resolveLogLevel(undefined, c.sink);
    resolveLogLevel(undefined, c.sink);
    resolveLogLevel(undefined, c.sink);
  });
  assert.equal(c.warn.length, 1, 'same invalid value warns only once');
  // A different invalid value still warns (distinct dedup key).
  withEnv(LOG_LEVEL_ENV, 'panic', () => {
    resolveLogLevel(undefined, c.sink);
  });
  assert.equal(c.warn.length, 2, 'a distinct invalid value warns separately');
});

test('resolveLogLevel: warn passes PREFIX as a separate sink argument', () => {
  _resetLogLevelWarningsForTests();
  const calls: unknown[][] = [];
  const sink: ConsoleSink = {
    log: () => {},
    warn: (...args) => {
      calls.push(args);
    },
    error: () => {},
  };
  withEnv(LOG_LEVEL_ENV, 'bogus', () => {
    resolveLogLevel(undefined, sink);
  });
  assert.equal(calls.length, 1);
  // First arg is the prefix, second is the structured message — same shape
  // the logger's own .warn() uses, so structured-logging sinks can treat
  // them consistently.
  assert.equal(calls[0][0], '[client]');
  assert.match(String(calls[0][1]), /ignoring invalid VICOOP_CLIENT_LOG_LEVEL="bogus"/);
});

test('createLogger at info: error/warn/info pass, debug filtered', () => {
  const c = makeSink();
  const logger = createLogger('info', c.sink);
  logger.error('boom');
  logger.warn('careful');
  logger.info('hello');
  logger.debug('quiet');
  assert.deepEqual(c.error, ['[client] boom']);
  assert.deepEqual(c.warn, ['[client] careful']);
  assert.deepEqual(c.log, ['[client] hello']);
});

test('createLogger at debug: every level passes through', () => {
  const c = makeSink();
  const logger = createLogger('debug', c.sink);
  logger.error('e');
  logger.warn('w');
  logger.info('i');
  logger.debug('d');
  assert.deepEqual(c.error, ['[client] e']);
  assert.deepEqual(c.warn, ['[client] w']);
  assert.deepEqual(c.log, ['[client] i', '[client] d']);
});

test('createLogger at warn: info and debug filtered', () => {
  const c = makeSink();
  const logger = createLogger('warn', c.sink);
  logger.info('i');
  logger.debug('d');
  logger.warn('w');
  assert.deepEqual(c.log, []);
  assert.deepEqual(c.warn, ['[client] w']);
});

test('createLogger at silent: every level filtered', () => {
  const c = makeSink();
  const logger = createLogger('silent', c.sink);
  logger.error('e');
  logger.warn('w');
  logger.info('i');
  logger.debug('d');
  assert.deepEqual(c.error, []);
  assert.deepEqual(c.warn, []);
  assert.deepEqual(c.log, []);
});

test('safeToken: leaves plain ASCII tokens unchanged', () => {
  assert.equal(safeToken('abc-123_def'), 'abc-123_def');
  assert.equal(safeToken('text/plain'), 'text/plain');
  assert.equal(safeToken(''), '');
});

test('safeToken: escapes newlines / control chars so a token cannot inject log lines', () => {
  const escaped = safeToken('evil\n[client] FAKE');
  assert.equal(escaped.includes('\n'), false);
  assert.match(escaped, /^evil\\n\[client\] FAKE$/);
  // No surrounding quotes (those are reserved for safeForLog-style messages).
  assert.equal(escaped.startsWith('"'), false);
  assert.equal(escaped.endsWith('"'), false);
});

test('safeToken: escapes embedded quotes and backslashes', () => {
  assert.equal(safeToken('a"b'), 'a\\"b');
  assert.equal(safeToken('a\\b'), 'a\\\\b');
  assert.equal(safeToken('\t\r'), '\\t\\r');
});

test('safeToken: truncates very long tokens', () => {
  const long = 'a'.repeat(500);
  const out = safeToken(long, 50);
  assert.ok(out.length <= 50, `expected <=50, got ${out.length}`);
  assert.match(out, /…$/);
});

test('createLogger: trims an explicit level string', () => {
  const c = makeSink();
  const logger = createLogger(' DEBUG ', c.sink);
  assert.equal(logger.level, 'debug');
  assert.deepEqual(c.warn, []);
});

test('resolveLogLevel: non-string explicit value warns and falls through (does not crash)', () => {
  _resetLogLevelWarningsForTests();
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, undefined, () => {
    // JS caller bypasses the TS type and passes a number/object/etc.
    assert.equal(resolveLogLevel(123 as unknown as 'debug', c.sink), 'info');
    assert.equal(resolveLogLevel({} as unknown as 'debug', c.sink), 'info');
  });
  assert.equal(c.warn.length, 2);
  for (const line of c.warn) {
    assert.match(line, /ignoring non-string logLevel of type/);
  }
});

test('resolveLogLevel: null explicit value is treated as not provided', () => {
  const c = makeSink();
  withEnv(LOG_LEVEL_ENV, 'debug', () => {
    assert.equal(resolveLogLevel(null as unknown as 'debug', c.sink), 'debug');
  });
  assert.deepEqual(c.warn, []);
});
