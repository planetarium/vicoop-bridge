#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { AgentCard } from '@vicoop-bridge/protocol';
import { longestMatch, object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import { Client } from './client.js';
import { echoBackend } from './backends/echo.js';
import { createOpenclawBackend } from './backends/openclaw.js';
import { createClaudeBackend } from './backends/claude.js';
import {
  createCodexBackend,
  type ApprovalDecision,
} from './backends/codex.js';
import { createVicoopCodexBackend } from './backends/vicoop-codex.js';
import type { Backend } from './backend.js';
import { clientVersion } from './version.js';
import { runUpgrade } from './upgrade.js';
import { BACKENDS_MANIFEST } from './backends-manifest.js';
import { authLoginCmd, loginCmd, runAuthLogin, runLogin } from './login.js';
import { authLogoutCmd, logoutCmd, runAuthLogout, runLogout } from './logout.js';
import { setupCmd, runAgentRegister, runSetup } from './setup.js';
import {
  addCallerCmd, agentCmd, listAgentsCmd, listCallersCmd, listClientsCmd,
  removeCallerCmd, revokeClientCmd,
  runAddCaller, runAgentCallersAdd, runAgentCallersList, runAgentCallersRemove,
  runAgentList, runAgentRevoke, runListAgents, runListCallers, runListClients,
  runRemoveCaller, runRevokeClient,
} from './admin-cli.js';
import { authWhoamiCmd, whoamiCmd, runAuthWhoami, runWhoami } from './whoami.js';
import { deriveIdentity } from './identity.js';
import {
  type ClientConfig,
  defaultConfigPath,
  overlayConfig,
  readConfig,
} from './config.js';
import {
  DEFAULT_BRIDGE_URL,
  daemonFlagsFields,
  mergeClientArgs,
  type DaemonArgs as Args,
} from './cli-args.js';

const KNOWN_CODEX_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const);

type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

// `upgrade` runs through the same optique parser as the other subcommands.
// Defined here (rather than in upgrade.ts) so the file boundary stays:
// upgrade.ts is the IO-heavy bundle-swap implementation; cli.ts owns the
// argv-to-action wiring.
const upgradeCmd = command(
  'upgrade',
  object({
    action: constant('upgrade' as const),
    check: withDefault(flag('--check', {
      description: message`Report whether a newer release is available; don't actually upgrade.`,
    }), false),
    force: withDefault(flag('--force', {
      description: message`Reinstall the resolved target even if already on that version.`,
    }), false),
    version: optional(option('--version', string({ metavar: 'X.Y.Z' }), {
      description: message`Pin a specific version. Accepts \`X.Y.Z\`, \`vX.Y.Z\`, or \`@vicoop-bridge/client@X.Y.Z\`.`,
    })),
  }),
  {
    brief: message`Upgrade the installed client bundle in place.`,
    description: message`Downloads the latest \`@vicoop-bridge/client@*\` release (or the pinned --version), verifies its sha256, extracts into a sibling directory, healthchecks, and atomically swaps it into place. Operator-added cards / files under \$INSTALL_DIR are preserved across the swap; \`~/.vicoop/config.json\` and \`~/.vicoop/owner-session.json\` are never touched.`,
  },
);

// Read-only self-introspection. Bundles the client's semver, the container
// image semver (when running inside the image), and the backend compat
// manifest. Primarily consumed by the image's entrypoint to decide whether
// /data/installed.json is still compatible after an image bump; also useful
// for `docker exec ... vicoop-client info` troubleshooting.
const infoCmd = command(
  'info',
  object({
    action: constant('info' as const),
  }),
  {
    brief: message`Print client / image / backend metadata as JSON.`,
    description: message`Emits a single JSON object with this client's version, the container image's version (if running inside one — \`VICOOP_BRIDGE_IMAGE\` env), and the backend compat manifest. Bare-metal operators rarely need this; the image entrypoint shells out to it.`,
  },
);

// Daemon mode is the bare invocation (no subcommand). `constant('daemon')`
// gives the dispatch switch a discriminator alongside the named commands.
// `daemonFlagsFields` is the raw parser-field map exported from cli-args.ts
// so we can splice it in here without losing per-field types.
const daemonCmd = object({
  action: constant('daemon' as const),
  ...daemonFlagsFields,
});

