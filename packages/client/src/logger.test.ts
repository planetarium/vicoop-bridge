import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, isLogLevel, LOG_LEVEL_ENV, resolveLogLevel } from './logger.js';

interface CapturedConsole {
  log: string[];
  warn: string[];
  error: string[];
  restore: () => void;
}

function captureConsole(): CapturedConsole {
  const captured: CapturedConsole = {
    log: [],
    warn: [],
    error: [],
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const join = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  console.log = (...args: unknown[]) => {
    captured.log.push(join(args));
  };
  console.warn = (...args: unknown[]) => {
    captured.warn.push(join(args));
  };
  console.error = (...args: unknown[]) => {
    captured.error.push(join(args));
  };
  return captured;
}

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
    assert.equal(resolveLogLevel('warn'), 'warn');
  });
});

test('resolveLogLevel: env var is honored when no explicit value', () => {
  withEnv(LOG_LEVEL_ENV, 'debug', () => {
    assert.equal(resolveLogLevel(), 'debug');
  });
  withEnv(LOG_LEVEL_ENV, 'SILENT', () => {
    assert.equal(resolveLogLevel(), 'silent');
  });
});

test('resolveLogLevel: defaults to info when env is unset', () => {
  withEnv(LOG_LEVEL_ENV, undefined, () => {
    assert.equal(resolveLogLevel(), 'info');
  });
});

test('resolveLogLevel: invalid env value falls back to info and warns once', () => {
  const captured = captureConsole();
  try {
    withEnv(LOG_LEVEL_ENV, 'verbose', () => {
      assert.equal(resolveLogLevel(), 'info');
    });
    assert.equal(captured.warn.length, 1);
    assert.match(captured.warn[0], /ignoring invalid VICOOP_CLIENT_LOG_LEVEL=verbose/);
  } finally {
    captured.restore();
  }
});

test('createLogger at info: error/warn/info pass, debug filtered', () => {
  const captured = captureConsole();
  try {
    const logger = createLogger('info');
    logger.error('boom');
    logger.warn('careful');
    logger.info('hello');
    logger.debug('quiet');
    assert.deepEqual(captured.error, ['[client] boom']);
    assert.deepEqual(captured.warn, ['[client] careful']);
    assert.deepEqual(captured.log, ['[client] hello']);
  } finally {
    captured.restore();
  }
});

test('createLogger at debug: every level passes through', () => {
  const captured = captureConsole();
  try {
    const logger = createLogger('debug');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    assert.deepEqual(captured.error, ['[client] e']);
    assert.deepEqual(captured.warn, ['[client] w']);
    assert.deepEqual(captured.log, ['[client] i', '[client] d']);
  } finally {
    captured.restore();
  }
});

test('createLogger at warn: info and debug filtered', () => {
  const captured = captureConsole();
  try {
    const logger = createLogger('warn');
    logger.info('i');
    logger.debug('d');
    logger.warn('w');
    assert.deepEqual(captured.log, []);
    assert.deepEqual(captured.warn, ['[client] w']);
  } finally {
    captured.restore();
  }
});

test('createLogger at silent: every level filtered', () => {
  const captured = captureConsole();
  try {
    const logger = createLogger('silent');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    assert.deepEqual(captured.error, []);
    assert.deepEqual(captured.warn, []);
    assert.deepEqual(captured.log, []);
  } finally {
    captured.restore();
  }
});
