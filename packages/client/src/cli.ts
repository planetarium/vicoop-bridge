#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { AgentCard } from '@vicoop-bridge/protocol';
import { resolveBundledCard } from './bundled-cards.js';
import { group, longestMatch, object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import { Client } from './client.js';
import { echoBackend } from './backends/echo.js';
import { createOpenclawBackend } from './backends/openclaw.js';
import { createClaudeBackend, type ClaudeSpawnFn } from './backends/claude.js';
import {
  createCodexBackend,
  type ApprovalDecision,
} from './backends/codex.js';
import type { AppServerSpawnFn } from './backends/codex-rpc.js';
import { createVicoopCodexBackend } from './backends/vicoop-codex.js';
import type { Backend } from './backend.js';
import { RuntimeContainer, DEFAULT_RUNTIME_IMAGE } from './runtime-container.js';
import { createDockerExecSpawn, type SpawnFn } from './spawn-adapter.js';
import {
  assertContainerCredsPresent,
  containerCmd,
  runContainerInitCli,
  runContainerListCli,
  runContainerRemoveCli,
} from './container-init.js';
import isInsideContainer from 'is-inside-container';
import { clientVersion } from './version.js';
import { runUpgrade } from './upgrade.js';
import { BACKEND_COMPAT } from './backends-manifest.js';
import { authLoginCmd, loginCmd, runAuthLogin, runLogin } from './login.js';
import { authLogoutCmd, logoutCmd, runAuthLogout, runLogout } from './logout.js';
import { setupCmd, runAgentRegister, runSetup } from './setup.js';
import {
  addCallerCmd, agentCmd, listAgentsCmd, listCallersCmd, listClientsCmd,
  removeCallerCmd, revokeClientCmd,
  runAddCaller, runAgentCallersAdd, runAgentCallersList, runAgentCallersRemove,
  runAgentCallersIssue,
  runAgentDelete, runAgentList, runListAgents, runListCallers, runListClients,
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
import { createLogger, type Logger } from './logger.js';
import {
  claimPidFile,
  defaultLogPath,
  formatUptime,
  inspectDaemon,
  pidFilePath,
  processStartId,
  removePidFile,
  stopDaemon,
  writePidRecord,
} from './daemon-control.js';

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
    // Drop from the top-level Usage: block — per-command details are
    // already a `vicoop-client upgrade --help` away. Keeps the brief
    // listing entry (under the "Maintenance" group header).
    hidden: 'usage',
  },
);

// Read-only self-introspection. Bundles the client's semver, the
// container image version (when running inside the bundled-direct
// image, #244 — env `VICOOP_BRIDGE_IMAGE`), and the backend compat
// manifest. Consumed by the bundled image's entrypoint, by #249's
// external-runtime orchestrator, and by anyone wanting to validate
// the installed agent CLI version against the range this client
// expects.
const infoCmd = command(
  'info',
  object({
    action: constant('info' as const),
  }),
  {
    brief: message`Print client / image / backend metadata as JSON.`,
    description: message`Emits a single JSON object with this client's version, the bundled image's version (if running inside one — \`VICOOP_BRIDGE_IMAGE\` env), and the backend compat manifest.`,
    hidden: 'usage',
  },
);

