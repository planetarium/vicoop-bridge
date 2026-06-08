// Canary for the @optique/core patch in `patches/@optique__core@1.0.2.patch`.
//
// The `auth` / `agent` / `container` umbrellas (and top-level `start` etc.)
// carry `hidden: 'usage'` so they stay OUT of the top-level `--help`
// synopsis — the grouped sections list them instead. Upstream optique's
// `formatUsage` strips every hidden command term unconditionally, which also
// dropped the umbrella prefix from each subcommand's OWN help, so
// `vicoop-client auth login --help` rendered `Usage: vicoop-client login …`
// — pointing operators at the deprecated flat form. Our patch makes
// `formatUsage` preserve leading command-path terms even when hidden.
//
// This lives in a pnpm `patchedDependencies` entry, NOT in our own source, so
// nothing in normal code review fails if the patch is removed or stops
// applying. If this test goes red, the patch is no longer in effect — check
// `patches/@optique__core@1.0.2.patch` and the `pnpm.patchedDependencies`
// block in package.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command } from '@optique/core/primitives';
import { group, longestMatch } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { getDocPageSync } from '@optique/core/parser';
import { formatUsage } from '@optique/core/usage';
import { authLoginCmd } from './login.js';

// Mirror cli.ts: the real `authLogin` command sits under a `hidden: 'usage'`
// umbrella, itself wrapped in a `group()` for the top-level help sections.
function authUmbrellaCli() {
  const authCmd = command('auth', longestMatch(authLoginCmd), {
    brief: message`Manage owner-session and identity.`,
    hidden: 'usage',
  });
  return longestMatch(group('Identity', authCmd));
}

function synopsis(args: string[]): string {
  const cli = authUmbrellaCli();
  const doc = getDocPageSync(cli, args);
  assert.ok(doc?.usage, `getDocPageSync returned no usage for [${args.join(' ')}]`);
  return formatUsage('vicoop-client', doc.usage, { expandCommands: true });
}

test("subcommand --help keeps the umbrella prefix in its synopsis (optique patch active)", () => {
  const line = synopsis(['auth', 'login']);
  // With the patch: `vicoop-client auth login …`.
  // Without it (upstream bug): `vicoop-client login …`, omitting `auth`.
  assert.match(
    line,
    /vicoop-client auth login\b/,
    `expected the synopsis to include the full \`auth login\` invocation path, got: ${line}`,
  );
});

test("the patch does not regress hidden: 'usage' suppression at the top level", () => {
  // The umbrella must still be absent from the top-level synopsis — the patch
  // only un-hides command-path terms on a command's OWN help page, not in the
  // parent listing.
  const line = synopsis([]);
  assert.ok(
    !/\bauth\b/.test(line),
    `top-level synopsis should not list the hidden \`auth\` umbrella, got: ${line}`,
  );
});
