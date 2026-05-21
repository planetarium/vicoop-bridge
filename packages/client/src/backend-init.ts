// `vicoop-client backend init <kind>` — operator one-shot
// bootstrap for the external-runtime profile (#249 PR C).
//
// Boots the per-backend runtime container, runs the shared
// install-backend.sh recipe inside it, sanity-checks the resulting
// binary against this client's supportedRange manifest, and
// (default) copies the host's existing agent CLI creds into the
// container-scoped named volume so the operator can immediately go
// daemon. `--no-auth` skips that copy when the operator wants to
// hand-roll auth (`docker exec -it vicoop-runtime-<kind> claude
// setup-token` or codex's device-flow login).
//
// Companion to RuntimeContainer (lifecycle) + SpawnAdapter
// (per-task spawn). RuntimeContainer is the unit of state that
// survives across daemon restarts; this command is what makes it
// usable in the first place.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execSync } from 'node:child_process';
import semver from 'semver';
import { longestMatch, object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { argument, command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import { choice, string } from '@optique/core/valueparser';
import type { InferValue } from '@optique/core/parser';
import { RuntimeContainer, DEFAULT_RUNTIME_IMAGE } from './runtime-container.js';
import { BACKENDS_MANIFEST, type InstallableBackendKind } from './backends-manifest.js';
import { createLogger, type Logger } from './logger.js';

export interface BackendInitOptions {
  kind: InstallableBackendKind;
  // Future-proofing — today only 'container' is implemented. host
  // mode prints an actionable error rather than guessing how the
  // operator wants the agent CLI installed on their OS.
  runtime: 'host' | 'container';
  // When true, copy the operator's existing host creds into the
  // container creds volume. When false, leave creds empty and let
  // the operator run an interactive auth flow themselves.
  fromHost: boolean;
  // Image override mirrors the daemon path (cli.ts:resolveRuntime).
  // Resolved by the CLI before this function runs; included here
  // so tests can pass a stub image without touching env.
  image?: string;
  // Override the bridge URL forwarded into the container's
  // init-firewall.sh. The CLI defaults this to whatever the daemon
  // would use; included as a parameter so tests can override.
  bridgeUrl?: string;
  logger?: Logger;
}

// Returns the process exit code the CLI should use. Throws only on
// programmer-error (e.g. unsupported kind reaching this function).
// Operational failures (docker unreachable, install recipe non-zero,
// compat mismatch) are logged and surface as a non-zero return so
// the CLI can `process.exit(code)` uniformly.
export async function runBackendInit(opts: BackendInitOptions): Promise<number> {
  const log = opts.logger ?? createLogger();
  if (opts.runtime !== 'container') {
    log.error(
      `backend init currently supports --runtime container only. ` +
        `For host mode, install ${opts.kind} via its official installer and ` +
        `run \`vicoop-client --backend ${opts.kind}\` directly.`,
    );
    return 64;
  }

  const runtime = new RuntimeContainer({
    backendKind: opts.kind,
    image: opts.image ?? process.env.VICOOP_RUNTIME_IMAGE ?? DEFAULT_RUNTIME_IMAGE,
    bridgeUrl: opts.bridgeUrl,
    logger: opts.logger,
  });

  try {
    await runtime.start();

    // (1) chown the per-kind sub-trees so subsequent install-backend
    // (running as the image's `node` user) can mkdir into them.
    // Docker creates named-volume mount points root-owned even when
    // the image pre-creates them with chown — the volume's empty
    // state takes over at mount time. This is the documented
    // workaround.
    await execAndStream(runtime, {
      command: 'chown',
      args: ['-R', 'node:node', `/data/agents/${opts.kind}`, `/data/creds/${opts.kind}`],
      user: '0',
      label: 'chown',
      log,
    });

    // (2) install the agent CLI into /data/agents/<kind>/ via the
    // shared shell recipe baked into the runtime image. node user;
    // the binary lands in /data/agents/<kind>/bin/<kind>.
    await execAndStream(runtime, {
      command: '/usr/local/lib/vicoop-bridge/install-backend.sh',
      args: [opts.kind],
      label: 'install',
      log,
    });

    // (3) compat check — probe the installed binary's version and
    // compare it against the manifest. We fail loudly here rather
    // than at first-task-time so the operator sees the mismatch
    // before pointing a real bridge at it.
    const installed = await probeBackendVersion(runtime, opts.kind);
    const supportedRange = BACKENDS_MANIFEST[opts.kind].supportedRange;
    if (!installed) {
      log.warn(`could not probe installed ${opts.kind} version — skipping compat check`);
    } else if (!semver.satisfies(installed, supportedRange, { includePrerelease: true })) {
      log.error(
        `installed ${opts.kind} ${installed} is outside this client's supportedRange ${supportedRange}`,
      );
      return 1;
    } else {
      log.info(`compat check: ${opts.kind} ${installed} satisfies ${supportedRange}`);
    }

    // (4) creds. Either copy from host or leave empty for an
    // operator-driven OAuth flow.
    if (opts.fromHost) {
      await copyHostCreds(runtime, opts.kind, log);
    } else {
      log.info(
        `--no-auth: leaving creds empty. To auth inside the container run\n` +
          `    docker exec -it vicoop-runtime-${opts.kind} ${authHintFor(opts.kind)}`,
      );
    }

    log.info(`backend ${opts.kind} ready. start daemon with:`);
    log.info(`    vicoop-client --backend ${opts.kind} --${opts.kind}-runtime container`);
    return 0;
  } finally {
    // Leave the container running. The next daemon launch reuses
    // it; an explicit cleanup is `docker stop vicoop-runtime-<kind>`
    // (operator's job, on purpose — they may be about to start the
    // daemon).
  }
}

// Stream a docker-exec command's stdout/stderr to the host
// console + reject on non-zero exit. Used by the chown / install /
// version-probe steps where we want the operator to see the
// install recipe's output in real time.
async function execAndStream(
  runtime: RuntimeContainer,
  opts: {
    command: string;
    args: readonly string[];
    user?: string;
    label: string;
    log: Logger;
  },
): Promise<void> {
  opts.log.info(`[${opts.label}] ${opts.command} ${opts.args.join(' ')}`);
  const exec = await runtime.exec({
    command: opts.command,
    args: opts.args,
    ...(opts.user ? { user: opts.user } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  runtime.getDocker().modem.demuxStream(stream, stdout, stderr);
  stdout.on('data', (chunk) => process.stdout.write(chunk));
  stderr.on('data', (chunk) => process.stderr.write(chunk));
  await new Promise<void>((resolve) => stream.on('end', resolve));
  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    throw new Error(`[${opts.label}] exited with code ${info.ExitCode}`);
  }
}

// Quietly run `<kind> --version` and extract a semver-shaped token.
// claude prints `2.1.146 (Claude Code)` (semver leads), codex prints
// `codex-cli 0.132.0` (semver is the second token). A naive first-
// token grab gets fooled by codex's program-name prefix, so we look
// for the first `X.Y.Z` (with optional pre-release / build suffix)
// anywhere in the line. Same convention container/backends/*.sh
// uses for its own backend_version function.
async function probeBackendVersion(
  runtime: RuntimeContainer,
  kind: InstallableBackendKind,
): Promise<string | null> {
  const exec = await runtime.exec({
    command: `/data/agents/${kind}/bin/${kind}`,
    args: ['--version'],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  runtime.getDocker().modem.demuxStream(stream, stdout, stderr);
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => stream.on('end', resolve));
  const info = await exec.inspect();
  if (info.ExitCode !== 0) return null;
  const out = Buffer.concat(chunks).toString();
  const match = out.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
  return match?.[0] ?? null;
}

// Per-kind host creds discovery + copy into the container creds
// volume. Each helper returns the bytes-to-write keyed by target
// path so the writer is one place.
async function copyHostCreds(
  runtime: RuntimeContainer,
  kind: InstallableBackendKind,
  log: Logger,
): Promise<void> {
  let files: Array<{ target: string; data: Buffer }> = [];
  if (kind === 'claude') {
    files = collectClaudeHostCreds(log);
  } else if (kind === 'codex') {
    files = collectCodexHostCreds(log);
  }
  if (files.length === 0) {
    log.warn(
      `--from-host: no host creds found for ${kind}; continuing. ` +
        `Run interactive auth inside the container or rerun with creds present.`,
    );
    return;
  }
  for (const f of files) {
    await writeContainerFile(runtime, f.target, f.data);
    log.info(`copied ${kind} creds → ${f.target}`);
  }
}

function collectClaudeHostCreds(log: Logger): Array<{ target: string; data: Buffer }> {
  // macOS: token lives in the Keychain under "Claude Code-credentials";
  // pull it out via `security` (read-only, no mutation). On linux the
  // CLI persists ~/.claude/.credentials.json — read it directly.
  if (process.platform === 'darwin') {
    try {
      const out = execSync(`security find-generic-password -s 'Claude Code-credentials' -w`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (out.length === 0) return [];
      return [{ target: '/data/creds/claude/.credentials.json', data: Buffer.from(`${out}\n`) }];
    } catch {
      log.warn('--from-host: macOS keychain lookup for claude creds failed');
      return [];
    }
  }
  const linuxPath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(linuxPath)) {
    return [{ target: '/data/creds/claude/.credentials.json', data: readFileSync(linuxPath) }];
  }
  return [];
}

function collectCodexHostCreds(_log: Logger): Array<{ target: string; data: Buffer }> {
  // codex stores its OAuth token + config in ~/.codex. We pick up
  // auth.json (token) and config.toml (model/provider config) when
  // present — anything else (sessions, cache) is intentionally
  // left behind so the named volume doesn't fill up with stale
  // local state.
  const out: Array<{ target: string; data: Buffer }> = [];
  const authPath = join(homedir(), '.codex', 'auth.json');
  if (existsSync(authPath)) {
    out.push({ target: '/data/creds/codex/auth.json', data: readFileSync(authPath) });
  }
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (existsSync(configPath)) {
    out.push({ target: '/data/creds/codex/config.toml', data: readFileSync(configPath) });
  }
  return out;
}

// Write a small file into the container by piping through
// `bash -c 'cat > <target>'`. Uses dockerode exec so we don't shell
// out to the `docker` CLI; the dependency surface stays consistent
// with the rest of the runtime module.
async function writeContainerFile(
  runtime: RuntimeContainer,
  targetPath: string,
  data: Buffer,
): Promise<void> {
  const exec = await runtime.exec({
    command: 'bash',
    args: ['-c', `cat > ${targetPath} && chmod 600 ${targetPath}`],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  stream.end(data);
  await new Promise<void>((resolve) => stream.on('end', resolve));
  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    throw new Error(`failed to write ${targetPath} (exit ${info.ExitCode})`);
  }
}

function authHintFor(kind: InstallableBackendKind): string {
  if (kind === 'claude') return 'claude setup-token';
  if (kind === 'codex') return 'codex login --device-auth';
  return `<kind>-specific auth command`;
}

// ──────────────────────────────────────────────────────────────────────────
// CLI surface (`vicoop-client backend init <kind> [opts]`)
//
// Lives in the same module as the implementation so the command's
// flags + the function's options stay obviously paired. cli.ts only
// imports the top-level `backendCmd` and the dispatcher.
// ──────────────────────────────────────────────────────────────────────────

const BACKEND_KINDS = ['claude', 'codex'] as const;
const RUNTIME_MODES = ['host', 'container'] as const;

const backendInitSubCmd = command(
  'init',
  object({
    action: constant('backend-init' as const),
    kind: argument(choice([...BACKEND_KINDS])),
    runtime: withDefault(
      option('--runtime', choice([...RUNTIME_MODES]), {
        description: message`Where the backend runs. \`container\` (default) boots a vicoop-runtime container; \`host\` is reserved for a future cut.`,
      }),
      'container' as const,
    ),
    fromHost: withDefault(
      flag('--from-host', {
        description: message`Copy the operator's existing host creds into the container's per-backend creds volume (macOS keychain for claude, ~/.codex for codex). Off by default — explicit opt-in for the runtime-isolation tradeoff.`,
      }),
      false,
    ),
    bridgeUrl: optional(
      option('--bridge', string({ metavar: 'WS_URL' }), {
        description: message`Bridge WS URL forwarded into the runtime container's init-firewall.sh allowlist. Defaults to the daemon's default.`,
      }),
    ),
    image: optional(
      option('--image', string({ metavar: 'IMAGE' }), {
        description: message`Override the runtime image. Same precedence as VICOOP_RUNTIME_IMAGE.`,
      }),
    ),
  }),
  {
    brief: message`Bootstrap an external-runtime backend (#249 PR C).`,
    description: message`One-shot setup for the container-runtime profile: boots the per-backend runtime container, runs the install-backend.sh recipe inside it, verifies the installed CLI version against this client's supportedRange, and (with --from-host) copies the operator's existing host creds into the container creds volume. After this, launch the daemon with \`vicoop-client --backend <kind> --<kind>-runtime container\`.`,
  },
);

export const backendCmd = command(
  'backend',
  longestMatch(backendInitSubCmd),
  {
    brief: message`Manage external-runtime backends.`,
    description: message`Subcommands: \`init\` (boot the runtime container, install the agent CLI, optionally copy host creds). Pairs with the daemon flags \`--claude-runtime container\` / \`--codex-runtime container\`.`,
  },
);

export type BackendCliArgs = InferValue<typeof backendCmd>;
export type BackendInitArgs = Extract<BackendCliArgs, { action: 'backend-init' }>;

// Adapter from optique-parsed args → runBackendInit's typed
// options. Lives here (not in cli.ts) so the command surface and
// its dispatcher are obviously co-located.
export async function runBackendInitCli(args: BackendInitArgs): Promise<number> {
  try {
    return await runBackendInit({
      kind: args.kind,
      runtime: args.runtime,
      fromHost: args.fromHost,
      ...(args.image ? { image: args.image } : {}),
      ...(args.bridgeUrl ? { bridgeUrl: args.bridgeUrl } : {}),
    });
  } catch (err) {
    console.error(`backend init failed: ${(err as Error).message}`);
    return 1;
  }
}
