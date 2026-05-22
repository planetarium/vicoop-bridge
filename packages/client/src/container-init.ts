// `vicoop-client container init <kind>` — operator one-shot
// bootstrap for the external-runtime profile (#249 PR C).
//
// Boots the per-backend runtime container, runs the shared
// install-backend.sh recipe inside it, sanity-checks the resulting
// binary against this client's supportedRange manifest, and
// (with --from-host) copies the operator's existing agent CLI
// creds into the container-scoped named volume so the operator can
// immediately go daemon. Without --from-host the command leaves
// creds empty and prints the docker-exec incantation for the
// operator to do an interactive auth flow themselves.
//
// Companion to RuntimeContainer (lifecycle) + SpawnAdapter
// (per-task spawn). RuntimeContainer is the unit of state that
// survives across daemon restarts; this command is what makes it
// usable in the first place.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
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

export interface ContainerInitOptions {
  kind: InstallableBackendKind;
  // When true, copy the operator's existing host creds into the
  // container creds volume. When false, leave creds empty and let
  // the operator run an interactive auth flow themselves.
  fromHost: boolean;
  // Image override mirrors the daemon path (cli.ts:resolveRuntime).
  // Precedence is applied inside runContainerInit:
  //   opts.image > VICOOP_RUNTIME_IMAGE env > DEFAULT_RUNTIME_IMAGE.
  // Tests pass an explicit value here to bypass env entirely.
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
export async function runContainerInit(opts: ContainerInitOptions): Promise<number> {
  const log = opts.logger ?? createLogger();

  const runtime = new RuntimeContainer({
    backendKind: opts.kind,
    image: opts.image ?? process.env.VICOOP_RUNTIME_IMAGE ?? DEFAULT_RUNTIME_IMAGE,
    bridgeUrl: opts.bridgeUrl,
    createIfMissing: true,
    logger: opts.logger,
  });

  try {
    await runtime.start();

    const containerName = `vicoop-runtime-${opts.kind}`;

    // (1) chown the per-kind sub-trees so subsequent install-backend
    // (running as the image's `node` user) can mkdir into them.
    // Docker creates named-volume mount points root-owned even when
    // the image pre-creates them with chown — the volume's empty
    // state takes over at mount time. This is the documented
    // workaround.
    await dockerExecStream(containerName, {
      cmd: ['chown', '-R', 'node:node', `/data/agents/${opts.kind}`, `/data/creds/${opts.kind}`],
      user: '0',
      label: 'chown',
      log,
    });

    // (2) install the agent CLI into /data/agents/<kind>/ via the
    // shared shell recipe baked into the runtime image. node user;
    // the binary lands in /data/agents/<kind>/bin/<kind>.
    await dockerExecStream(containerName, {
      cmd: ['/usr/local/lib/vicoop-bridge/install-backend.sh', opts.kind],
      label: 'install',
      log,
    });

    // (3) compat check — probe the installed binary's version and
    // compare it against the manifest. We fail loudly here rather
    // than at first-task-time so the operator sees the mismatch
    // (or the broken install) before pointing a real bridge at it.
    // A null probe means install-backend.sh "succeeded" but didn't
    // leave a runnable binary at the expected path, or the binary
    // doesn't honor --version — both are install failures, not
    // skippable warnings.
    const installed = await probeBackendVersion(containerName, opts.kind);
    if (!installed) {
      log.error(
        `installed ${opts.kind} did not produce a parseable --version at /data/agents/${opts.kind}/bin/${opts.kind}. ` +
          `The install recipe likely failed silently; rerun \`vicoop-client container init ${opts.kind}\` and inspect the [install] output.`,
      );
      return 1;
    }
    const supportedRange = BACKENDS_MANIFEST[opts.kind].supportedRange;
    if (!semver.satisfies(installed, supportedRange, { includePrerelease: true })) {
      log.error(
        `installed ${opts.kind} ${installed} is outside this client's supportedRange ${supportedRange}`,
      );
      return 1;
    }
    log.info(`compat check: ${opts.kind} ${installed} satisfies ${supportedRange}`);

    // (4) creds. Either copy from host or leave empty for an
    // operator-driven OAuth flow.
    if (opts.fromHost) {
      try {
        await copyHostCreds(containerName, opts.kind, log);
      } catch (err) {
        // `--from-host` is an explicit opt-in. If the host doesn't
        // actually have the creds we'd copy, treating that as a
        // success-with-warning leaves the operator with a runtime
        // container that will fail the first task on auth. Surface
        // it now as a non-zero exit and point at the file/keychain
        // entry we expected.
        log.error(`--from-host: ${(err as Error).message}`);
        log.error(
          `Rerun without --from-host to leave creds empty for an interactive auth flow ` +
            `(docker exec -it vicoop-runtime-${opts.kind} ${authHintFor(opts.kind)}).`,
        );
        return 1;
      }
    } else {
      log.info(
        `--from-host not set: leaving creds empty. To auth inside the container run\n` +
          `    docker exec -it vicoop-runtime-${opts.kind} ${authHintFor(opts.kind)}`,
      );
    }

    log.info(`runtime container for ${opts.kind} ready. start daemon with:`);
    log.info(`    vicoop-client --backend ${opts.kind} --runtime container`);
    return 0;
  } finally {
    // Leave the container running. The next daemon launch reuses
    // it; an explicit cleanup is `docker stop vicoop-runtime-<kind>`
    // (operator's job, on purpose — they may be about to start the
    // daemon).
  }
}

// Run `docker exec [--user U] <container> <cmd...>` with stdio
// inherited so the operator sees install-backend's npm/native-binary
// download chatter in real time. Throws on non-zero exit.
//
// History: an earlier draft used `runtime.exec()` + dockerode's
// hijacked stream + an end/close event wait. That worked under tsx
// but the bun-compiled binary never observed stream 'end' on
// docker's hijacked socket — the await hung forever and bun
// exited 0 with no diagnostic when the microtask queue drained.
// Shelling out to the docker CLI keeps the boot-strap path
// portable across runtimes; the dockerode-driven lifecycle
// (start/stop/pull/volume) stays on the programmatic path because
// those calls *do* work cleanly under bun.
async function dockerExecStream(
  containerName: string,
  opts: {
    cmd: readonly string[];
    user?: string;
    label: string;
    log: Logger;
  },
): Promise<void> {
  opts.log.info(`[${opts.label}] ${opts.cmd.join(' ')}`);
  const args = ['exec'];
  if (opts.user) args.push('--user', opts.user);
  args.push(containerName, ...opts.cmd);
  await runDockerCli(args);
}

function runDockerCli(args: string[], stdin?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${args[0]} exited with code ${code}`));
    });
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
  });
}

// Quietly run `<kind> --version` and extract a semver-shaped token.
// claude prints `2.1.146 (Claude Code)` (semver leads), codex prints
// `codex-cli 0.132.0` (semver is the second token). A naive first-
// token grab gets fooled by codex's program-name prefix, so we look
// for the first `X.Y.Z` (with optional pre-release / build suffix)
// anywhere in the line. Same convention container/backends/*.sh
// uses for its own backend_version function.
//
// Uses docker CLI (not dockerode) for the same bun-compatibility
// reason as dockerExecStream — see its history comment.
async function probeBackendVersion(
  containerName: string,
  kind: InstallableBackendKind,
): Promise<string | null> {
  try {
    const out = execSync(`docker exec ${containerName} /data/agents/${kind}/bin/${kind} --version`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const match = out.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

// Test seam for the host-creds collectors. Tests provide stub
// platform / homedir / fs reads / keychain lookups so the missing-
// creds and found-creds branches can be exercised without touching
// the real $HOME or macOS Keychain. Production passes nothing and
// each field defaults to the real node:fs / node:os / `security`
// CLI call.
export interface HostCredsEnv {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => Buffer;
  // null => not found (keychain entry absent), throw => lookup failed
  keychainLookup?: (service: string) => string | null;
}

// Per-kind host creds discovery + copy into the container creds
// volume. Throws with a kind-specific hint when --from-host was
// requested but the host has no usable creds — the caller surfaces
// that as a non-zero exit so the operator doesn't end up with a
// runtime container that will fail auth on the first task.
async function copyHostCreds(
  containerName: string,
  kind: InstallableBackendKind,
  log: Logger,
  env: HostCredsEnv = {},
): Promise<void> {
  const files =
    kind === 'claude' ? collectClaudeHostCreds(env) : collectCodexHostCreds(env);
  if (files.length === 0) {
    throw new Error(
      `no host creds found for ${kind}. Expected ${expectedHostCredsHint(kind)}.`,
    );
  }
  for (const f of files) {
    await writeContainerFile(containerName, f.target, f.data);
    log.info(`copied ${kind} creds → ${f.target}`);
  }
}

export function collectClaudeHostCreds(
  env: HostCredsEnv = {},
): Array<{ target: string; data: Buffer }> {
  // macOS: token lives in the Keychain under "Claude Code-credentials";
  // pull it out via `security` (read-only, no mutation). On linux the
  // CLI persists ~/.claude/.credentials.json — read it directly.
  const platform = env.platform ?? process.platform;
  if (platform === 'darwin') {
    const lookup = env.keychainLookup ?? defaultClaudeKeychainLookup;
    let token: string | null;
    try {
      token = lookup('Claude Code-credentials');
    } catch {
      return [];
    }
    if (!token || token.length === 0) return [];
    return [{ target: '/data/creds/claude/.credentials.json', data: Buffer.from(`${token}\n`) }];
  }
  const home = (env.homedir ?? homedir)();
  const existsFn = env.existsSync ?? existsSync;
  const readFn = env.readFileSync ?? readFileSync;
  const linuxPath = join(home, '.claude', '.credentials.json');
  if (existsFn(linuxPath)) {
    return [{ target: '/data/creds/claude/.credentials.json', data: readFn(linuxPath) }];
  }
  return [];
}

export function collectCodexHostCreds(
  env: HostCredsEnv = {},
): Array<{ target: string; data: Buffer }> {
  // codex stores its OAuth token + config in ~/.codex. We pick up
  // auth.json (token) and config.toml (model/provider config) when
  // present — anything else (sessions, cache) is intentionally
  // left behind so the named volume doesn't fill up with stale
  // local state.
  const home = (env.homedir ?? homedir)();
  const existsFn = env.existsSync ?? existsSync;
  const readFn = env.readFileSync ?? readFileSync;
  const out: Array<{ target: string; data: Buffer }> = [];
  const authPath = join(home, '.codex', 'auth.json');
  if (existsFn(authPath)) {
    out.push({ target: '/data/creds/codex/auth.json', data: readFn(authPath) });
  }
  const configPath = join(home, '.codex', 'config.toml');
  if (existsFn(configPath)) {
    out.push({ target: '/data/creds/codex/config.toml', data: readFn(configPath) });
  }
  return out;
}

function defaultClaudeKeychainLookup(service: string): string | null {
  try {
    const out = execSync(`security find-generic-password -s '${service}' -w`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function expectedHostCredsHint(kind: InstallableBackendKind): string {
  if (kind === 'claude') {
    return process.platform === 'darwin'
      ? `a populated macOS Keychain entry named "Claude Code-credentials" ` +
          `(login first with \`claude setup-token\`), ` +
          `or ~/.claude/.credentials.json on linux`
      : `~/.claude/.credentials.json (login first with \`claude setup-token\`)`;
  }
  return `~/.codex/auth.json (login first with \`codex login --device-auth\`)`;
}

// Pipe a small Buffer into `docker exec ... bash -c 'cat > path && chmod 600'`.
// Uses the docker CLI for the same bun-compatibility reason as
// dockerExecStream — dockerode's hijacked-stream stdin pipe is the
// one part of dockerode that doesn't survive bun compilation.
async function writeContainerFile(
  containerName: string,
  targetPath: string,
  data: Buffer,
): Promise<void> {
  await runDockerCli(
    [
      'exec',
      '-i',
      containerName,
      'bash',
      '-c',
      `cat > ${targetPath} && chmod 600 ${targetPath}`,
    ],
    data,
  );
}

function authHintFor(kind: InstallableBackendKind): string {
  if (kind === 'claude') return 'claude setup-token';
  if (kind === 'codex') return 'codex login --device-auth';
  return `<kind>-specific auth command`;
}

// ──────────────────────────────────────────────────────────────────────────
// CLI surface (`vicoop-client container init <kind> [opts]`)
//
// Lives in the same module as the implementation so the command's
// flags + the function's options stay obviously paired. cli.ts only
// imports the top-level `containerCmd` and the dispatcher.
//
// Naming: the operator's mental model for this command is "wire up
// the docker container that hosts my agent CLI" — so the group
// reads as `container ...`, not `backend ...` (which is reserved
// internal vocab in the codebase for the Backend interface +
// BackendKind enum). The agent CLI being installed is still
// identified by its backend kind (claude / codex) as the
// positional argument.
// ──────────────────────────────────────────────────────────────────────────

const BACKEND_KINDS = ['claude', 'codex'] as const;

const containerInitSubCmd = command(
  'init',
  object({
    action: constant('container-init' as const),
    kind: argument(choice([...BACKEND_KINDS], { metavar: 'KIND' }), {
      description: message`Backend agent CLI to install into the runtime container. One of: \`claude\`, \`codex\`.`,
    }),
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
    brief: message`Bootstrap a per-backend runtime container.`,
    description: message`One-shot setup for the container-runtime profile: boots \`vicoop-runtime-<kind>\`, runs install-backend.sh inside it, verifies the installed CLI version against this client's supportedRange, and (with --from-host) copies the operator's existing host creds into the container creds volume. After this, launch the daemon with \`vicoop-client --backend <kind> --runtime container\`.`,
  },
);

export const containerCmd = command(
  'container',
  longestMatch(containerInitSubCmd),
  {
    brief: message`Manage per-backend runtime containers.`,
    description: message`Subcommands: \`init\` (boot \`vicoop-runtime-<kind>\`, install the agent CLI, optionally copy host creds). Pairs with the daemon flag \`--runtime container\` (active backend selected via \`--backend\`).`,
  },
);

export type ContainerCliArgs = InferValue<typeof containerCmd>;
export type ContainerInitArgs = Extract<ContainerCliArgs, { action: 'container-init' }>;

// Adapter from optique-parsed args → runContainerInit's typed
// options. Lives here (not in cli.ts) so the command surface and
// its dispatcher are obviously co-located.
export async function runContainerInitCli(args: ContainerInitArgs): Promise<number> {
  try {
    return await runContainerInit({
      kind: args.kind,
      fromHost: args.fromHost,
      ...(args.image ? { image: args.image } : {}),
      ...(args.bridgeUrl ? { bridgeUrl: args.bridgeUrl } : {}),
    });
  } catch (err) {
    console.error(`container init failed: ${(err as Error).message}`);
    return 1;
  }
}
