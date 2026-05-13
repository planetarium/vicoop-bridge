// Atomic write that's safe on Windows. POSIX rename is overwrite-by-default,
// but Node's renameSync on win32 throws EEXIST/EPERM when the destination
// already exists, which would leave a re-saved bearer/config stranded in the
// temp file. We unlink the destination first on win32 (ignoring ENOENT for
// the first-save case). Lives in its own module so client.config and
// client.owner-session can both depend on it without a circular import.

import {
  closeSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

export function atomicWriteFile(path: string, contents: string, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }

  // From here on, every error path must clean up `tmp` so repeated
  // login / write-env-file attempts don't accumulate stray *.tmp files
  // on permission errors, locked files, etc.
  const cleanupAndThrow = (err: unknown): never => {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  };

  if (process.platform === 'win32') {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupAndThrow(err);
      }
    }
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    cleanupAndThrow(err);
  }
}
