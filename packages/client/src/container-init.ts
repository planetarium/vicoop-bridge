import { callerContainerCommands } from './caller-runtime-admin.js';
import { assertBrokerContainer } from './execution-runtime-boundary.js';
import { CLAUDE_SESSION_MIGRATION, CODEX_SESSION_MIGRATION } from './claude-session-migration.js';
import { execSync } from 'node:child_process';
import { runCallerContainerInit } from './caller-container-init.js';
export { runCallerContainerInit as runContainerInit } from './caller-container-init.js';
export type { CallerContainerInitOptions as ContainerInitOptions } from './caller-container-init.js';
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
  RUNTIME_COMPONENT_LABEL,
  RUNTIME_MANAGED_BY_LABEL,
  runtimeInstanceName,
  sessionsVolumeName,
  validateRuntimeName,
  type DockerRun,
} from './runtime-container.js';
import { type InstallableBackendKind } from './backends-manifest.js';
import { type Logger } from './logger.js';

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

// Credentials remain in their original volume. A restricted, networkless
// maintenance helper copies selected session records into the new config dir.
export async function migrateBrokerSessions(kind:InstallableBackendKind, runtimeName: string, image: string, log: Logger): Promise<void> {
  const legacy = credsVolumeName(kind, runtimeName);
  if (defaultDockerRun(['volume', 'inspect', legacy]).exitCode !== 0) return;
  const result = defaultDockerRun(['run', '--rm', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
    '--mount', `type=volume,source=${legacy},target=/legacy,readonly`,
    '--mount', `type=volume,source=${sessionsVolumeName(kind, runtimeName)},target=/sessions`,
    '--entrypoint', '/usr/local/bin/node', image, '-e', kind==='claude' ? CLAUDE_SESSION_MIGRATION : CODEX_SESSION_MIGRATION]);
  if (result.exitCode !== 0) throw new Error('Session migration failed; legacy volume is unchanged. Inspect the destination for incompatible files or permissions.');
  log.info('Legacy conversation records copied where absent; credentials and settings remain detached.');
}

// Quietly run `<kind> --version` and extract a semver-shaped token.
// claude prints `2.1.146 (Claude Code)` (semver leads), codex prints
// `codex-cli 0.132.0` (semver is the second token). A naive first-
// token grab gets fooled by codex's program-name prefix, so we look
// for the first `X.Y.Z` (with optional pre-release / build suffix)
// anywhere in the line. Same convention container/backends/*.sh
// uses for its own backend_version function.
//
// Retained for legacy runtime inspection.
export async function probeBackendVersion(
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
      removed: removeDockerResource(dockerRun, ['rm', '-f', containerResourceName]),
    },
    volumes: [],
  };

  for (const volumeName of volumeNames) {
    result.volumes.push({
      name: volumeName,
      removed: opts.preserveVolumes
        ? false
        : removeDockerResource(dockerRun, ['volume', 'rm', volumeName]),
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

// Read-only validation also protects harness injection before docker start/exec.
export function validateRuntimeBoundary(kind: InstallableBackendKind, name?: string, run: DockerRun = defaultDockerRun): void {
  const runtime = runtimeInstanceName(kind, name);
  const result = run(['inspect', '--format', '{{json .}}', containerName(kind, runtime)]);
  if (result.exitCode !== 0) throw new Error('Cannot inspect runtime authentication boundary');
  assertBrokerContainer(result.stdout, kind, runtime);
}

const containerValidateSubCmd = command('validate', object({
  action: constant('container-validate' as const),
  kind: argument(choice([...BACKEND_KINDS], {metavar: 'KIND'})),
  name: optional(option('--name', string({metavar: 'NAME'}))),
}), {brief: message`Check the host-broker authentication boundary without starting the runtime.`});

const containerInitSubCmd = command(
  'init',
  object({
    action: constant('container-init' as const),
    kind: argument(choice([...BACKEND_KINDS], { metavar: 'KIND' })),
    config: optional(option('--config', string({ metavar: 'PATH' }), {
      description: message`Registered agent config to update; defaults to the canonical config.json.`,
    })),
    image: optional(option('--image', string({ metavar: 'IMAGE' }), {
      description: message`Backend-installed image tag or digest. Pull if missing, validate and save its immutable image ID. Omit to build the bundled image or reuse the configured image.`,
    })),
    stateDirectory: optional(option('--state-directory', string({ metavar: 'PATH' }), {
      description: message`Private caller state directory. Defaults to an agent/backend-specific path beside config.json; existing paths are preserved.`,
    })),
    rebuild: withDefault(flag('--rebuild', {
      description: message`Build the bundled image again instead of reusing the configured image.`,
    }), false),
    fromHost: withDefault(flag('--from-host', {
      description: message`Accepted for compatibility. Authentication always stays on the host.`,
    }), false),
    // Parse retired options to report a useful migration error rather than silently ignore them.
    name: optional(option('--name', string(), { hidden: 'help' })),
    workspaceDir: optional(option('--workspace', string(), { hidden: 'help' })),
    reuseState: withDefault(flag('--reuse-state', { hidden: 'help' }), false),
    bridgeUrl: optional(option('--bridge', string(), { hidden: 'help' })),
  }),
  {
    brief: message`Prepare per-caller container execution and save agent configuration.`,
    description: message`Checks host authentication, builds the bundled backend image (no repository checkout needed) or validates --image, initializes private SQLite state and saves runtime settings in the registered agent config. Existing settings and credentials are preserved; legacy cwd/runtime_name are removed after successful validation. Caller containers are allocated on their first request.`,
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
  longestMatch(
    containerInitSubCmd,
    command('legacy', longestMatch(containerListSubCmd, containerRemoveSubCmd, containerValidateSubCmd), {
      brief: message`Manage legacy shared per-backend containers only.`,
    }),
    callerContainerCommands,
  ),
  {
    brief: message`Initialize, inspect and manage per-caller containers.`,
    description: message`init prepares the image and configuration; list/validate/recreate/remove manage caller resources while the daemon is stopped. --config defaults to the canonical config.json. Legacy shared-container tools are under container legacy.`,
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
    if (args.name !== undefined || args.workspaceDir !== undefined || args.reuseState || args.bridgeUrl !== undefined)
      throw new Error('container init now prepares per-caller execution; --name/--workspace/--reuse-state/--bridge are retired. Use --config, --image and --state-directory instead.');
    return await runCallerContainerInit({
      kind: args.kind,
      configPath: args.config,
      stateDirectory: args.stateDirectory,
      image: args.image,
      rebuild: args.rebuild,
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

export async function runContainerValidateCli(
  args: Extract<ContainerCliArgs, {action: 'container-validate'}>,
  run: DockerRun = defaultDockerRun,
): Promise<number> {
  try {
    validateRuntimeBoundary(args.kind, args.name, run);
    return 0;
  } catch (err) {
    console.error(`container validate failed: ${(err as Error).message}`);
    return 1;
  }
}
