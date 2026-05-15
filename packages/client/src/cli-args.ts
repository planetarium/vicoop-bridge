// Pure argv/env/config merging for the daemon entrypoint. Lives in its own
// module so tests can import it without triggering the side-effectful
// `main()` at the bottom of cli.ts.

import { object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { option } from '@optique/core/primitives';
import { choice, integer, string } from '@optique/core/valueparser';
import { parse } from '@optique/core/parser';
import { formatMessage } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import type { ClientConfig, BackendConfigs } from './config.js';

// Public bridge URL baked in so a fresh install on the public deployment
// needs zero flags. Self-hosters override via --server / config.json. The
// asymmetry (the bridge URL was the *only* required input that never varies
// across most installs) is item 6 of issue #189.
export const DEFAULT_BRIDGE_URL = 'wss://vicoop-bridge-server.fly.dev';

// HTTPS form of the same bridge, used by `login` (device-flow over HTTPS)
// and the `setup` / admin commands that talk to the bridge's REST + GraphQL
// surfaces. Kept in lock-step with `DEFAULT_BRIDGE_URL`; the scheme split
// is unavoidable because the daemon connects over WS while OAuth /
// /admin-api use HTTPS.
export const DEFAULT_BRIDGE_HTTPS_URL = 'https://vicoop-bridge-server.fly.dev';

const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof SANDBOX_MODES)[number];

const BACKEND_KINDS = ['echo', 'openclaw', 'claude', 'codex'] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

// Optique daemon-mode grammar. Every operator-tunable knob is a flag here,
// including the ones that used to be env-only (CLAUDE_CWD, CODEX_SANDBOX_MODE,
// OPENCLAW_*) — see issue #189 §1. `optional()` everywhere because env vars
// and config.json layers fill the gaps; the merge step below decides whether
// a field is actually missing.
export const daemonFlagsParser = object({
  server: optional(option('--server', string({ metavar: 'WS_URL' }))),
  token: optional(option('--token', string({ metavar: 'TOKEN' }))),
  agentId: optional(option('--agentId', string({ metavar: 'ID' }))),
  card: optional(option('--card', string({ metavar: 'PATH' }))),
  backend: optional(option('--backend', choice([...BACKEND_KINDS]))),
  config: optional(option('--config', string({ metavar: 'PATH' }))),
  // Promoted from env-only to first-class flags (issue #189 §1).
  claudeCwd: optional(option('--claude-cwd', string({ metavar: 'PATH' }))),
  claudeSettingsFile: optional(option('--claude-settings-file', string({ metavar: 'PATH' }))),
  codexCwd: optional(option('--codex-cwd', string({ metavar: 'PATH' }))),
  codexSandbox: optional(option('--codex-sandbox', choice([...SANDBOX_MODES]))),
  openclawGateway: optional(option('--openclaw-gateway', string({ metavar: 'WS_URL' }))),
  openclawGatewayToken: optional(option('--openclaw-gateway-token', string({ metavar: 'TOKEN' }))),
  openclawAgent: optional(option('--openclaw-agent', string({ metavar: 'NAME' }))),
  openclawOpenaiCompatAgent: optional(
    option('--openclaw-openai-compat-agent', string({ metavar: 'NAME' })),
  ),
  openclawTaskTimeoutMs: optional(
    option('--openclaw-task-timeout-ms', integer({ metavar: 'MS', min: 1 })),
  ),
});

export type DaemonFlags = InferValue<typeof daemonFlagsParser>;

export interface DaemonArgs {
  server: string;
  token: string;
  agentId: string;
  card?: string;
  backend: string;
  backends?: BackendConfigs;
  // Flag-derived overrides for env-only knobs. These take precedence over
  // env when set; merge logic in cli.ts threads them into backend factories.
  claudeCwd?: string;
  claudeSettingsFile?: string;
  codexCwd?: string;
  codexSandbox?: CodexSandboxMode;
  openclawGateway?: string;
  openclawGatewayToken?: string;
  openclawAgent?: string;
  openclawOpenaiCompatAgent?: string;
  openclawTaskTimeoutMs?: number;
}

export type ParseFlagsResult =
  | { ok: true; flags: DaemonFlags }
  | { ok: false; error: string };

// Thin wrapper around `parse()` from @optique/core. Surfaces structured
// errors (`{ ok: false, error }`) so the caller in cli.ts can print usage
// alongside the targeted message instead of leaning on optique's own
// process.exit path.
export function parseFlags(argv: string[]): ParseFlagsResult {
  const r = parse(daemonFlagsParser, argv);
  if (!r.success) {
    return { ok: false, error: formatMessage(r.error, { colors: false }) };
  }
  return { ok: true, flags: r.value };
}

