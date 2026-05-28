// `vicoop-client container init <kind>` — operator one-shot
// bootstrap for the external-runtime profile (#249 PR C).
//
// Boots the per-backend runtime container, runs the shared
// install-backend.sh recipe inside it, sanity-checks the resulting
// binary against this client's supportedRange manifest, and
// (with --from-host) copies the operator's existing agent CLI
// creds into the container-scoped named volume so the operator can
// immediately go daemon. Without --from-host: if stdin is a TTY,
// runs the agent CLI's interactive auth (claude setup-token /
// codex login --device-auth) in the running container right then;
// otherwise falls back to printing the docker-exec incantation
// the operator can run themselves.
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
import {
  agentsVolumeName,
  containerName,
  credsVolumeName,
  defaultDockerRun,
  RuntimeContainer,
  DEFAULT_RUNTIME_IMAGE,
  RUNTIME_COMPONENT_LABEL,
  RUNTIME_MANAGED_BY_LABEL,
  runtimeInstanceName,
  sessionsVolumeName,
  validateRuntimeName,
  type DockerRun,
} from './runtime-container.js';
import { BACKENDS_MANIFEST, type InstallableBackendKind } from './backends-manifest.js';
import { createLogger, type Logger } from './logger.js';

export interface ContainerInitOptions {
  kind: InstallableBackendKind;
  runtimeName?: string;
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
  // Test seam — inject a stub TTY probe + interactive runner so the
  // auto-login branch can be exercised without a real terminal /
  // docker daemon. Production passes nothing; defaults fall through
  // to process.stdin.isTTY + spawn('docker', argv, {stdio:'inherit'}).
  authRunner?: Partial<AuthRunner>;
  logger?: Logger;
}

export interface AuthRunner {
  isTTY: () => boolean;
  runDockerInteractive: (argv: readonly string[]) => Promise<number>;
}

type RuntimeContainerState = 'running' | 'stopped' | 'missing';

export interface RuntimeListRow {
  kind: InstallableBackendKind;
  name: string;
  container: {
    name: string;
    state: RuntimeContainerState;
    image: string | null;
  };
  volumes: {
    agents: { name: string; present: boolean };
    creds: { name: string; present: boolean };
    sessions: { name: string; present: boolean };
  };
}

export interface ContainerListOptions {
  dockerRun?: DockerRun;
}

export interface ContainerRemoveOptions {
  name: string;
  preserveVolumes: boolean;
  dockerRun?: DockerRun;
}

export interface RuntimeRemoveResult {
  kind: InstallableBackendKind | null;
  name: string;
  container: { name: string; removed: boolean };
  volumes: Array<{ name: string; removed: boolean; skipped: boolean }>;
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
    runtimeName: opts.runtimeName,
    image: opts.image ?? process.env.VICOOP_RUNTIME_IMAGE ?? DEFAULT_RUNTIME_IMAGE,
    bridgeUrl: opts.bridgeUrl,
    createIfMissing: true,
    failIfExists: true,
    logger: opts.logger,
  });

  try {
    await runtime.start();

    const runtimeName = runtimeInstanceName(opts.kind, opts.runtimeName);
    const containerName = containerNameFor(opts.kind, runtimeName);

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
          `The install recipe likely failed silently; rerun \`vicoop-client container init ${opts.kind} --name ${runtimeName}\` and inspect the [install] output.`,
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
            `(${authCommandFor(containerName, opts.kind)}).`,
        );
        return 1;
      }
    } else {
      const autoLogin = await maybeAutoLoginAfterInit(
        containerName,
        opts.kind,
        log,
        opts.authRunner,
      );
      if (autoLogin.exitCode !== 0) return autoLogin.exitCode;
    }

    log.info(`runtime container for ${opts.kind} initialized. start daemon with:`);
    log.info(
      `    vicoop-client --backend ${opts.kind} --runtime container --runtime-name ${runtimeName}`,
    );
    return 0;
  } finally {
    await runtime.stop();
  }
}

