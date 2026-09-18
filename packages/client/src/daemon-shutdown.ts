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