// All subcommands + the bare daemon-mode parser in one parser. We use
// `longestMatch` (not `or`) so that bare invocation — `vicoop-client` with
// no tokens — falls through to `daemonCmd`, which consumes zero tokens
// successfully via all-optional fields. `or()` requires at least one
// branch to consume something, so it would reject empty argv even though
// daemonCmd structurally matches. With longestMatch, subcommand branches
// win whenever their keyword is present (longer match), and daemonCmd
// wins otherwise.
// Owner-session umbrella. Mirrors the `agent` umbrella from #218: both new
// subcommands sit under their topic, the flat versions stay as deprecated
// aliases.
const authCmd = command(
  'auth',
  longestMatch(authLoginCmd, authLogoutCmd, authWhoamiCmd),
  {
    brief: message`Manage owner-session and identity (sign in / out / whoami).`,
    description: message`Operator-facing umbrella for owner-session and agent-identity. Subcommands: \`login\`, \`logout\`, \`whoami\`. Replaces the older flat \`login\` / \`logout\` / \`whoami\` commands, which remain as deprecated aliases.`,
  },
);

const cli = longestMatch(
  authCmd,
  loginCmd,
  logoutCmd,
  setupCmd,
  upgradeCmd,
  infoCmd,
  agentCmd,
  addCallerCmd,
  removeCallerCmd,
  listCallersCmd,
  listAgentsCmd,
  listClientsCmd,
  revokeClientCmd,
  whoamiCmd,
  daemonCmd,
);

type CliArgs = InferValue<typeof cli>;

// Precedence (highest wins) — issue #189 §5 landed: no env layer.
//   1. CLI flag values
//   2. `--config <path>` file (overlaid on canonical, per field)
//   3. canonical config.json at the resolved vicoop dir
//   4. built-in defaults (DEFAULT_BRIDGE_URL for --server, 'echo' for --backend)
//
// Env vars are not consulted for runtime config. The only env still
// honoured by the client touches config *location* (VICOOP_HOME /
// XDG_CONFIG_HOME / HOME), admin-bootstrap (VICOOP_BRIDGE /
// VICOOP_OWNER_TOKEN, owner-session only), and diagnostics
// (VICOOP_CLIENT_LOG_LEVEL).
function resolveDaemonArgs(parsed: Extract<CliArgs, { action: 'daemon' }>): Args {
  const canonicalPath = defaultConfigPath();
  let canonical: ClientConfig = {};
  if (existsSync(canonicalPath)) {
    const loaded = readConfig(canonicalPath);
    if (loaded === null) {
      console.warn(
        `[client] ${canonicalPath} exists but is unreadable / not a JSON object; ` +
          'proceeding with CLI flags only — fix or move it aside to use the file.',
      );
    } else {
      canonical = loaded;
    }
  }
  let config: ClientConfig = canonical;
  if (parsed.config) {
    const explicit = readConfig(parsed.config);
    if (!explicit) {
      // The operator named a specific file; silently falling back to the
      // canonical config when it can't be read would let them think
      // they're using one config while actually using another.
      console.error(`--config ${parsed.config}: file is missing, unreadable, or not a JSON object`);
      process.exit(1);
    }
    config = overlayConfig(canonical, explicit);
  }
  const result = mergeClientArgs(parsed, config);
  if (!result.ok) {
    console.error(`missing required args: ${result.missing.join(', ')}`);
    process.exit(1);
  }
  return result.args;
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
  // flag + config in mergeClientArgs). `pickBackend` just constructs
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
      // backends.claude.settings (config). No env layer (#189 §5).
      const settings = args.claudeSettingsFile
        ? readClaudeSettingsFile(args.claudeSettingsFile)
        : backends.claude?.settings;
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
    case 'vicoop-codex':
      return createVicoopCodexBackend();
    default:
      throw new Error(
        `unknown backend: ${name} (supported: echo, openclaw, claude, codex, vicoop-codex)`,
      );
  }
}