function authCommandFor(containerName: string, kind: InstallableBackendKind): string {
  return (
    `docker start ${containerName} >/dev/null && ` +
    `docker exec -it ${containerName} ${authHintFor(kind)} && ` +
    `docker stop ${containerName} >/dev/null`
  );
}

// Decides whether to run the agent CLI's interactive auth flow in
// the freshly-installed runtime container, and runs it inline when
// the operator is on an interactive terminal. Non-TTY callers
// (CI, piped input, automation) fall back to the hint-only path so
// init stays scriptable. Caller in runContainerInit treats a
// non-zero exitCode as a fatal init failure but leaves the runtime
// container in place so the operator can retry the auth without
// re-running install-backend.sh.
export async function maybeAutoLoginAfterInit(
  containerName: string,
  kind: InstallableBackendKind,
  log: Logger,
  runner: Partial<AuthRunner> = {},
): Promise<{ attempted: boolean; exitCode: number }> {
  const isTTY = (runner.isTTY ?? defaultIsTTY)();
  if (!isTTY) {
    log.info(
      `--from-host not set and stdin is not a TTY: leaving creds empty. To auth inside the container run\n` +
        `    ${authCommandFor(containerName, kind)}`,
    );
    return { attempted: false, exitCode: 0 };
  }
  log.info(
    `--from-host not set; starting interactive auth (${authHintFor(kind)}) inside ${containerName}...`,
  );
  const run = runner.runDockerInteractive ?? defaultRunDockerInteractive;
  const code = await run(['exec', '-it', containerName, ...authHintFor(kind).split(' ')]);
  if (code === 0) {
    log.info(`auth complete for ${kind}.`);
    return { attempted: true, exitCode: 0 };
  }
  log.error(
    `interactive auth exited with code ${code}. Runtime container '${containerName}' was left in place; ` +
      `retry with:\n    ${authCommandFor(containerName, kind)}`,
  );
  return { attempted: true, exitCode: 1 };
}

function defaultIsTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function defaultRunDockerInteractive(argv: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', Array.from(argv), { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
}

// Canonical in-container path of the file the backend will read on
// first task. Probed by the daemon at startup (assertContainerCredsPresent)
// so a missing-creds runtime container fails before any task is
// accepted, instead of failing at first spawn with whatever
// backend-specific "not authenticated" error the CLI emits.
export function expectedCredsPath(kind: InstallableBackendKind): string {
  switch (kind) {
    case 'claude':
      return '/data/creds/claude/.credentials.json';
    case 'codex':
      return '/data/creds/codex/auth.json';
  }
}

