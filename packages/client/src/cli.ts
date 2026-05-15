#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { AgentCard } from '@vicoop-bridge/protocol';
import { Client } from './client.js';
import { echoBackend } from './backends/echo.js';
import { createOpenclawBackend } from './backends/openclaw.js';
import { createClaudeBackend } from './backends/claude.js';
import {
  createCodexBackend,
  type ApprovalDecision,
} from './backends/codex.js';
import type { Backend } from './backend.js';
import { clientVersion } from './version.js';
import { runUpgrade } from './upgrade.js';
import { runLogin } from './login.js';
import { runSetup } from './setup.js';
import {
  runAddCaller,
  runListAgents,
  runListCallers,
  runListClients,
  runRemoveCaller,
  runRevokeClient,
} from './admin-cli.js';
import { runWhoami } from './whoami.js';
import { deriveIdentity } from './identity.js';
import {
  type ClientConfig,
  defaultConfigPath,
  overlayConfig,
  readConfig,
} from './config.js';
import {
  DEFAULT_BRIDGE_URL,
  mergeClientArgs,
  parseFlags,
  type DaemonArgs as Args,
} from './cli-args.js';
import { object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { parse as parseOptique } from '@optique/core/parser';
import { formatMessage } from '@optique/core/message';
import { string } from '@optique/core/valueparser';

const DAEMON_USAGE =
  'vicoop-client [--server <ws://...>] --token <t> --agentId <id>\n' +
  '              [--backend <echo|openclaw|claude|codex>] [--card <path>] [--config <path>]\n' +
  '              [--claude-cwd <path>] [--claude-settings-file <path>]\n' +
  '              [--codex-cwd <path>] [--codex-sandbox <read-only|workspace-write|danger-full-access>]\n' +
  '              [--openclaw-gateway <url>] [--openclaw-gateway-token <t>]\n' +
  '              [--openclaw-agent <name>] [--openclaw-openai-compat-agent <name>]\n' +
  '              [--openclaw-task-timeout-ms <ms>]\n' +
  `  --server defaults to ${DEFAULT_BRIDGE_URL} (public bridge); override for self-hosted bridges.`;
const SUBCOMMAND_LIST =
  'subcommands: login, setup, upgrade, list-agents, list-callers, add-caller, remove-caller, list-clients, revoke-client, whoami (run any with --help)';
const KNOWN_CODEX_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const);

type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

// Precedence (highest wins):
//   1. CLI flag values
//   2. env vars (kept for systemd EnvironmentFile= compatibility)
//   3. `--config <path>` file (overlaid on canonical, per field)
//   4. canonical config.json at the resolved vicoop dir
//   5. built-in defaults (DEFAULT_BRIDGE_URL for --server, 'echo' for --backend)
//
// Each layer is optional and contributes only the fields it sets, so
// operators can split state across them — e.g. systemd unit ships server_*
// via EnvironmentFile while backends.* lives in config.json.
function parseClientArgs(argv: string[]): Args {
  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(`usage: ${DAEMON_USAGE}`);
    process.exit(1);
  }
  const flags = parsed.flags;
  // Canonical config is always considered. An explicit `--config <path>` is
  // overlaid on top per field so missing keys (notably `backends.*`) fall
  // through from the canonical file instead of disappearing whenever the
  // operator points --config at a partial file.
  //
  // If the canonical file is on disk but readConfig returns null (malformed
  // JSON / not an object), warn loudly. The canonical config is optional
  // (systemd installs configure everything via EnvironmentFile=) so we
  // proceed with an empty config; if env / CLI fills the gap the daemon
  // still starts, but the operator sees the root cause if it doesn't,
  // instead of being misled by a generic "missing required args" later.
  const canonicalPath = defaultConfigPath();
  let canonical: ClientConfig = {};
  if (existsSync(canonicalPath)) {
    const loaded = readConfig(canonicalPath);
    if (loaded === null) {
      console.warn(
        `[client] ${canonicalPath} exists but is unreadable / not a JSON object; ` +
          'proceeding with env vars + CLI flags only — fix or move it aside to use the file.',
      );
    } else {
      canonical = loaded;
    }
  }
  let config: ClientConfig = canonical;
  if (flags.config) {
    const explicit = readConfig(flags.config);
    if (!explicit) {
      // The operator named a specific file; silently falling back to the
      // canonical config when it can't be read would let them think
      // they're using one config while actually using another.
      console.error(`--config ${flags.config}: file is missing, unreadable, or not a JSON object`);
      process.exit(1);
    }
    config = overlayConfig(canonical, explicit);
  }
  const result = mergeClientArgs(flags, process.env, config);
  if (!result.ok) {
    console.error(`missing required args: ${result.missing.join(', ')}`);
    console.error(`usage: ${DAEMON_USAGE}`);
    process.exit(1);
  }
  return result.args;
}

