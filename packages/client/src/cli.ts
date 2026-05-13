#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { AgentCard } from '@vicoop-bridge/protocol';
import { Client } from './client.js';
import { echoBackend } from './backends/echo.js';
import { createOpenclawBackend } from './backends/openclaw.js';
import { createClaudeBackend } from './backends/claude.js';
import { createCodexBackend, type CodexSandboxMode } from './backends/codex.js';
import type { Backend } from './backend.js';
import { clientVersion } from './version.js';
import { runUpgrade } from './upgrade.js';
import { runLogin } from './login.js';
import { runSetup } from './setup.js';
import {
  runAddCaller,
  runListAgents,
  runListCallers,
  runRemoveCaller,
} from './admin-cli.js';
import { runWhoami } from './whoami.js';
import { deriveIdentity } from './identity.js';
import {
  type ClientConfig,
  defaultConfigPath,
  overlayConfig,
  readConfig,
} from './config.js';
import { mergeClientArgs, parseFlags, type DaemonArgs as Args } from './cli-args.js';

const DAEMON_USAGE =
  'vicoop-client --server <ws://...> --token <t> --agentId <id> --backend <echo|openclaw|claude|codex> [--card <path>] [--config <path>]';
const SUBCOMMAND_LIST =
  'subcommands: login, setup, upgrade, list-agents, list-callers, add-caller, remove-caller, whoami (run any with --help)';
const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

// Precedence (highest wins):
//   1. CLI flag values
//   2. env vars (kept for systemd EnvironmentFile= compatibility)
//   3. `--config <path>` file (overlaid on canonical, per field)
//   4. canonical config.json at the resolved vicoop dir
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
  const canonical = readConfig(defaultConfigPath()) ?? {};
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

// Parse the operator's inline `--settings` JSON for the claude backend. The
// primary use case is enabling the OS-level sandbox in `-p` mode (issue #138),
// where the `/sandbox` slash command is unavailable and `settings.json` on
// disk is awkward on systemd-`DynamicUser` hosts. We fail loud on malformed
// JSON rather than silently dropping it — a syntax error in a sandbox config
// is exactly the kind of bug an operator wants surfaced at startup, not
// after the first task already ran with no sandbox at all.
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

function parseCodexSandboxMode(raw: string | undefined): CodexSandboxMode | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (CODEX_SANDBOX_MODES.has(trimmed as CodexSandboxMode)) {
    return trimmed as CodexSandboxMode;
  }
  console.error(
    `CODEX_SANDBOX_MODE must be one of: ${Array.from(CODEX_SANDBOX_MODES).join(', ')} (got ${JSON.stringify(trimmed)})`,
  );
  process.exit(1);
}

function pickBackend(name: string, args: Args): Backend {
  // Env wins over config.json for backend defaults, mirroring the daemon-level
  // precedence above. The backend factories already do `opts ?? default`
  // internally, so passing the merged value here is enough.
  const backends = args.backends ?? {};
  switch (name) {
    case 'echo':
      return echoBackend;
    case 'openclaw': {
      // openclaw's persona / system prompt lives in the gateway-side config
      // (`/data/openclaw.json`), not in a per-message field on `chat.send`.
      // Self-identity is surfaced via `vicoop-client whoami` so operators can
      // paste it into their gateway persona; the bridge has no wire-protocol
      // hook to inject it from here.
      //
      // Trim + treat-empty-as-unset across the board: install.sh's env
      // template ships these keys with empty values for operators to fill in,
      // and `??` would let those empty strings shadow a populated config.json.
      // `?.trim() ||` mirrors the daemon-level precedence (env wins when set,
      // falls through to config when blank/unset).
      const oc = backends.openclaw;
      const envTimeout = process.env.OPENCLAW_TASK_TIMEOUT_MS?.trim();
      return createOpenclawBackend({
        url: process.env.OPENCLAW_GATEWAY_URL?.trim() || oc?.gateway_url,
        token: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || oc?.gateway_token,
        agent: process.env.OPENCLAW_AGENT?.trim() || oc?.agent,
        // OPENCLAW_TASK_TIMEOUT_MS env parsing already lives in the factory
        // (`resolveTimeout`). Pass the config value only when env is unset or
        // blank so a freshly-templated `OPENCLAW_TASK_TIMEOUT_MS=` doesn't
        // make the factory parse `""` as 0 and fall back to the compiled
        // default, ignoring config.
        taskTimeoutMs: envTimeout ? undefined : oc?.task_timeout_ms,
      });
    }
    case 'claude':
      return createClaudeBackend({
        cwd:
          process.env.CLAUDE_CWD?.trim() ||
          backends.claude?.cwd ||
          undefined,
        identity: deriveIdentity(args.agentId, args.server) ?? undefined,
        settings:
          parseClaudeSettingsEnv(process.env.CLAUDE_SETTINGS_JSON) ??
          backends.claude?.settings,
      });
    case 'codex':
      return createCodexBackend({
        cwd:
          process.env.CODEX_CWD?.trim() ||
          backends.codex?.cwd ||
          undefined,
        sandboxMode:
          parseCodexSandboxMode(process.env.CODEX_SANDBOX_MODE) ??
          parseCodexSandboxMode(backends.codex?.sandbox_mode),
      });
    default:
      throw new Error(`unknown backend: ${name} (supported: echo, openclaw, claude, codex)`);
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

async function runUpgradeCmd(args: string[]): Promise<number> {
  let check = false;
  let force = false;
  let version: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') check = true;
    else if (a === '--force') force = true;
    else if (a === '--version') {
      version = args[++i];
      if (!version) {
        console.error('--version requires a value (e.g. 0.3.0, v0.3.0, or @vicoop-bridge/client@0.3.0)');
        return 1;
      }
    } else if (a === '-h' || a === '--help') {
      console.log('usage: vicoop-client upgrade [--check] [--force] [--version <X.Y.Z | vX.Y.Z | @vicoop-bridge/client@X.Y.Z>]');
      return 0;
    } else {
      console.error(`unknown argument to upgrade: ${a}`);
      return 1;
    }
  }
  try {
    return await runUpgrade({ check, force, version });
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
