// Persists and loads the operator's owner-session bearer token, used by the
// admin-management subcommands (add-caller / remove-caller / list-callers /
// list-agents) to authenticate against the bridge's /admin-api/* routes.
//
// Resolution order when the CLI needs a token:
//   1. VICOOP_OWNER_TOKEN env (paired with VICOOP_BRIDGE for the URL)
//   2. ~/.vicoop/owner-session.json written by `vicoop-client login --owner-session`
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
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  // is the file mode we set below.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Write to a temp sibling at mode 0o600, then rename. Rationale:
  //   * openSync's mode arg is only honoured on creation, so if `path` already
  //     exists with looser perms (e.g. a legacy save), opening it with 'w'
  //     would leave the old mode in place.
  //   * write-then-chmod creates a window where the file is world-readable
  //     under a permissive umask — exactly what the review flagged.
  // Writing fresh + atomic rename avoids both: the resulting file is always
  // mode 0o600 with no partial-write state visible on the canonical path.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(session, null, 2));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function loadOwnerSession(path: string = defaultStorePath()): OwnerSession | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as OwnerSession;
    if (!parsed.bridge || !parsed.token || !parsed.expires_at) return null;
    return parsed;
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
