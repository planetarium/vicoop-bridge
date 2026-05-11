// Persists and loads the operator's owner-session bearer token, used by the
// admin-management subcommands (add-caller / remove-caller / list-callers /
// list-agents) to authenticate against the bridge's /admin-api/* routes.
//
// Resolution order when the CLI needs a token:
//   1. VICOOP_OWNER_TOKEN env (paired with VICOOP_BRIDGE for the URL)
//   2. ~/.vicoop/owner-session.json written by `vicoop-client login`
//
// Storage is a single JSON file (chmod 600) rather than a credential keychain
// because the rest of the client already keeps its bearer in plain env files
// and we want feature-parity. Tokens are short-ish (default 90 days) and the
// CLI re-prompts via login when expired.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Atomic write that's safe on Windows. POSIX rename is overwrite-by-default,
// but Node's renameSync on win32 throws EEXIST/EPERM when the destination
// already exists, which would leave a re-saved token stranded in the temp
// file. We unlink the destination first on win32 (ignoring ENOENT for the
// first-save case). Exported so other client modules — currently login.ts's
// writeEnvFile — can share the same write semantics.
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

export interface OwnerSession {
  bridge: string;
  token: string;
  principal_id?: string;
  email?: string | null;
  expires_at: string;        // ISO 8601
  saved_at: string;          // ISO 8601
}

export function defaultStorePath(): string {
  // ~/.vicoop/ keeps the file colocated with future client state; an XDG
  // state-dir layout would be more correct on Linux but cross-platform
  // parity (macOS/Linux/WSL) is more useful here than strict XDG.
  return join(homedir(), '.vicoop', 'owner-session.json');
}

export function saveOwnerSession(session: OwnerSession, path: string = defaultStorePath()): void {
  const dir = dirname(path);
  // mkdirSync's `mode` only applies to directories actually created here;
  // pre-existing dirs keep their permissions. The bearer's defence-in-depth
  // is the file mode atomicWriteFile sets below.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Write to a temp sibling at mode 0o600, then rename atomically. Rationale:
  //   * openSync's mode arg is only honoured on creation, so opening an
  //     existing path with 'w' would keep the old (possibly looser) mode.
  //   * write-then-chmod leaves a window where the file is world-readable
  //     under a permissive umask.
  // Writing fresh + atomic rename avoids both: the resulting file is always
  // mode 0o600 with no partial-write state visible on the canonical path.
  // atomicWriteFile also handles Windows' non-overwriting rename so a
  // second `login` invocation replaces the file cleanly.
  atomicWriteFile(path, JSON.stringify(session, null, 2), 0o600);
}

// Strict shape check: a tampered or hand-edited file with non-string fields
// would otherwise crash later in resolveOwnerSession's `.replace()` call.
// Required fields (bridge / token / expires_at / saved_at per OwnerSession)
// are enforced as non-empty strings so the guard matches the interface and
// loadOwnerSession's return type is honest. Truly optional fields
// (principal_id, email) are checked only when present; `email` may be null
// per the persisted shape.
function isOwnerSession(value: unknown): value is OwnerSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.bridge !== 'string' || !v.bridge) return false;
  if (typeof v.token !== 'string' || !v.token) return false;
  if (typeof v.expires_at !== 'string' || !v.expires_at) return false;
  if (typeof v.saved_at !== 'string' || !v.saved_at) return false;
  if ('principal_id' in v && v.principal_id !== undefined && typeof v.principal_id !== 'string') return false;
  if ('email' in v && v.email !== null && v.email !== undefined && typeof v.email !== 'string') return false;
  return true;
}

export function loadOwnerSession(path: string = defaultStorePath()): OwnerSession | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return isOwnerSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ResolvedSession {
  bridge: string;
  token: string;
  source: 'env' | 'file';
}

// Returns the token + bridge URL the CLI should use, with env taking
// precedence over the persisted file (matches the pattern parseClientArgs
// uses for SERVER_TOKEN etc).
export function resolveOwnerSession(path?: string): ResolvedSession | null {
  const envToken = process.env.VICOOP_OWNER_TOKEN;
  const envBridge = process.env.VICOOP_BRIDGE;
  if (envToken && envBridge) {
    return { bridge: envBridge.replace(/\/$/, ''), token: envToken, source: 'env' };
  }
  const file = loadOwnerSession(path);
  if (file && new Date(file.expires_at).getTime() > Date.now()) {
    return { bridge: file.bridge.replace(/\/$/, ''), token: file.token, source: 'file' };
  }
  return null;
}
