import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

// `clientVersion` is captured at build time. Under tsc the import resolves to
// $INSTALL_DIR/package.json at runtime; under `bun build --compile` the JSON
// is inlined into the single-file binary, so the version survives even
// though there's no package.json on disk.
export const clientVersion: string = pkg.version;

// In a tgz install this file lands at $INSTALL_DIR/dist/version.js, so the
// install root is two dirnames up from import.meta.url. In a Bun single-file
// build import.meta.url points at the embedded virtual fs (file:///$bunfs/…),
// which isn't a real path — fall back to the binary's own location, which is
// where install.sh places it.
const metaPath = fileURLToPath(import.meta.url);
export const installDir: string = metaPath.startsWith('/$bunfs/')
  ? dirname(process.execPath)
  : dirname(dirname(metaPath));
