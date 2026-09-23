import type { Logger } from './logger.js';

export const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Reports whether cleanup finished; a timeout must not look like success. */
export async function runWithShutdownTimeout(
  shutdown: () => Promise<void>,
  logger: Logger,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      shutdown().then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          logger.warn(`runtime shutdown exceeded ${timeoutMs}ms; exiting with cleanup unconfirmed`);
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function shutdownAndReleasePidFile(
  shutdown: (() => Promise<void>) | undefined,
  logger: Logger,
  options: { timeoutMs?: number; removePidFile?: () => void } = {},
): Promise<boolean> {
  try {
    const completed = !shutdown || await runWithShutdownTimeout(shutdown, logger, options.timeoutMs);
    if (completed) options.removePidFile?.();
    return completed;
  } catch (error) {
    logger.error('shutdown error:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** All exit triggers share one bounded cleanup; fatal status cannot be downgraded. */
export function createDaemonShutdown(options: {
  stop: () => void;
  shutdown?: () => Promise<void>;
  logger: Logger;
  timeoutMs: number;
  removePidFile?: () => void;
  exit: (code: number) => void;
}): (fatal?: boolean) => Promise<void> {
  let pending: Promise<void> | undefined;
  let failed = false;
  return (fatal = false) => {
    failed ||= fatal;
    // Defer callbacks until pending is assigned, including synchronous re-entry
    // from stop(). Repeated signals join the same timeout-bounded operation.
    pending ??= Promise.resolve().then(async () => {
      try { options.stop(); }
      catch (error) {
        failed = true;
        options.logger.error('client stop error:', error instanceof Error ? error.message : String(error));
      }
      const completed = await shutdownAndReleasePidFile(options.shutdown, options.logger, {
        timeoutMs: options.timeoutMs,
        removePidFile: options.removePidFile,
      });
      options.exit(failed || !completed ? 1 : 0);
    });
    return pending;
  };
}
