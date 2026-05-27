// `vicoop-client logout` — invalidate the operator's owner-session bearer
// and clear the on-disk copy. Symmetric with `vicoop-client login`.
//
// Two distinct effects, both run by default:
//   1. Server-side revoke via POST /oauth/revoke (RFC 7009). Marks the
//      `callers` row revoked so the token can't be reused before its 90-day
//      TTL — relevant for credential-hygiene / suspected-leak scenarios.
//   2. Local file delete of ~/.vicoop/owner-session.json. Stops the admin
//      subcommands from picking it up.
//
// Flags split the two so operators can opt into one half:
//   --local-only   skip the server call (offline / bridge unreachable)
//   --keep-local   skip the file delete (revoke server-side, leave the
//                  file for inspection / debugging)
//
// The server call is best-effort: a non-200 reply prints a warning but
// still proceeds to delete the local file unless `--keep-local` is set.
// RFC 7009 §2.2 mandates 200 even for unknown tokens, so any non-200 here
// is either a network failure or a misconfigured bridge — in both cases
// the local file is the immediate hygiene win and we shouldn't block on
// the server.

import { existsSync, rmSync } from 'node:fs';
import { object } from '@optique/core/constructs';
import { withDefault } from '@optique/core/modifiers';
import { command, constant, flag } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import {
  defaultStorePath,
  loadOwnerSession,
} from './owner-session.js';

// Shared field shape for both the new `auth logout` and the legacy `logout`
// command. Adding a flag in one place automatically surfaces in the other.
const logoutFields = {
  localOnly: withDefault(
    flag('--local-only', {
      description: message`Skip the server-side revoke; just delete the local owner-session file.`,
    }),
    false,
  ),
  keepLocal: withDefault(
    flag('--keep-local', {
      description: message`Revoke server-side but leave ~/.vicoop/owner-session.json in place.`,
    }),
    false,
  ),
};

export const authLogoutCmd = command(
  'logout',
  object({
    action: constant('auth-logout' as const),
    ...logoutFields,
  }),
  {
    brief: message`Invalidate the owner-session bearer and clear the local copy.`,
    description: message`Calls the bridge's RFC 7009 /oauth/revoke endpoint with the stored owner-session bearer, then deletes ~/.vicoop/owner-session.json. Use --local-only when the bridge is unreachable, or --keep-local to revoke server-side without removing the file. A missing local session is reported but not an error.`,
  },
);

export type AuthLogoutArgs = InferValue<typeof authLogoutCmd>;

// Legacy flat `vicoop-client logout`. Kept as a deprecated alias.
export const logoutCmd = command(
  'logout',
  object({
    action: constant('logout' as const),
    ...logoutFields,
  }),
  {
    brief: message`[deprecated] Use \`auth logout\`.`,
    description: message`Deprecated alias for \`vicoop-client auth logout\`. Will be removed in a future release.`,
    hidden: 'help',
  },
);

export type LogoutArgs = InferValue<typeof logoutCmd>;

async function revokeOnServer(bridge: string, token: string): Promise<{ ok: boolean; detail: string }> {
  const body = new URLSearchParams({
    token,
    token_type_hint: 'access_token',
  });
  try {
    const res = await fetch(`${bridge.replace(/\/$/, '')}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

interface LogoutCommonArgs {
  localOnly: boolean;
  keepLocal: boolean;
}

export async function runAuthLogout(args: AuthLogoutArgs): Promise<number> {
  return executeLogout(args);
}

export async function runLogout(args: LogoutArgs): Promise<number> {
  process.stderr.write(
    '[warning] `vicoop-client logout` is deprecated; ' +
      'use `vicoop-client auth logout` instead. ' +
      'The deprecated form will be removed in a future release.\n',
  );
  return executeLogout(args);
}

async function executeLogout(args: LogoutCommonArgs): Promise<number> {
  const path = defaultStorePath();
  const session = loadOwnerSession(path);

  if (!session) {
    process.stderr.write(
      `No owner-session file at ${path}. Nothing to log out.\n` +
        '(If you logged in via VICOOP_OWNER_TOKEN env, unset it instead.)\n',
    );
    return 0;
  }

  if (!args.localOnly) {
    const result = await revokeOnServer(session.bridge, session.token);
    if (result.ok) {
      process.stderr.write(`Revoked owner-session on ${session.bridge}.\n`);
    } else {
      process.stderr.write(
        `Warning: server-side revoke failed (${result.detail}). ` +
          'The token will remain valid until it expires server-side.\n',
      );
    }
  }

  if (args.keepLocal) {
    process.stderr.write(`Left ${path} in place (--keep-local).\n`);
    return 0;
  }

  // existsSync check before rm: defaultStorePath() can theoretically race
  // with another process removing the file between loadOwnerSession() above
  // and here. `rmSync` with `force: true` would suppress ENOENT anyway, but
  // gating on existsSync keeps the message accurate.
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
  process.stderr.write(`Removed ${path}.\n`);
  return 0;
}