// Parse `CLAUDE_SETTINGS_JSON` (inline JSON env var) into a settings object.
// We fail loud on malformed JSON rather than silently dropping it — a syntax
// error in a sandbox config is exactly the kind of bug an operator wants
// surfaced at startup, not after the first task already ran with no sandbox
// at all. The flag equivalent is `--claude-settings-file <path>`, handled
// separately (reads from disk and JSON-parses there).
function parseClaudeSettingsEnv(raw: string | undefined): Record<string, unknown> | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`CLAUDE_SETTINGS_JSON is not valid JSON: ${msg}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('CLAUDE_SETTINGS_JSON must be a JSON object');
    process.exit(1);
  }
  return parsed as Record<string, unknown>;
}

// Read & JSON-parse a `--claude-settings-file <path>` flag value. Parse errors
// exit non-zero so an operator's typo doesn't silently fall through to the
// next layer with no sandbox.
function readClaudeSettingsFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`--claude-settings-file ${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`--claude-settings-file ${path}: not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`--claude-settings-file ${path}: must be a JSON object`);
    process.exit(1);
  }
  return parsed as Record<string, unknown>;
}

function isCodexSandboxMode(v: string | undefined): v is CodexSandboxMode {
  return v !== undefined && (KNOWN_CODEX_SANDBOX_MODES as Set<string>).has(v);
}

// Coerce a backends.codex.sandbox_mode coming from config.json. The runtime
// `--codex-sandbox` enum is already validated by optique at parse time, so
// this only filters the config-derived fallback. Bad enum values from
// config.json are dropped here rather than exiting the process — config is
// hand-edited and we prefer permissive recovery over a daemon that won't
// start because of a typo in an unrelated field.
function coerceCodexSandbox(
  args: Args,
  configSandbox: string | undefined,
): CodexSandboxMode | undefined {
  if (args.codexSandbox) return args.codexSandbox;
  if (isCodexSandboxMode(configSandbox)) return configSandbox;
  return undefined;
}

function pickBackend(name: string, args: Args): Backend {
  // All backend-specific knobs are now threaded through `args` (merged from
  // flag > env > config in mergeClientArgs). `pickBackend` just constructs
  // the right factory with those values; no env reads here.
  const backends = args.backends ?? {};
  switch (name) {
    case 'echo':
      return echoBackend;
    case 'openclaw': {
      // openclaw's persona / system prompt lives in the gateway-side config
      // (`/data/openclaw.json`), not in a per-message field on `chat.send`.
      // Self-identity is surfaced via `vicoop-client whoami` so operators
      // can paste it into their gateway persona; the bridge has no
      // wire-protocol hook to inject it from here.
      return createOpenclawBackend({
        url: args.openclawGateway ?? backends.openclaw?.gateway_url,
        token: args.openclawGatewayToken ?? backends.openclaw?.gateway_token,
        agent: args.openclawAgent ?? backends.openclaw?.agent,
        openaiCompatAgent:
          args.openclawOpenaiCompatAgent ?? backends.openclaw?.openai_compat_agent,
        taskTimeoutMs: args.openclawTaskTimeoutMs,
      });
    }
    case 'claude': {
      // settings precedence: --claude-settings-file (flag, path on disk) >
      // CLAUDE_SETTINGS_JSON (env, inline JSON) > backends.claude.settings
      // (config). The flag wins because operators reach for it explicitly;
      // the env form is the legacy install-script path.
      let settings: Record<string, unknown> | undefined;
      if (args.claudeSettingsFile) {
        settings = readClaudeSettingsFile(args.claudeSettingsFile);
      } else {
        settings =
          parseClaudeSettingsEnv(process.env.CLAUDE_SETTINGS_JSON) ??
          backends.claude?.settings;
      }
      return createClaudeBackend({
        cwd: args.claudeCwd,
        identity: deriveIdentity(args.agentId, args.server) ?? undefined,
        settings,
      });
    }
    case 'codex':
      return createCodexBackend({
        cwd: args.codexCwd,
        sandboxMode: coerceCodexSandbox(args, backends.codex?.sandbox_mode),
        approvalDecision: backends.codex?.approval_decision as ApprovalDecision | undefined,
      });
    default:
      throw new Error(
        `unknown backend: ${name} (supported: echo, openclaw, claude, codex)`,
      );
  }
}

function runClient(argv: string[]): void {
  const args = parseClientArgs(argv);
  const agentCard = args.card
    ? AgentCard.parse(JSON.parse(readFileSync(args.card, 'utf8')))
    : undefined;

  const client = new Client({
    serverUrl: args.server,
    token: args.token,
    agentId: args.agentId,
    agentCard,
    backendKind: args.backend,
    backend: pickBackend(args.backend, args),
    // Daemon entrypoint: a fatal terminal close (currently 4014 "client
    // revoked") should drop the process with a non-zero exit so
    // systemd / a parent supervisor sees the revocation as a hard
    // failure instead of masking it as a transient disconnect. The
    // Client class deliberately does not call process.exit itself —
    // tests and future in-process embedders pass a non-exiting callback.
    onFatal: () => process.exit(1),
  });

  client.start();

  const shutdown = () => {
    console.log('\n[client] shutting down');
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const upgradeParser = object({
  check: withDefault(flag('--check'), false),
  force: withDefault(flag('--force'), false),
  version: optional(option('--version', string({ metavar: 'X.Y.Z' }))),
});

async function runUpgradeCmd(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(
      'usage: vicoop-client upgrade [--check] [--force] [--version <X.Y.Z | vX.Y.Z | @vicoop-bridge/client@X.Y.Z>]',
    );
    return 0;
  }
  const r = parseOptique(upgradeParser, args);
  if (!r.success) {
    console.error(formatMessage(r.error, { colors: false }));
    return 1;
  }
  try {
    return await runUpgrade({
      check: r.value.check,
      force: r.value.force,
      version: r.value.version,
    });
  } catch (e) {
    console.error(`upgrade failed: ${(e as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Top-level --version / -v: print and exit before touching anything else.
  // Also used by the upgrade path's healthcheck on a freshly extracted bundle.
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${clientVersion}\n`);
    process.exit(0);
  }

  // Bare `help` is an explicit top-level help request. We defer `-h`/`--help`
  // until after subcommand routing so e.g. `vicoop-client login --help` lets
  // runLogin handle its own usage, and so a daemon invocation that includes
  // `--help` anywhere in argv (`--server ... --help`) still hits this path
  // instead of confusing parseClientArgs (which treats every `--key` as
  // taking a value).
  if (argv[0] === 'help') {
    process.stdout.write(`${SUBCOMMAND_LIST}\n`);
    process.stdout.write(`daemon mode: ${DAEMON_USAGE}\n`);
    process.exit(0);
  }

  if (argv[0] === 'upgrade') {
    process.exit(await runUpgradeCmd(argv.slice(1)));
  }

  if (argv[0] === 'login') {
    process.exit(await runLogin(argv.slice(1)));
  }

  if (argv[0] === 'setup') {
    process.exit(await runSetup(argv.slice(1)));
  }

  if (argv[0] === 'add-caller') {
    process.exit(await runAddCaller(argv.slice(1)));
  }

  if (argv[0] === 'remove-caller') {
    process.exit(await runRemoveCaller(argv.slice(1)));
  }

  if (argv[0] === 'list-callers') {
    process.exit(await runListCallers(argv.slice(1)));
  }

  if (argv[0] === 'list-agents') {
    process.exit(await runListAgents(argv.slice(1)));
  }

  if (argv[0] === 'list-clients') {
    process.exit(await runListClients(argv.slice(1)));
  }

  if (argv[0] === 'revoke-client') {
    process.exit(await runRevokeClient(argv.slice(1)));
  }

  if (argv[0] === 'whoami') {
    process.exit(await runWhoami(argv.slice(1)));
  }

  // A bare word (not a flag) here is an unrecognised subcommand. Catch it so
  // operators on an older bundle calling a newer subcommand get a clear
  // upgrade hint instead of a confusing "missing required args" from the
  // default client path. Also include the subcommand list and daemon usage
  // so plain typos still see actionable syntax guidance.
  if (argv[0] && !argv[0].startsWith('-')) {
    console.error(`unknown command: ${argv[0]}`);
    console.error(
      `this client (${clientVersion}) does not recognise that subcommand. ` +
        'It may be available in a newer release — run `vicoop-client upgrade --check`.',
    );
    console.error(SUBCOMMAND_LIST);
    console.error(`daemon mode: ${DAEMON_USAGE}`);
    process.exit(1);
  }

  // Daemon-mode help: `--help`/`-h` anywhere in argv prints usage. parseClientArgs
  // would otherwise consume the next token (e.g. `--token`) as `--help`'s value
  // and surface a confusing "missing required args" error.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${SUBCOMMAND_LIST}\n`);
    process.stdout.write(`daemon mode: ${DAEMON_USAGE}\n`);
    process.exit(0);
  }

  // Default path: long-running daemon. Do not exit — client.start() keeps the
  // event loop alive and signal handlers will call process.exit on shutdown.
  runClient(argv);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
