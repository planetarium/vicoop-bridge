// Pure argv/env/config merging for the daemon entrypoint. Lives in its own
// module so tests can import it without triggering the side-effectful
// `main()` at the bottom of cli.ts.

import type { ClientConfig, BackendConfigs } from './config.js';

export interface ParsedFlags {
  server?: string;
  token?: string;
  agentId?: string;
  card?: string;
  backend?: string;
  config?: string;
}

export interface DaemonArgs {
  server: string;
  token: string;
  agentId: string;
  card?: string;
  backend: string;
  backends?: BackendConfigs;
}

const FLAG_NAMES = ['server', 'token', 'agentId', 'card', 'backend', 'config'] as const;
type FlagName = (typeof FLAG_NAMES)[number];

// Result discriminator: success carries the parsed flags; failure carries a
// short message naming the offending flag so cli.ts can surface a targeted
// error like "--config requires a path" instead of silently treating the
// next flag as a value (or `undefined` when --config was the last token).
export type ParseFlagsResult =
  | { ok: true; flags: ParsedFlags }
  | { ok: false; error: string };

export function parseFlags(argv: string[]): ParseFlagsResult {
  const out: ParsedFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const k = key.slice(2);
    if (!(FLAG_NAMES as readonly string[]).includes(k)) continue;
    const val = argv[i + 1];
    // Reject both "flag at end of argv" (val === undefined) and "flag
    // followed by another --flag" (val starts with --). Either case silently
    // consumed the next token as a value before this guard and produced
    // surprising behavior — particularly bad for --config where the daemon
    // would either run with the canonical config (val undefined) or load a
    // file path that's actually a flag name.
    if (val === undefined || val.startsWith('--')) {
      return { ok: false, error: `--${k} requires a value` };
    }
    out[k as FlagName] = val;
    i++;
  }
  return { ok: true, flags: out };
}

// Trim and treat whitespace-only as unset. Two reasons:
//   1. `||` (not `??`) so an empty `SERVER_TOKEN=` line from a
//      freshly-generated EnvironmentFile= template doesn't shadow a
//      populated config.json. The install.sh template ships these keys
//      with empty values for operators to fill in; treating "" as "not
//      set" lets the config value carry through until the operator
//      either populates env or removes the empty line.
//   2. Trim so a stray space-padded value (`SERVER_URL=" wss://x "` or
//      `--token " ... "`) doesn't surface as a "looks set but doesn't
//      connect" mystery. `normalizeConfig` already trims for the config
//      layer; doing the same here keeps env / CLI on the same footing.
function pick(v: string | undefined): string {
  return v?.trim() ?? '';
}

export function mergeClientArgs(
  flags: ParsedFlags,
  env: NodeJS.ProcessEnv,
  config: ClientConfig,
): { ok: true; args: DaemonArgs } | { ok: false; missing: string[] } {
  const card =
    pick(flags.card) || pick(env.AGENT_CARD) || config.card;
  const resolved: DaemonArgs = {
    server: pick(flags.server) || pick(env.SERVER_URL) || config.server_url || '',
    token: pick(flags.token) || pick(env.SERVER_TOKEN) || config.server_token || '',
    agentId: pick(flags.agentId) || pick(env.AGENT_ID) || config.agent_id || '',
    // `card` is optional; normalize "" back to undefined so callers don't
    // get a present-but-empty string they then have to filter.
    card: card === '' ? undefined : card,
    backend: pick(flags.backend) || pick(env.BACKEND) || config.backend || 'echo',
    backends: config.backends,
  };
  const missing: string[] = [];
  if (!resolved.server) missing.push('server');
  if (!resolved.token) missing.push('token');
  if (!resolved.agentId) missing.push('agentId');
  if (!resolved.backend) missing.push('backend');
  if (missing.length) return { ok: false, missing };
  return { ok: true, args: resolved };
}
