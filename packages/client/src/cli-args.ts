// Pure argv/config merging for the daemon entrypoint. Lives in its own
// module so tests can import it without triggering the side-effectful
// `main()` at the bottom of cli.ts.

import { object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import { choice, integer, string } from '@optique/core/valueparser';
import { parse } from '@optique/core/parser';
import { formatMessage } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import type { ClientConfig, BackendConfigs, BackendRuntime } from './config.js';

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

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof SANDBOX_MODES)[number];

export const BACKEND_KINDS = ['echo', 'openclaw', 'claude', 'codex', 'vicoop-codex'] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

const BACKEND_RUNTIMES = ['host', 'container'] as const;

// Optique daemon-mode grammar. Every operator-tunable knob is a flag here,
// including the ones that used to be env-only (CLAUDE_CWD, CODEX_SANDBOX_MODE,
// OPENCLAW_*) — see issue #189 §1. `optional()` everywhere because the
// config.json layer fills the gaps; the merge step below decides whether
// a field is actually missing.
//
// Fields are exposed as a plain object literal so cli.ts can spread them
// into the top-level `or(command(…), daemonCmd)` parser without losing
// per-field types. `daemonFlagsParser` keeps the wrapped form for tests
// that call `parseFlags` directly.
//
// `group()` wrappers below give optique's help renderer section headers
// (Identity / Connection / Backend / Backend-specific Claude / Codex /
// OpenClaw) — issue #189 §3.
export const daemonFlagsFields = {
  // Identity
  token: optional(option('--token', string({ metavar: 'TOKEN' }), {
    description: message`Bridge client token (issued by \`vicoop-client setup\`; usually persisted in config.json).`,
  })),
  agentId: optional(option('--agentId', string({ metavar: 'ID' }), {
    description: message`Agent id (routing key external A2A callers use).`,
  })),

  // Connection
  server: optional(option('--server', string({ metavar: 'WS_URL' }), {
    description: message`Bridge WS URL. Defaults to ${DEFAULT_BRIDGE_URL}; set only when self-hosting.`,
  })),
  card: optional(option('--card', string({ metavar: 'PATH' }), {
    description: message`Agent card JSON override (defaults to the server-published card for the chosen backend).`,
  })),
  config: optional(option('--config', '-c', string({ metavar: 'PATH' }), {
    description: message`Explicit config.json overlaid on the canonical file.`,
  })),

  // Backend selection
  backend: optional(option('--backend', choice([...BACKEND_KINDS]), {
    description: message`Backend implementation. Default: \`echo\`.`,
  })),

  // Backend runtime placement (applies to the active --backend)
  cwd: optional(option('--cwd', string({ metavar: 'PATH' }), {
    description: message`Working directory for the spawned backend process. Only valid with \`--backend claude\` or \`--backend codex\`; pairing with another backend exits non-zero.`,
  })),
  runtime: optional(option('--runtime', choice([...BACKEND_RUNTIMES]), {
    description: message`Where to run the active backend. \`host\` (default) spawns on the bridge-client host; \`container\` runs inside an existing vicoop-runtime container created by \`vicoop-client container init <kind>\`. Only valid with \`--backend claude\` or \`--backend codex\`; pairing with another backend exits non-zero.`,
  })),
  runtimeName: optional(option('--runtime-name', string({ metavar: 'NAME' }), {
    description: message`Runtime container instance name to use with \`--runtime container\`. Omit to use the active backend kind as the generated name.`,
  })),

  // Backend-specific (Claude)
  claudeSettingsFile: optional(option('--claude-settings-file', string({ metavar: 'PATH' }), {
    description: message`Path to a JSON file used as Claude \`--settings\`.`,
  })),
  claudeModel: optional(option('--claude-model', string({ metavar: 'MODEL' }), {
    description: message`Model id for the spawned Claude, e.g. \`claude-opus-4-8\`. Sets the \`model\` field in Claude \`--settings\`; a per-request openai-compat \`model\` still overrides it. Only valid with \`--backend claude\`; pairing with another backend exits non-zero.`,
  })),
  claudeSupportedModels: optional(option('--claude-supported-models', string({ metavar: 'MODELS' }), {
    description: message`Comma-separated additional model ids this Claude install can serve, e.g. \`claude-sonnet-4-6,claude-haiku-4-5\`. Advertised alongside the default model and accepted as per-request openai-compat \`model\` overrides (Claude has no headless model listing, so the set is operator-declared and not validated against the account). Only valid with \`--backend claude\`; pairing with another backend exits non-zero.`,
  })),
  noClaudeReasoning: optional(
    flag('--no-claude-reasoning', {
      description: message`Disable forwarding Claude's extended-thinking on the openai-compat/v1 \`reasoning\` channel (on by default). Use when the deployed oai2a2a codec predates 0.6.0 and can't yet interpret the channel marker — otherwise the thinking would fold into the answer (planetarium/a2x-internal-router#95). Mirrors config \`backends.claude.reasoning: false\`.`,
    }),
  ),
  claudeThinkingBudget: optional(
    option('--claude-thinking-budget', integer({ metavar: 'TOKENS', min: 1 }), {
      description: message`Thinking budget in tokens, injected as \`MAX_THINKING_TOKENS\` on openai-compat spawns so Claude emits thinking on the wire (default 8000). Takes precedence over an operator's own \`MAX_THINKING_TOKENS\` export. Only valid with \`--backend claude\`. Mirrors config \`backends.claude.thinking_budget\`.`,
    }),
  ),

  // Backend-specific (Codex)
  codexSandbox: optional(option('--codex-sandbox', choice([...SANDBOX_MODES]), {
    description: message`Codex sandbox mode.`,
  })),

  // Backend-specific (OpenClaw)
  openclawGateway: optional(option('--openclaw-gateway', string({ metavar: 'WS_URL' }), {
    description: message`Gateway WS URL (default ws://127.0.0.1:18789).`,
  })),
  openclawGatewayToken: optional(option('--openclaw-gateway-token', string({ metavar: 'TOKEN' }), {
    description: message`Auth token if your gateway requires one.`,
  })),
  openclawAgent: optional(option('--openclaw-agent', string({ metavar: 'NAME' }), {
    description: message`Primary OpenClaw agent name. Default: \`main\`.`,
  })),
  openclawOpenaiCompatAgent: optional(
    option('--openclaw-openai-compat-agent', string({ metavar: 'NAME' }), {
      description: message`Secondary OpenClaw agent dedicated to openai-compat-extension tasks (gateway must define this agent with tools.deny=["*"]).`,
    }),
  ),
  openclawTaskTimeoutMs: optional(
    option('--openclaw-task-timeout-ms', integer({ metavar: 'MS', min: 1 }), {
      description: message`Per-task timeout in milliseconds.`,
    }),
  ),

  // Diagnostics
  openaiCompatTrace: optional(
    flag('--openai-compat-trace', {
      description: message`Dump A2A \`parts\` shape, metadata keys, and the raw \`chat_history\` array on every incoming task. Operator diagnostic for openai-compat wire issues — leave off in production.`,
    }),
  ),
};

