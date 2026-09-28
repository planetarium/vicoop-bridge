import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseStorageRequest, prepareStoragePool, runStorageManager } from './caller-storage-manager.js';

// Compiled by Bun for the Linux helper image. No language runtime or provider
// credentials are installed in the final image; flock serializes all agents.
try {
  process.umask(0o077);
  const locked = process.argv[2] === '--locked';
  const args = process.argv.slice(locked ? 3 : 2);
  const request = parseStorageRequest(args);
  if (!locked) {
    const root = '/pool/managed';
    prepareStoragePool(root);
    const child = spawnSync('flock', ['--exclusive', join(root, 'lock'), process.execPath, '--locked', ...args], {
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } else {
    try {
      const result = await runStorageManager(request);
      if (result) console.log(JSON.stringify(result));
    } finally {
      // Keep the complete disposable probe under the same pool-wide flock.
      // Client-side intent still recovers SIGKILL/daemon disconnects.
      if (request.action === 'probe') await runStorageManager({ ...request, action: 'delete' });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