// `vicoop-client start`: the long-running daemon entrypoint. Promoted to an
// explicit subcommand so bare `vicoop-client` no longer connects to the
// bridge — an operator running `vicoop-client` to grep for help should not
// silently boot a network process. The action discriminator stays
// `'daemon'` so runDaemon and the dispatch switch don't need to change.
// `daemonFlagsFields` is the raw parser-field map exported from cli-args.ts
// so we can splice it in here without losing per-field types.
const startCmd = command(
  'start',
  object({
    action: constant('daemon' as const),
    // Launch-control flags. Kept separate from `daemonFlagsFields` (which is
    // the runtime-config surface threaded into the backend) because
    // `--detach` / `--log-file` only steer *how* the daemon is launched, not
    // what it does once running — see `startDetached`.
    detach: withDefault(flag('--detach', {
      description: message`Run the daemon in a detached background session (new session/process-group leader) and return immediately. Survives the session/pgrp reaping that kills \`nohup … &\` in agent-driven exec sandboxes (#186). Writes a pidfile so \`stop\` / \`status\` can manage it. POSIX only. Caveat: survives session/pgrp teardown but NOT cgroup/container teardown — for reboot/crash persistence use a real service manager (systemd --user / launchd).`,
    }), false),
    logFile: optional(option('--log-file', string({ metavar: 'PATH' }), {
      description: message`With \`--detach\`, where to redirect the daemon's stdout+stderr. Defaults to \`vicoop.log\` under the canonical home dir. Ignored without \`--detach\`.`,
    })),
    ...daemonFlagsFields,
  }),
  {
    brief: message`Start the bridge client daemon.`,
    description: message`Connects to the bridge server, advertises the chosen backend's agent card, and runs until interrupted. With \`config.json\` populated by \`agent register\`, this needs no flags. Precedence over the canonical \`config.json\` is the same as documented in \`docs/install-client.md\` (CLI flag > \`--config\` overlay > canonical config > built-in default). Pass \`--detach\` to background it under a pidfile managed by \`stop\` / \`status\`.`,
    hidden: 'usage',
  },
);

// `vicoop-client stop` / `status`: pidfile-driven lifecycle for a daemon
// started with `start --detach`. Both refuse to act on a stale / recycled
// PID — `inspectDaemon` confirms the live process still looks like a
// vicoop-client daemon before stop signals it or status reports it running.
const stopCmd = command(
  'stop',
  object({
    action: constant('stop' as const),
  }),
  {
    brief: message`Stop a detached daemon (SIGTERM → grace → SIGKILL).`,
    description: message`Reads the pidfile written by \`start --detach\`, sends SIGTERM, waits a grace period, then escalates to SIGKILL if still alive. A stale pidfile (process gone, or a recycled PID that no longer looks like vicoop-client) is cleaned up without signaling anything.`,
    hidden: 'usage',
  },
);

const statusCmd = command(
  'status',
  object({
    action: constant('status' as const),
  }),
  {
    brief: message`Report whether a detached daemon is running.`,
    description: message`Inspects the \`start --detach\` pidfile. Exit code: 0 running, 3 stopped (no pidfile), 1 stale (pidfile present but not a live vicoop-client daemon).`,
    hidden: 'usage',
  },
);

// Owner-session umbrella. Mirrors the `agent` umbrella from #218: both new
// subcommands sit under their topic, the flat versions stay as deprecated
// aliases.
const authCmd = command(
  'auth',
  longestMatch(authLoginCmd, authLogoutCmd, authWhoamiCmd),
  {
    brief: message`Manage owner-session and identity (sign in / out / whoami).`,
    description: message`Operator-facing umbrella for owner-session and agent-identity. Subcommands: \`login\`, \`logout\`, \`whoami\`. Replaces the older flat \`login\` / \`logout\` / \`whoami\` commands, which remain as deprecated aliases.`,
    hidden: 'usage',
  },
);

// Deprecated flat aliases — kept for backward-compat (each handler in
// admin-cli.ts calls `warnDeprecated` before dispatching to the new
// shape) but folded into one slot so optique's longestMatch overload
// table doesn't blow up as we keep adding top-level commands.
const legacyAdminCmds = longestMatch(
  addCallerCmd,
  removeCallerCmd,
  listCallersCmd,
  listAgentsCmd,
  listClientsCmd,
  revokeClientCmd,
);