function runDaemon(parsed: Extract<CliArgs, { action: 'daemon' }>): void {
  const args = resolveDaemonArgs(parsed);
  const agentCard = args.card
    ? AgentCard.parse(JSON.parse(readFileSync(args.card, 'utf8')))
    : undefined;

  // Emit the resolved backend at startup so operators can verify which
  // backend the precedence chain picked (flag vs. config vs. default
  // 'echo'). Without this the only signal is downstream behavior —
  // operators reading boot logs to diagnose "wrong backend ran" can't
  // tell whether parsing landed where they expected.
  console.log(`[client] backend: ${args.backend}`);

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

async function runUpgradeCmd(args: Extract<CliArgs, { action: 'upgrade' }>): Promise<number> {
  try {
    return await runUpgrade({
      check: args.check,
      force: args.force,
      version: args.version,
    });
  } catch (e) {
    console.error(`upgrade failed: ${(e as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  // Optique handles --help, --version, parse errors, and "did you mean?"
  // suggestions inside `run()`. Anything that reaches the switch is a
  // successfully-parsed subcommand or daemon-mode payload.
  const parsed = run(cli, {
    programName: 'vicoop-client',
    brief: message`A2A bridge client daemon. Connects a local backend (echo, openclaw, claude, codex) to a deployed vicoop-bridge server.`,
    footer: message`Precedence: CLI flag > --config <path> > canonical config.json > built-in default. Env vars are not consulted for runtime config (config-location vars like VICOOP_HOME / XDG_CONFIG_HOME / HOME are honored separately). See docs/install-client.md for the full operator guide.`,
    // Both `--help`/`-h` and the `help` subcommand. The explicit `names`
    // list enables the `-h` short alias optique doesn't register by
    // default. Same for `--version`/`-v`.
    help: {
      command: true,
      option: { names: ['--help', '-h'] },
    },
    version: {
      value: clientVersion,
      option: { names: ['--version', '-v'] },
    },
    aboveError: 'usage',
  });

  switch (parsed.action) {
    case 'auth-login':
      process.exit(await runAuthLogin(parsed));
      break;
    case 'auth-logout':
      process.exit(await runAuthLogout(parsed));
      break;
    case 'auth-whoami':
      process.exit(await runAuthWhoami(parsed));
      break;
    case 'login':
      process.exit(await runLogin(parsed));
      break;
    case 'logout':
      process.exit(await runLogout(parsed));
      break;
    case 'setup':
      process.exit(await runSetup(parsed));
      break;
    case 'upgrade':
      process.exit(await runUpgradeCmd(parsed));
      break;
    case 'info': {
      const imageVersion = process.env.VICOOP_BRIDGE_IMAGE;
      const payload = {
        version: clientVersion,
        ...(imageVersion ? { imageVersion } : {}),
        backends: BACKENDS_MANIFEST,
      };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exit(0);
      break;
    }
    case 'agent-register':
      process.exit(await runAgentRegister(parsed));
      break;
    case 'agent-list':
      process.exit(await runAgentList(parsed));
      break;
    case 'agent-revoke':
      process.exit(await runAgentRevoke(parsed));
      break;
    case 'agent-callers-list':
      process.exit(await runAgentCallersList(parsed));
      break;
    case 'agent-callers-add':
      process.exit(await runAgentCallersAdd(parsed));
      break;
    case 'agent-callers-remove':
      process.exit(await runAgentCallersRemove(parsed));
      break;
    case 'add-caller':
      process.exit(await runAddCaller(parsed));
      break;
    case 'remove-caller':
      process.exit(await runRemoveCaller(parsed));
      break;
    case 'list-callers':
      process.exit(await runListCallers(parsed));
      break;
    case 'list-agents':
      process.exit(await runListAgents(parsed));
      break;
    case 'list-clients':
      process.exit(await runListClients(parsed));
      break;
    case 'revoke-client':
      process.exit(await runRevokeClient(parsed));
      break;
    case 'whoami':
      process.exit(await runWhoami(parsed));
      break;
    case 'daemon':
      // Long-running. Do not exit — client.start() keeps the event loop
      // alive and signal handlers will call process.exit on shutdown.
      runDaemon(parsed);
      break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