// Trim and treat whitespace-only as unset.
//   1. `||` (not `??`) so an empty `SERVER_TOKEN=` line from a
//      freshly-generated EnvironmentFile= template doesn't shadow a
//      populated config.json. The install.sh template ships these keys
//      with empty values for operators to fill in.
//   2. Trim so a stray space-padded value (`SERVER_URL=" wss://x "` or
//      `--token " ... "`) doesn't surface as a "looks set but doesn't
//      connect" mystery.
function pick(v: string | undefined): string {
  return v?.trim() ?? '';
}

function pickSandbox(v: string | undefined): CodexSandboxMode | undefined {
  const t = v?.trim();
  if (!t) return undefined;
  return (SANDBOX_MODES as readonly string[]).includes(t)
    ? (t as CodexSandboxMode)
    : undefined;
}

// Final precedence (highest wins) — issue #189 §5 landed:
//   1. CLI flag values  (parsed by optique above)
//   2. `--config <path>` overlay  (caller pre-merged into `config`)
//   3. canonical config.json      (caller pre-merged into `config`)
//   4. built-in defaults (DEFAULT_BRIDGE_URL for server; 'echo' for backend)
//
// Env vars are NOT in this chain. Config-location env (VICOOP_HOME /
// XDG_CONFIG_HOME / HOME) is a separate category and resolved by
// `defaultConfigPath()` before this function runs. Admin-bootstrap env
// (VICOOP_BRIDGE / VICOOP_OWNER_TOKEN) is unrelated to the daemon runtime
// config and lives in owner-session.ts.
//
// `flags` is `Partial<DaemonFlags>` so tests can pass `{}` or `{ server }`
// shorthand. At runtime, `parseFlags()` returns the full shape — every key
// present with `undefined` for unset flags — but the merge logic reads each
// field independently and tolerates missing keys.
export function mergeClientArgs(
  flags: Partial<DaemonFlags>,
  config: ClientConfig,
): { ok: true; args: DaemonArgs } | { ok: false; missing: string[] } {
  const card = pick(flags.card) || config.card;
  const backends = config.backends ?? {};

  const resolved: DaemonArgs = {
    server: pick(flags.server) || config.server_url || DEFAULT_BRIDGE_URL,
    token: pick(flags.token) || config.server_token || '',
    agentId: pick(flags.agentId) || config.agent_id || '',
    card: card === '' ? undefined : card,
    backend: pick(flags.backend) || config.backend || 'echo',
    backends: config.backends,
    claudeCwd: pick(flags.claudeCwd) || backends.claude?.cwd || undefined,
    claudeSettingsFile: pick(flags.claudeSettingsFile) || undefined,
    codexCwd: pick(flags.codexCwd) || backends.codex?.cwd || undefined,
    codexSandbox:
      flags.codexSandbox ?? pickSandbox(backends.codex?.sandbox_mode),
    openclawGateway:
      pick(flags.openclawGateway) || backends.openclaw?.gateway_url || undefined,
    openclawGatewayToken:
      pick(flags.openclawGatewayToken) ||
      backends.openclaw?.gateway_token ||
      undefined,
    openclawAgent: pick(flags.openclawAgent) || backends.openclaw?.agent || undefined,
    openclawOpenaiCompatAgent:
      pick(flags.openclawOpenaiCompatAgent) ||
      backends.openclaw?.openai_compat_agent ||
      undefined,
    openclawTaskTimeoutMs:
      flags.openclawTaskTimeoutMs ?? backends.openclaw?.task_timeout_ms,
  };

  // Empty-string normalisation for the optional path-ish fields so callers
  // can `if (resolved.claudeCwd)` cleanly instead of having to filter "".
  if (resolved.claudeCwd === '') resolved.claudeCwd = undefined;
  if (resolved.claudeSettingsFile === '') resolved.claudeSettingsFile = undefined;
  if (resolved.codexCwd === '') resolved.codexCwd = undefined;
  if (resolved.openclawGateway === '') resolved.openclawGateway = undefined;
  if (resolved.openclawGatewayToken === '') resolved.openclawGatewayToken = undefined;
  if (resolved.openclawAgent === '') resolved.openclawAgent = undefined;
  if (resolved.openclawOpenaiCompatAgent === '') {
    resolved.openclawOpenaiCompatAgent = undefined;
  }

  const missing: string[] = [];
  if (!resolved.token) missing.push('token');
  if (!resolved.agentId) missing.push('agentId');
  // `server` always has DEFAULT_BRIDGE_URL fallback so it's never missing.
  // `backend` always has 'echo' fallback.
  if (missing.length) return { ok: false, missing };
  return { ok: true, args: resolved };
}