// All subcommands in one parser. `longestMatch` (rather than `or`) keeps
// behavior stable as more sibling commands are added — branches with a
// keyword match consume more tokens and win deterministically. `group()`
// gives optique's help renderer section headers so the top-level help
// scans as an operator workflow rather than a 17-line wall.
const cli = longestMatch(
  group('Run the daemon', longestMatch(startCmd, stopCmd, statusCmd)),
  group('Identity', authCmd),
  group('Agents', agentCmd),
  group('Runtime containers', containerCmd),
  group('Maintenance', longestMatch(upgradeCmd, infoCmd)),
  // Hidden by `hidden: 'help'` on each command; kept in the parser tree
  // for back-compat and "did you mean?" suggestions. Sit outside the
  // group() wrappers so they don't appear under any section header.
  loginCmd,
  logoutCmd,
  setupCmd,
  whoamiCmd,
  legacyAdminCmds,
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
    if (result.missing.length) {
      console.error(`missing required args: ${result.missing.join(', ')}`);
    }
    for (const e of result.errors) console.error(e);
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

// What pickBackend returns. The optional `shutdown` is an async
// cleanup hook the daemon awaits **before** process.exit — Backend's
// own `stop()` is documented as synchronous best-effort, which works
// for kill-a-subprocess but not for "ask docker daemon to stop a
// container and wait for the SIGTERM grace period to elapse." When
// shutdown is set, the SIGINT/SIGTERM handler in runDaemon awaits it
// (under a timeout) so an orderly exit really does end with the
// runtime container stopped.
interface PickedBackend {
  backend: Backend;
  shutdown?: () => Promise<void>;
}

async function pickBackend(name: string, args: Args): Promise<PickedBackend> {
  // All backend-specific knobs are now threaded through `args` (merged from
  // flag + config in mergeClientArgs). `pickBackend` just constructs
  // the right factory with those values; no env reads here — except for
  // VICOOP_RUNTIME_IMAGE, which is image-identity (mirrors how the
  // bundled profile resolves VICOOP_BRIDGE_IMAGE).
  const backends = args.backends ?? {};
  switch (name) {
    case 'echo':
      return { backend: echoBackend };
    case 'openclaw': {
      // openclaw's persona / system prompt lives in the gateway-side config
      // (`/data/openclaw.json`), not in a per-message field on `chat.send`.
      // Self-identity is surfaced via `vicoop-client whoami` so operators
      // can paste it into their gateway persona; the bridge has no
      // wire-protocol hook to inject it from here.
      return {
        backend: createOpenclawBackend({
          url: args.openclawGateway ?? backends.openclaw?.gateway_url,
          token: args.openclawGatewayToken ?? backends.openclaw?.gateway_token,
          agent: args.openclawAgent ?? backends.openclaw?.agent,
          openaiCompatAgent:
            args.openclawOpenaiCompatAgent ?? backends.openclaw?.openai_compat_agent,
          taskTimeoutMs: args.openclawTaskTimeoutMs,
          openaiCompatTrace: args.openaiCompatTrace,
        }),
      };
    }
    case 'claude': {
      // settings precedence: --claude-settings-file (flag, path on disk) >
      // backends.claude.settings (config). No env layer (#189 §5).
      const baseSettings = args.claudeSettingsFile
        ? readClaudeSettingsFile(args.claudeSettingsFile)
        : backends.claude?.settings;
      const { spawn, cwd, runtime } = await resolveRuntime({
        kind: 'claude',
        runtime: args.runtime,
        runtimeName: args.runtimeName,
        cwd: args.cwd,
        bridgeUrl: args.server,
      });
      // claude's bwrap sandbox is redundant when *we* are already
      // isolated — either because the daemon spawned an external
      // runtime container (`runtime` set) or because the daemon
      // itself is running inside a container (bundled-direct #244).
      // Either way the outer container is the real isolation
      // boundary; layering bwrap inside it just makes the runtime
      // image carry deps it doesn't need and trips
      // `sandbox.failIfUnavailable` on first task.
      const isolated = runtime !== undefined || isInsideContainer();
      const settings = isolated ? disableClaudeSandboxGuard(baseSettings) : baseSettings;
      const backend = createClaudeBackend({
        cwd,
        identity: deriveIdentity(args.agentId, args.server) ?? undefined,
        settings,
        model: args.claudeModel,
        openaiCompatTrace: args.openaiCompatTrace,
        ...(spawn ? { spawn: spawn as ClaudeSpawnFn } : {}),
      });
      return runtime ? { backend, shutdown: () => runtime.stop() } : { backend };
    }
    case 'codex': {
      const { spawn, cwd, runtime } = await resolveRuntime({
        kind: 'codex',
        runtime: args.runtime,
        runtimeName: args.runtimeName,
        cwd: args.cwd,
        bridgeUrl: args.server,
      });
      // Same reasoning as the claude branch: codex's host-process
      // sandbox doubles up with the outer container's isolation.
      // In a true host context (no runtime container, daemon
      // running directly on the host) codex's own 'read-only'
      // default is the right safety floor; in isolated contexts
      // we lift it to 'danger-full-access' so codex can write to
      // /workspace and run bash. Operator override
      // (--codex-sandbox / config) still wins.
      const isolated = runtime !== undefined || isInsideContainer();
      const explicitSandbox = coerceCodexSandbox(args, backends.codex?.sandbox_mode);
      const sandboxMode = isolated
        ? (explicitSandbox ?? 'danger-full-access')
        : explicitSandbox;
      const backend = createCodexBackend({
        cwd,
        sandboxMode,
        approvalDecision: backends.codex?.approval_decision as ApprovalDecision | undefined,
        openaiCompatTrace: args.openaiCompatTrace,
        identity: deriveIdentity(args.agentId, args.server) ?? undefined,
        ...(spawn ? { spawn: spawn as AppServerSpawnFn } : {}),
      });
      return runtime ? { backend, shutdown: () => runtime.stop() } : { backend };
    }
    case 'vicoop-codex':
      return {
        backend: createVicoopCodexBackend({
          openaiCompatTrace: args.openaiCompatTrace,
        }),
      };
    default:
      throw new Error(
        `unknown backend: ${name} (supported: echo, openclaw, claude, codex, vicoop-codex)`,
      );
  }
}

// Resolves the runtime mode for a claude/codex backend.
//
// - 'host' (default): nothing to do. The backend factory's built-in
//   defaultSpawn handles host child_process.spawn unchanged.
// - 'container': reuses or starts an existing long-lived vicoop-runtime
//   container for this kind and returns a docker-exec SpawnFn the
//   backend factory plugs into its spawn slot. cwd, if any, is
//   rewritten to /workspace; the original host path is expected to be
//   the bind-mount source from container init.
async function resolveRuntime(args: {
  kind: 'claude' | 'codex';
  runtime: 'host' | 'container' | undefined;
  runtimeName: string | undefined;
  cwd: string | undefined;
  bridgeUrl: string;
}): Promise<{ spawn?: SpawnFn; cwd?: string; runtime?: RuntimeContainer }> {
  if ((args.runtime ?? 'host') !== 'container') {
    return { cwd: args.cwd };
  }
  const runtime = new RuntimeContainer({
    backendKind: args.kind,
    runtimeName: args.runtimeName,
    image: process.env.VICOOP_RUNTIME_IMAGE || DEFAULT_RUNTIME_IMAGE,
    workspaceDir: args.cwd,
    bridgeUrl: args.bridgeUrl,
  });
  await runtime.start();
  // Fail fast if the operator started the daemon against a runtime that
  // was initialised without --from-host and has not been authenticated
  // yet. Without this check the daemon would happily accept tasks until
  // the first spawn, then surface a backend-specific auth error.
  try {
    await assertContainerCredsPresent(runtime.getContainerName(), args.kind);
  } catch (err) {
    await runtime.stop();
    throw err;
  }
  return {
    runtime,
    spawn: createDockerExecSpawn(runtime),
    // Inside the container the workspace is always /workspace (when
    // bind-mounted) — backends pass this through to claude/codex as
    // their --cwd, so the host path the operator typed must not leak
    // into the container's argv.
    cwd: args.cwd ? '/workspace' : undefined,
  };
}

// Container-mode override for claude's sandbox guard. Returns a new
// settings object with `sandbox.failIfUnavailable: false` merged on
// top of whatever the operator already had. Other sandbox keys —
// including any future addition from claude-code — are preserved.
// Exported for unit-testability; daemon-only usage doesn't need to
// import it from outside cli.ts.
export function disableClaudeSandboxGuard(
  base: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  const existing = out.sandbox;
  const sandbox: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  sandbox.failIfUnavailable = false;
  out.sandbox = sandbox;
  return out;
}

// Race a shutdown promise against a timeout. Container stop normally
// completes within docker's grace period (RuntimeContainer.stop()
// passes t: 10s) but we don't want a wedged daemon socket to hold
// SIGINT hostage indefinitely — operators expect ctrl-c to actually
// exit. Resolves either way; the caller decides whether to surface
// the timeout in logs.
const SHUTDOWN_TIMEOUT_MS = 15_000;
async function runWithShutdownTimeout(
  shutdown: () => Promise<void>,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`runtime shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Resolve the agent card the daemon should send inline on `hello`. Order:
//   1. operator-supplied `--card` path (highest priority — full override)
//   2. embedded `BUNDLED_CARDS[backend]` shipped with this package (default)
//   3. undefined — server falls back to its own canonical card for the
//      backend kind. The server card is the right shape but lacks anything
//      we'd want to advertise dynamically (e.g. openai-compat/v1
//      `params.models`, per planetarium/oai2a2a#63), so always preferring
//      the local bundle when present makes the advertise reachable.
async function runDaemon(parsed: Extract<CliArgs, { action: 'daemon' }>): Promise<void> {
  const args = resolveDaemonArgs(parsed);
  const logger = createLogger();
  const raw = args.card
    ? JSON.parse(readFileSync(args.card, 'utf8'))
    : resolveBundledCard(args.backend);
  const agentCard = raw ? AgentCard.parse(raw) : undefined;

  // Emit the resolved backend at startup so operators can verify which
  // backend the precedence chain picked (flag vs. config vs. default
  // 'echo'). Without this the only signal is downstream behavior —
  // operators reading boot logs to diagnose "wrong backend ran" can't
  // tell whether parsing landed where they expected.
  logger.info(`backend: ${args.backend}`);

  // pickBackend is async because container-mode backends boot a
  // long-lived runtime container before construction (#249).
  const { backend, shutdown: backendShutdown } = await pickBackend(args.backend, args);

  const client = new Client({
    serverUrl: args.server,
    token: args.token,
    agentId: args.agentId,
    agentCard,
    backendKind: args.backend,
    backend,
    logLevel: logger.level,
    // Daemon entrypoint: a fatal terminal close (currently 4014 "client
    // deleted") should drop the process with a non-zero exit so
    // systemd / a parent supervisor sees the deletion as a hard
    // failure instead of masking it as a transient disconnect. The
    // Client class deliberately does not call process.exit itself —
    // tests and future in-process embedders pass a non-exiting callback.
    onFatal: () => process.exit(1),
  });

  client.start();

  // Async shutdown so the container-mode `runtime.stop()` actually
  // completes before process.exit. Re-entry guarded: a second
  // signal (e.g. impatient operator pressing ctrl-c twice) drops to
  // an immediate exit so the daemon can't get pinned by a wedged
  // docker socket.
  // When we are the detached child (spawned by `start --detach`, marked via
  // VICOOP_DETACHED), we own the pidfile the parent wrote on our behalf.
  // Remove it on a graceful exit so a daemon that's asked to stop — whether
  // by `vicoop-client stop` or a direct SIGTERM from a supervisor — doesn't
  // leave a corpse pidfile behind. A crash exit still leaves a stale file,
  // but `stop`/`status` detect and clean that.
  const ownsPidFile = process.env.VICOOP_DETACHED === '1';
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.info(`received second ${signal}; forcing exit`);
      process.exit(130);
    }
    shuttingDown = true;
    void (async () => {
      logger.info(`shutting down (${signal})`);
      client.stop();
      if (ownsPidFile) removePidFile();
      if (backendShutdown) {
        try {
          await runWithShutdownTimeout(backendShutdown, logger);
        } catch (err) {
          logger.error('shutdown error:', (err as Error).message);
        }
      }
      process.exit(0);
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Re-exec ourselves with the daemon argv minus the launch-control flags, so
// the child runs the foreground daemon path inside its own fresh session.
// process.argv is `[execPath, (scriptPath?), ...args]` — `slice(1)` keeps the
// script path for node-from-source and is empty for the Bun single-file build
// (where execPath IS the binary), so the same reconstruction works for both.
function buildDetachChildArgv(): string[] {
  const out: string[] = [];
  const rest = process.argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--detach') continue;
    if (a === '--log-file') {
      i++; // drop the flag and its value; the child logs to the inherited fd
      continue;
    }
    if (a.startsWith('--log-file=')) continue;
    out.push(a);
  }
  return out;
}

// Race the spawned child's early exit against a short grace timer. A daemon
// that dies instantly on bad config / missing credentials should surface as a
// failed launch (with a pointer to the log) rather than a cheerful "started"
// message and a pidfile pointing at a corpse. Resolves `true` if the child is
// still alive when the grace window elapses, `false` if it exited/errored
// first. The pending timer keeps the event loop alive across the window even
// though the child itself is unref'd.
function childSurvivesGrace(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(true), ms);
    child.once('exit', () => done(false));
    child.once('error', () => done(false));
  });
}

const DETACH_GRACE_MS = 600;

// `start --detach`: atomically claim the pidfile (the O_EXCL create is the
// lock against a concurrent `start --detach`), spawn a detached copy of
// ourselves, overwrite the pidfile with the real child record, and exit 0
// once the child has survived the grace window. Never returns.
async function startDetached(
  parsed: Extract<CliArgs, { action: 'daemon' }>,
): Promise<never> {
  if (process.platform === 'win32') {
    console.error(
      'start --detach is not supported on Windows. Run `vicoop-client start` ' +
        'in the foreground under a Windows service manager (e.g. NSSM) instead.',
    );
    process.exit(1);
  }

  const path = pidFilePath();
  const logPath = parsed.logFile?.trim() || defaultLogPath();

  // Claim the pidfile BEFORE doing anything observable. The placeholder
  // records *this* launcher process — alive and command-matching for the whole
  // start window — so a racing `start --detach` that loses the O_EXCL create
  // sees a coherent "running" record and backs off instead of double-spawning.
  // From here on, every failure path must release the claim via removePidFile.
  const claim = claimPidFile({
    pid: process.pid,
    startedAt: Date.now(),
    argv: process.argv,
    logPath,
    version: clientVersion,
    procStartId: processStartId(process.pid),
  }, { path });
  if (!claim.ok) {
    // Refusing the second daemon is the point of the lock: two daemons sharing
    // this client token don't coexist — the bridge keeps only the newest
    // connection and evicts the other with close 4009, so the pair would
    // ping-pong (each reconnect kicking the other) with no server-side
    // resolution. The lock stops that duplicate-process state at the source.
    console.error(
      `a detached daemon is already running (pid ${claim.record.pid}); refusing ` +
        'to start a second (two daemons sharing this token would fight over the ' +
        'bridge connection — close 4009 ping-pong). Run `vicoop-client stop` ' +
        'first, or `vicoop-client status` to inspect it.',
    );
    process.exit(1);
  }

  let logFd: number;
  try {
    logFd = openSync(logPath, 'a', 0o600);
  } catch (e) {
    removePidFile(path);
    console.error(`cannot open --log-file ${logPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  const childArgv = buildDetachChildArgv();
  const child = spawnProcess(process.execPath, childArgv, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // VICOOP_DETACHED tells the child it owns the pidfile (cleanup on exit).
    env: { ...process.env, VICOOP_DETACHED: '1' },
  });
  // The child inherited a dup of the log fd; the parent doesn't need it.
  try {
    closeSync(logFd);
  } catch {
    /* ignore */
  }

  if (typeof child.pid !== 'number') {
    removePidFile(path);
    console.error('failed to spawn the detached daemon (no pid).');
    process.exit(1);
  }
  // Detach from the parent's reference-counted event loop so our own exit
  // below doesn't wait on the child.
  child.unref();

  // Overwrite the placeholder with the real child record. We hold the child
  // pid directly (no read-before-write race), and capture the child's OS start
  // identity so `stop`/`status` can later tell it apart from a recycled PID.
  writePidRecord(
    {
      pid: child.pid,
      startedAt: Date.now(),
      argv: [process.execPath, ...childArgv],
      logPath,
      version: clientVersion,
      procStartId: processStartId(child.pid),
    },
    path,
  );

  const survived = await childSurvivesGrace(child, DETACH_GRACE_MS);
  if (!survived) {
    removePidFile(path);
    console.error(
      `the daemon exited immediately after launch; see ${logPath} for the cause.`,
    );
    process.exit(1);
  }

  console.log(
    `vicoop-client daemon started (pid ${child.pid}, logs ${logPath}).`,
  );
  console.log(
    'Manage it with `vicoop-client status` / `vicoop-client stop`.',
  );
  process.exit(0);
}

async function runStop(): Promise<number> {
  const r = await stopDaemon();
  switch (r.outcome) {
    case 'not-running':
      console.log('no detached daemon is running.');
      return 0;
    case 'already-gone':
      console.log(
        `daemon (pid ${r.pid}) was already gone; cleaned up the stale pidfile.`,
      );
      return 0;
    case 'stopped':
      console.log(`stopped daemon (pid ${r.pid}).`);
      return 0;
    case 'killed':
      console.log(
        `daemon (pid ${r.pid}) ignored SIGTERM within the grace period; sent SIGKILL.`,
      );
      return 0;
  }
}

// Exit codes follow the LSB `status` convention: 0 running, 3 stopped. Stale
// (pidfile present but not a live daemon) gets a distinct 1 so a supervisor /
// script can tell "needs cleanup" apart from "cleanly stopped".
function runStatus(): number {
  const state = inspectDaemon();
  if (state.status === 'stopped') {
    console.log('stopped (no pidfile).');
    return 3;
  }
  if (state.status === 'stale') {
    console.log(
      `stale: pidfile points at pid ${state.record.pid}, which is not a ` +
        'running vicoop-client daemon. Run `vicoop-client stop` to clean up.',
    );
    return 1;
  }
  const { record } = state;
  const uptime = record.startedAt
    ? formatUptime(Date.now() - record.startedAt)
    : 'unknown';
  console.log(
    `running (pid ${record.pid}, up ${uptime}, logs ${record.logPath || 'n/a'}).`,
  );
  return 0;
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
  // Bare invocation prints help and exits 0. Pre-`start`-subcommand
  // releases booted the daemon on empty argv; an operator who typed
  // `vicoop-client` to see what was available would silently open the WS
  // until they noticed. Injecting `--help` lets optique render its own
  // usage page and exit cleanly rather than surfacing the "no subcommand"
  // parse failure as a non-zero exit.
  if (process.argv.length <= 2) {
    process.argv.push('--help');
  }
  // Optique handles --help, --version, parse errors, and "did you mean?"
  // suggestions inside `run()`. Anything that reaches the switch is a
  // successfully-parsed subcommand.
  const parsed = run(cli, {
    programName: 'vicoop-client',
    brief: message`A2A bridge client daemon. Connects a local backend (echo, openclaw, claude, codex) to a deployed vicoop-bridge server.`,
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
    // `help` scopes the pre-error doc to whatever subcommand was
    // partially parsed (optique calls `getDocPage(parser, args)`), so
    // `vicoop-client container` prints just the `container` group's
    // help instead of dumping the full root usage block. Falls back
    // to `usage` automatically when no scoped doc is available.
    aboveError: 'help',
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
        backends: BACKEND_COMPAT,
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
    case 'agent-delete':
      process.exit(await runAgentDelete(parsed));
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
    case 'agent-callers-issue':
      process.exit(await runAgentCallersIssue(parsed));
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
    case 'container-init':
      process.exit(await runContainerInitCli(parsed));
      break;
    case 'container-list':
      process.exit(await runContainerListCli(parsed));
      break;
    case 'container-remove':
      process.exit(await runContainerRemoveCli(parsed));
      break;
    case 'daemon':
      // `--detach` re-execs a backgrounded copy and exits the foreground
      // process; the plain path runs the long-lived daemon in place. Both
      // are awaited so launch errors surface through main's catch instead
      // of as unhandled rejections.
      if (parsed.detach) {
        await startDetached(parsed);
      } else {
        // Long-running. Do not exit — client.start() keeps the event loop
        // alive and signal handlers will call process.exit on shutdown.
        await runDaemon(parsed);
      }
      break;
    case 'stop':
      process.exit(await runStop());
      break;
    case 'status':
      process.exit(runStatus());
      break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
