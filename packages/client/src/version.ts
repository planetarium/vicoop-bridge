import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In the shipped bundle, this file compiles to $INSTALL_DIR/dist/version.js and
// package.json sits at $INSTALL_DIR/package.json. Resolving from import.meta.url
// gives us both the running version and the install root in one step, without
// any build-time codegen.
const here = dirname(fileURLToPath(import.meta.url));

export const installDir: string = dirname(here);

export const clientVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