// Daemon-startup fail-fast probe. Run after RuntimeContainer.start()
// has the container running; checks that the per-kind creds file the
// agent CLI will read actually exists in the creds volume. Throws
// with the same auth-hint container-init prints when --from-host was
// omitted, so the operator's recovery path is identical regardless of
// where they hit the missing-creds case.
export async function assertContainerCredsPresent(
  containerName: string,
  kind: InstallableBackendKind,
  opts: { dockerRun?: DockerRun } = {},
): Promise<void> {
  const dockerRun = opts.dockerRun ?? defaultDockerRun;
  const path = expectedCredsPath(kind);
  const r = dockerRun(['exec', containerName, 'test', '-f', path]);
  if (r.exitCode === 0) return;
  throw new Error(
    `runtime container '${containerName}' has no ${kind} creds at ${path}. ` +
      `Authenticate inside the container, then restart the daemon:\n` +
      `    ${authCommandFor(containerName, kind)}`,
  );
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
    return [{ target: expectedCredsPath('claude'), data: Buffer.from(`${token}\n`) }];
  }
  const home = (env.homedir ?? homedir)();
  const existsFn = env.existsSync ?? existsSync;
  const readFn = env.readFileSync ?? readFileSync;
  const linuxPath = join(home, '.claude', '.credentials.json');
  if (existsFn(linuxPath)) {
    return [{ target: expectedCredsPath('claude'), data: readFn(linuxPath) }];
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
    out.push({ target: expectedCredsPath('codex'), data: readFn(authPath) });
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

export function listRuntimeContainers(opts: ContainerListOptions = {}): RuntimeListRow[] {
  const dockerRun = opts.dockerRun ?? defaultDockerRun;
  const containers = readManagedContainers(dockerRun);
  const volumes = readManagedVolumes(dockerRun);
  const keys = new Set(containers.keys());

  return Array.from(keys)
    .map((key) => parseRuntimeKey(key, containers))
    .sort(compareRuntimeKeys)
    .map(({ kind, runtimeName }) => {
      const key = runtimeKey(runtimeName);
      const expectedContainerName = containerNameFor(kind, runtimeName);
      const container = containers.get(key);
      const runtimeVolumes = volumes.get(key) ?? new Set<string>();
      return {
        kind,
        name: runtimeName,
        container: {
          name: container?.name ?? expectedContainerName,
          state: container ? normalizeContainerState(container.state) : 'missing',
          image: container?.image ?? null,
        },
        volumes: {
          agents: volumePresence(runtimeVolumes, agentsVolumeName(kind, runtimeName)),
          creds: volumePresence(runtimeVolumes, credsVolumeName(kind, runtimeName)),
          sessions: volumePresence(runtimeVolumes, sessionsVolumeName(kind, runtimeName)),
        },
      };
    });
}

export function formatRuntimeList(rows: readonly RuntimeListRow[]): string {
  const table = [
    ['KIND', 'NAME', 'CONTAINER', 'IMAGE', 'AGENTS', 'CREDS', 'SESSIONS'],
    ...rows.map((row) => [
      row.kind,
      row.name,
      row.container.state,
      row.container.image ?? '-',
      presentCell(row.volumes.agents.present),
      presentCell(row.volumes.creds.present),
      presentCell(row.volumes.sessions.present),
    ]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  return table
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd())
    .join('\n');
}

export function formatRuntimeListJson(rows: readonly RuntimeListRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function removeRuntimeContainer(opts: ContainerRemoveOptions): RuntimeRemoveResult {
  const dockerRun = opts.dockerRun ?? defaultDockerRun;
  const runtimeName = validateRuntimeName(opts.name);
  if (!runtimeName) throw new Error('runtime name is required');
  const runtime = findRuntimeByName(dockerRun, runtimeName);
  const kind = runtime?.kind ?? null;
  const containerResourceName = runtime?.container.name ?? runtimeContainerResourceName(runtimeName);
  const volumeNames = runtime
    ? [runtime.volumes.agents.name, runtime.volumes.creds.name, runtime.volumes.sessions.name]
    : [
        runtimeVolumeResourceName('agents', runtimeName),
        runtimeVolumeResourceName('creds', runtimeName),
        runtimeVolumeResourceName('sessions', runtimeName),
      ];
  const result: RuntimeRemoveResult = {
    kind,
    name: runtimeName,
    container: {
      name: containerResourceName,
      removed: removeDockerResource(dockerRun, ['rm', '-f', containerResourceName], 'container'),
    },
    volumes: [],
  };

  for (const volumeName of volumeNames) {
    result.volumes.push({
      name: volumeName,
      removed: opts.preserveVolumes
        ? false
        : removeDockerResource(dockerRun, ['volume', 'rm', volumeName], 'volume'),
      skipped: opts.preserveVolumes,
    });
  }

  return result;
}

function findRuntimeByName(
  dockerRun: DockerRun,
  runtimeName: string,
): RuntimeListRow | null {
  return listRuntimeContainers({ dockerRun }).find((row) => row.name === runtimeName) ?? null;
}

function runtimeContainerResourceName(runtimeName: string): string {
  return `vicoop-runtime-${runtimeName}`;
}

function runtimeVolumeResourceName(
  volume: 'agents' | 'creds' | 'sessions',
  runtimeName: string,
): string {
  return `vicoop-${volume}-${runtimeName}`;
}

export function formatRuntimeRemoveResult(result: RuntimeRemoveResult): string {
  const lines = [
    `${result.container.removed ? 'removed' : 'missing'} container ${result.container.name}`,
  ];
  if (result.volumes.every((v) => v.skipped)) {
    lines.push(
      `kept volumes ${result.volumes.map((v) => v.name).join(', ')}`,
    );
  } else {
    for (const volume of result.volumes) {
      lines.push(`${volume.removed ? 'removed' : 'missing'} volume ${volume.name}`);
    }
  }
  return lines.join('\n');
}

export function formatRuntimeRemoveJson(result: RuntimeRemoveResult): string {
  return JSON.stringify(result, null, 2);
}

function removeDockerResource(
  dockerRun: DockerRun,
  args: readonly string[],
  resource: 'container' | 'volume',
): boolean {
  const r = dockerRun(args);
  const output = `${r.stdout}\n${r.stderr}`;
  if (/No such container|No such volume|not found/i.test(output)) return false;
  if (r.exitCode === 0) return true;
  throw new Error(`docker ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
}

function readManagedContainers(
  dockerRun: DockerRun,
): Map<
  string,
  { kind: InstallableBackendKind; name: string; state: string; image: string | null }
> {
  const result = new Map<
    string,
    { kind: InstallableBackendKind; name: string; state: string; image: string | null }
  >();
  for (const args of [
    [
      'ps',
      '-a',
      '--filter',
      `label=${RUNTIME_MANAGED_BY_LABEL}`,
      '--filter',
      `label=${RUNTIME_COMPONENT_LABEL}`,
      '--format',
      '{{json .}}',
    ],
    [
      'ps',
      '-a',
      '--filter',
      'name=^vicoop-runtime-',
      '--format',
      '{{json .}}',
    ],
  ] as const) {
    const r = dockerRun(args);
    if (r.exitCode !== 0) {
      throw new Error(`docker ps failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    for (const entry of parseDockerJsonLines(r.stdout, 'docker ps')) {
      const name = stringField(entry, 'Names') ?? stringField(entry, 'Name');
      if (!name) continue;
      const labels = parseDockerLabels(stringField(entry, 'Labels'));
      const runtime = runtimeFromLabelsOrName(labels, name, 'container');
      if (!runtime) continue;
      result.set(runtimeKey(runtime.runtimeName), {
        kind: runtime.kind,
        name,
        state: stringField(entry, 'State') ?? '',
        image: stringField(entry, 'Image'),
      });
    }
  }
  return result;
}

function readManagedVolumes(dockerRun: DockerRun): Map<string, Set<string>> {
  const r = dockerRun([
    'volume',
    'ls',
    '--format',
    '{{json .}}',
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`docker volume ls failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }

  const result = new Map<string, Set<string>>();
  for (const entry of parseDockerJsonLines(r.stdout, 'docker volume ls')) {
    const name = stringField(entry, 'Name');
    if (!name) continue;
    const labels = parseDockerLabels(stringField(entry, 'Labels'));
    const runtime = runtimeFromLabelsOrName(labels, name, 'volume');
    if (!runtime) continue;
    const key = runtimeKey(runtime.runtimeName);
    const names = result.get(key) ?? new Set<string>();
    names.add(name);
    result.set(key, names);
  }
  return result;
}

function parseDockerJsonLines(stdout: string, command: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch (e) {
      throw new Error(`${command} returned invalid JSON: ${(e as Error).message}`);
    }
  }
  return rows;
}

function normalizeContainerState(state: string): RuntimeContainerState {
  return state === 'running' ? 'running' : 'stopped';
}

function volumePresence(
  volumes: Set<string>,
  name: string,
): RuntimeListRow['volumes']['agents'] {
  return { name, present: volumes.has(name) };
}

function presentCell(present: boolean): string {
  return present ? 'yes' : 'no';
}

function stringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function containerNameFor(kind: InstallableBackendKind, runtimeName: string): string {
  return containerName(kind, runtimeName);
}

function runtimeKey(runtimeName: string): string {
  return runtimeName;
}

function parseRuntimeKey(
  key: string,
  containers: Map<string, { kind: InstallableBackendKind }>,
): { kind: InstallableBackendKind; runtimeName: string } {
  const container = containers.get(key);
  if (!container) throw new Error(`runtime '${key}' disappeared while listing`);
  return { kind: container.kind, runtimeName: key };
}

function compareRuntimeKeys(
  a: { kind: InstallableBackendKind; runtimeName: string },
  b: { kind: InstallableBackendKind; runtimeName: string },
): number {
  const kindDiff = BACKEND_KINDS.indexOf(a.kind) - BACKEND_KINDS.indexOf(b.kind);
  if (kindDiff !== 0) return kindDiff;
  return a.runtimeName.localeCompare(b.runtimeName);
}

function parseDockerLabels(raw: string | null): Map<string, string> {
  const labels = new Map<string, string>();
  if (!raw) return labels;
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    labels.set(part.slice(0, idx), part.slice(idx + 1));
  }
  return labels;
}

function runtimeFromLabelsOrName(
  labels: Map<string, string>,
  resourceName: string,
  resource: 'container' | 'volume',
): { kind: InstallableBackendKind; runtimeName: string } | null {
  const kindLabel = labels.get('vicoop.kind');
  const kind =
    kindLabel && (BACKEND_KINDS as readonly string[]).includes(kindLabel)
      ? (kindLabel as InstallableBackendKind)
      : parseKindFromResourceName(resourceName, resource);
  if (!kind) return null;
  const rawName = labels.get('vicoop.name');
  if (rawName) {
    const runtimeName = validateRuntimeName(rawName);
    if (runtimeName) return { kind, runtimeName };
  }
  const runtimeName = parseRuntimeNameFromResourceName(resourceName, kind, resource);
  return runtimeName ? { kind, runtimeName } : null;
}

function parseKindFromResourceName(
  name: string,
  resource: 'container' | 'volume',
): InstallableBackendKind | null {
  for (const kind of BACKEND_KINDS) {
    if (resource === 'container') {
      if (name === containerName(kind) || name.startsWith(`${containerName(kind)}-`)) return kind;
      continue;
    }
    for (const prefix of ['vicoop-agents', 'vicoop-creds', 'vicoop-sessions']) {
      const base = `${prefix}-${kind}`;
      if (name === base || name.startsWith(`${base}-`)) return kind;
    }
  }
  return null;
}

function parseRuntimeNameFromResourceName(
  name: string,
  kind: InstallableBackendKind,
  resource: 'container' | 'volume',
): string | null {
  const bases =
    resource === 'container'
      ? [containerName(kind)]
      : [
          agentsVolumeName(kind),
          credsVolumeName(kind),
          sessionsVolumeName(kind),
        ];
  for (const base of bases) {
    if (name === base) return kind;
    if (name.startsWith(`${base}-`)) return validateRuntimeName(name.slice(base.length + 1)) ?? null;
  }
  return null;
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
    name: optional(
      option('--name', string({ metavar: 'NAME' }), {
        description: message`Runtime instance name. Omit to use the backend kind as the generated name.`,
      }),
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
    brief: message`Bootstrap a per-backend runtime container.`,
    description: message`One-shot setup for the container-runtime profile: creates \`vicoop-runtime-<name>\`, where --name defaults to the backend kind, fails if that runtime already exists, runs install-backend.sh inside it, verifies the installed CLI version against this client's supportedRange, and (with --from-host) copies the operator's existing host creds into the container creds volume. After this, launch the daemon with \`vicoop-client --backend <kind> --runtime container --runtime-name <name>\`.`,
  },
);

// `ls` / `rm` are registered as hidden aliases of `list` / `remove` so help
// only shows the canonical long form. They still parse and still surface in
// "did you mean?" suggestions.

function containerListCommand(name: 'list' | 'ls', alias: boolean) {
  return command(
    name,
    object({
      action: constant('container-list' as const),
      json: withDefault(flag('--json', {
        description: message`Emit machine-readable JSON.`,
      }), false),
    }),
    {
      brief: message`List runtime containers and volumes. (alias: \`ls\`)`,
      description: message`Prints one row per managed runtime container, showing its kind, name, running state, image, and volume presence.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const containerListSubCmd = longestMatch(
  containerListCommand('list', false),
  containerListCommand('ls', true),
);

function containerRemoveCommand(name: 'remove' | 'rm', alias: boolean) {
  return command(
    name,
    object({
      action: constant('container-remove' as const),
      name: argument(string({ metavar: 'NAME' }), {
        description: message`Runtime instance name to remove.`,
      }),
      preserveVolumes: withDefault(flag('--preserve-volumes', {
        description: message`Keep the runtime's agents, creds, and sessions named volumes. Off by default so cleanup removes all runtime Docker resources.`,
      }), false),
      json: withDefault(flag('--json', {
        description: message`Emit machine-readable JSON.`,
      }), false),
    }),
    {
      brief: message`Remove a runtime container. (alias: \`rm\`)`,
      description: message`Removes a runtime container and its agents, creds, and sessions volumes by name. Pass --preserve-volumes to keep the volumes.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const containerRemoveSubCmd = longestMatch(
  containerRemoveCommand('remove', false),
  containerRemoveCommand('rm', true),
);

export const containerCmd = command(
  'container',
  longestMatch(containerInitSubCmd, containerListSubCmd, containerRemoveSubCmd),
  {
    brief: message`Manage per-backend runtime containers.`,
    description: message`Subcommands: \`init\` (boot \`vicoop-runtime-<name>\`, install the agent CLI, optionally copy host creds), \`list\` (show managed runtime container and volume state), \`remove\` (remove a runtime container and volumes by name). Pairs with the daemon flag \`--runtime container\` (active backend selected via \`--backend\`).`,
    hidden: 'usage',
  },
);

export type ContainerCliArgs = InferValue<typeof containerCmd>;
export type ContainerInitArgs = Extract<ContainerCliArgs, { action: 'container-init' }>;
export type ContainerListArgs = Extract<ContainerCliArgs, { action: 'container-list' }>;
export type ContainerRemoveArgs = Extract<ContainerCliArgs, { action: 'container-remove' }>;

// Adapter from optique-parsed args → runContainerInit's typed
// options. Lives here (not in cli.ts) so the command surface and
// its dispatcher are obviously co-located.
export async function runContainerInitCli(args: ContainerInitArgs): Promise<number> {
  try {
    return await runContainerInit({
      kind: args.kind,
      runtimeName: args.name,
      fromHost: args.fromHost,
      ...(args.image ? { image: args.image } : {}),
      ...(args.bridgeUrl ? { bridgeUrl: args.bridgeUrl } : {}),
    });
  } catch (err) {
    console.error(`container init failed: ${(err as Error).message}`);
    return 1;
  }
}

export async function runContainerListCli(args: ContainerListArgs): Promise<number> {
  try {
    const rows = listRuntimeContainers();
    process.stdout.write((args.json ? formatRuntimeListJson(rows) : formatRuntimeList(rows)) + '\n');
    return 0;
  } catch (err) {
    console.error(`container ls failed: ${(err as Error).message}`);
    return 1;
  }
}

export async function runContainerRemoveCli(args: ContainerRemoveArgs): Promise<number> {
  try {
    const result = removeRuntimeContainer({
      name: args.name,
      preserveVolumes: args.preserveVolumes,
    });
    process.stdout.write(
      (args.json ? formatRuntimeRemoveJson(result) : formatRuntimeRemoveResult(result)) + '\n',
    );
    return 0;
  } catch (err) {
    console.error(`container rm failed: ${(err as Error).message}`);
    return 1;
  }
}