export const daemonFlagsParser = object(daemonFlagsFields);

export type DaemonFlags = InferValue<typeof daemonFlagsParser>;

export interface DaemonArgs {
  server: string;
  token: string;
  agentId: string;
  card?: string;
  backend: string;
  backends?: BackendConfigs;
  // Flag-derived overrides. These take precedence over the config layer
  // when set; merge logic in cli.ts threads them into backend factories.
  // cwd / runtime apply to the active backend (claude / codex); the merge
  // step resolves the config fallback against `backends.<active>.{cwd,runtime}`.
  cwd?: string;
  runtime?: BackendRuntime;
  runtimeName?: string;
  claudeSettingsFile?: string;
  claudeModel?: string;
  claudeSupportedModels?: string[];
  // Resolved openai-compat/v1 reasoning channel toggle. Defaults ON; the
  // `--no-claude-reasoning` flag or `backends.claude.reasoning: false` flips it
  // off (#95 / #376). Always defined after `resolveDaemonArgs`.
  claudeReasoning?: boolean;
  // Resolved `MAX_THINKING_TOKENS` budget override (`--claude-thinking-budget`
  // / `backends.claude.thinking_budget`). Undefined keeps the backend's
  // env-or-default behaviour.
  claudeThinkingBudget?: number;
  codexSandbox?: CodexSandboxMode;
  openclawGateway?: string;
  openclawGatewayToken?: string;
  openclawAgent?: string;
  openclawOpenaiCompatAgent?: string;
  openclawTaskTimeoutMs?: number;
  openaiCompatTrace?: boolean;
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

// Comma-separated model list (--claude-supported-models). Trim entries, drop empties;
// undefined when nothing usable remains so the merge's `??` fallback to the
// config layer fires on a blank/whitespace-only flag, matching `pick()`'s
// empty-means-unset convention.
function pickModelsList(v: string | undefined): string[] | undefined {
  const entries = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? entries : undefined;
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
// Backends that actually consume the unified --cwd / --runtime flags. The
// other backends (echo / openclaw / vicoop-codex) don't spawn a per-task
// child process and don't have a vicoop-runtime container profile, so
// passing the flag with one of them is almost always an operator typo —
// surface it as a parse-time error rather than letting the value sit
// inert.
const CWD_BACKENDS: ReadonlySet<string> = new Set(['claude', 'codex']);
const RUNTIME_BACKENDS: ReadonlySet<string> = new Set(['claude', 'codex']);

export type MergeClientArgsResult =
  | { ok: true; args: DaemonArgs }
  | { ok: false; missing: string[]; errors: string[] };

export function mergeClientArgs(
  flags: Partial<DaemonFlags>,
  config: ClientConfig,
): MergeClientArgsResult {
  const card = pick(flags.card) || config.card;
  const backends = config.backends ?? {};
  const backend = pick(flags.backend) || config.backend || 'echo';

  // cwd / runtime are backend-agnostic at the flag level; the config-side
  // fallback comes from whichever backend is active, since `backends.claude`
  // and `backends.codex` carry independent `cwd` / `runtime` keys in config.
  const activeCwd =
    backend === 'claude' ? backends.claude?.cwd
    : backend === 'codex' ? backends.codex?.cwd
    : undefined;
  const activeRuntime =
    backend === 'claude' ? backends.claude?.runtime
    : backend === 'codex' ? backends.codex?.runtime
    : undefined;
  const activeRuntimeName =
    backend === 'claude' ? backends.claude?.runtime_name
    : backend === 'codex' ? backends.codex?.runtime_name
    : undefined;

  const resolved: DaemonArgs = {
    server: pick(flags.server) || config.server_url || DEFAULT_BRIDGE_URL,
    token: pick(flags.token) || config.server_token || '',
    agentId: pick(flags.agentId) || config.agent_id || '',
    card: card === '' ? undefined : card,
    backend,
    backends: config.backends,
    cwd: pick(flags.cwd) || activeCwd || undefined,
    runtime: flags.runtime ?? activeRuntime,
    runtimeName: pick(flags.runtimeName) || activeRuntimeName || undefined,
    claudeSettingsFile: pick(flags.claudeSettingsFile) || undefined,
    claudeModel: pick(flags.claudeModel) || backends.claude?.model || undefined,
    claudeSupportedModels:
      pickModelsList(flags.claudeSupportedModels) ??
      (backends.claude?.supported_models?.length ? backends.claude.supported_models : undefined),
    // ON unless the config opts out (`reasoning: false`) or the CLI flag forces
    // it off; the flag wins over config, matching the other flag>config knobs.
    claudeReasoning: backends.claude?.reasoning !== false && !flags.noClaudeReasoning,
    claudeThinkingBudget: flags.claudeThinkingBudget ?? backends.claude?.thinking_budget,
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
    openaiCompatTrace: flags.openaiCompatTrace || undefined,
  };

  // Empty-string normalisation for the optional path-ish fields so callers
  // can `if (resolved.cwd)` cleanly instead of having to filter "".
  if (resolved.cwd === '') resolved.cwd = undefined;
  if (resolved.claudeSettingsFile === '') resolved.claudeSettingsFile = undefined;
  if (resolved.claudeModel === '') resolved.claudeModel = undefined;
  if (resolved.openclawGateway === '') resolved.openclawGateway = undefined;
  if (resolved.openclawGatewayToken === '') resolved.openclawGatewayToken = undefined;
  if (resolved.openclawAgent === '') resolved.openclawAgent = undefined;
  if (resolved.runtimeName === '') resolved.runtimeName = undefined;
  if (resolved.openclawOpenaiCompatAgent === '') {
    resolved.openclawOpenaiCompatAgent = undefined;
  }

  const missing: string[] = [];
  if (!resolved.token) missing.push('token');
  if (!resolved.agentId) missing.push('agentId');
  // `server` always has DEFAULT_BRIDGE_URL fallback so it's never missing.
  // `backend` always has 'echo' fallback.

  // Backend-compat checks for the unified flags. We only flag the *flag*
  // (operator-set) variant; values that come purely from a stale config
  // overlay are silently dropped above by the active-backend-scoped
  // lookup, which is the correct behaviour for that source.
  const errors: string[] = [];
  if (flags.runtime !== undefined && !RUNTIME_BACKENDS.has(backend)) {
    errors.push(
      `--runtime is not supported by --backend ${backend}; only claude / codex have a runtime container profile`,
    );
  }
  if (pick(flags.runtimeName) && !RUNTIME_BACKENDS.has(backend)) {
    errors.push(
      `--runtime-name is not supported by --backend ${backend}; only claude / codex have a runtime container profile`,
    );
  }
  if (pick(flags.cwd) && !CWD_BACKENDS.has(backend)) {
    errors.push(
      `--cwd is not supported by --backend ${backend}; only claude / codex spawn a backend process with a working directory`,
    );
  }
  if (pick(flags.claudeModel) && backend !== 'claude') {
    errors.push(
      `--claude-model is not supported by --backend ${backend}; only the claude backend takes a model id`,
    );
  }
  if (pick(flags.claudeSupportedModels) && backend !== 'claude') {
    errors.push(
      `--claude-supported-models is not supported by --backend ${backend}; only the claude backend takes model ids`,
    );
  }
  if (flags.noClaudeReasoning && backend !== 'claude') {
    errors.push(
      `--no-claude-reasoning is not supported by --backend ${backend}; only the claude backend forwards a reasoning channel`,
    );
  }
  if (flags.claudeThinkingBudget !== undefined && backend !== 'claude') {
    errors.push(
      `--claude-thinking-budget is not supported by --backend ${backend}; only the claude backend takes a thinking budget`,
    );
  }

  if (missing.length || errors.length) return { ok: false, missing, errors };
  return { ok: true, args: resolved };
}
