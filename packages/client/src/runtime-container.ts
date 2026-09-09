// Lifecycle wrapper around the external-runtime container (#249).
//
// One RuntimeContainer instance owns one long-lived Docker container —
// per-backend (claude / codex / …), per-bridge-client process. Wiring:
//
//   bridge client startup
//     → pickBackend (cli.ts) decides runtime = 'container'
//       → new RuntimeContainer({ backendKind, ... }).start()
//         - pings docker daemon (Decision §6)
//         - looks for an existing container by canonical name; reuses
//           if found, otherwise fails with an init hint
//         - starts a stopped container (firewall + sleep infinity from
//           container/runtime/entrypoint.sh in PR A)
//       → wires a docker-exec SpawnAdapter (spawn-adapter.ts) into the
//         backend factory; backend sees a normal SpawnFn signature
//   bridge client shutdown
//     → backend.stop() → runtime.stop() awaited
//
// Lifecycle commands use the asynchronous `docker` CLI rather than
// dockerode. The one-shot listing/removal runner remains synchronous. The hijack
// stream parts already shelled out to the CLI because of
// oven-sh/bun#22412; once the hijack path was off the table the
// remaining dockerode lifecycle calls were carrying ssh2 /
// cpu-features as transitive native deps for no functional reason
// beyond Decision §1's original "dockerode (programmatic API)" pick.
// Going all-CLI drops that whole native-build surface and means
// `docker context` is resolved by the CLI itself — no custom socket
// path lookup needed.

import { spawnSync } from 'node:child_process';
import { runDockerCommand, type AsyncDockerRun } from './docker-command.js';
import { createLogger, type Logger } from './logger.js';

export const DEFAULT_RUNTIME_IMAGE = 'ghcr.io/planetarium/vicoop-runtime:latest';

export const RUNTIME_MANAGED_BY_LABEL = 'vicoop.managed-by=vicoop-bridge';
export const RUNTIME_COMPONENT_LABEL = 'vicoop.component=runtime';

export interface RuntimeContainerOptions {
  // Which backend this container hosts. Stored as metadata and used for
  // backend-specific install paths inside the shared runtime image.
  backendKind: string;
  // Runtime instance name. Omitted means the backend kind is used as the
  // generated name, so identity stays name-based without an unnamed mode.
  runtimeName?: string;
  // OCI image to run. Defaults to DEFAULT_RUNTIME_IMAGE; env override
  // `VICOOP_RUNTIME_IMAGE` is resolved by the caller (cli.ts) so this
  // module stays env-clean.
  image?: string;
  // Host directory bind-mounted as the agent's workspace at /workspace.
  workspaceDir?: string;
  // Bridge WS URL forwarded into the container so init-firewall.sh's
  // outbound allowlist resolves the same host the bridge client speaks
  // to.
  bridgeUrl?: string;
  // Skip the in-container firewall init. Mostly a dev / CI escape
  // hatch; production runs should leave this off and pass NET_ADMIN.
  skipFirewall?: boolean;
  // Creation is intentionally opt-in. Daemon startup should only
  // consume a runtime container the operator already initialized with
  // `vicoop-client container init <kind>`.
  createIfMissing?: boolean;
  // When creating from `container init`, fail if the target container
  // or any canonical volume already exists. This keeps init as a
  // fresh-create command instead of silently reinstalling into an
  // existing runtime.
  failIfExists?: boolean;
  logger?: Logger;
  // Test seam — inject a custom docker CLI runner so tests can
  // capture argv + script responses without shelling out.
  dockerRun?: AsyncDockerRun;
}

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DockerRun = (args: readonly string[]) => DockerResult;

export function defaultDockerRun(args: readonly string[]): DockerResult {
  // Synchronous compatibility path for one-shot container list/remove commands.
  // Daemon startup and RuntimeContainer lifecycle use runDockerCommand instead.
  const r = spawnSync('docker', Array.from(args), { encoding: 'utf8', timeout: 30_000 });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status ?? -1,
  };
}

export function validateRuntimeName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(trimmed)) {
    throw new Error(
      `runtime name must match [a-z0-9][a-z0-9_.-]{0,31}; got '${name}'`,
    );
  }
  return trimmed;
}

export function defaultRuntimeName(kind: string): string {
  const name = validateRuntimeName(kind);
  if (!name) throw new Error(`backend kind '${kind}' cannot be used as a runtime name`);
  return name;
}

export function runtimeInstanceName(kind: string, name: string | undefined): string {
  return validateRuntimeName(name) ?? defaultRuntimeName(kind);
}

export function containerName(kind: string, runtimeName?: string): string {
  return `vicoop-runtime-${runtimeInstanceName(kind, runtimeName)}`;
}
export function agentsVolumeName(kind: string, runtimeName?: string): string {
  return `vicoop-agents-${runtimeInstanceName(kind, runtimeName)}`;
}
export function credsVolumeName(kind: string, runtimeName?: string): string {
  return `vicoop-creds-${runtimeInstanceName(kind, runtimeName)}`;
}
export function sessionsVolumeName(kind: string, runtimeName?: string): string {
  return `vicoop-sessions-${runtimeInstanceName(kind, runtimeName)}`;
}

export class RuntimeContainer {
  private readonly opts: Required<Pick<RuntimeContainerOptions, 'backendKind' | 'image' | 'runtimeName'>> &
    RuntimeContainerOptions;
  private readonly log: Logger;
  private readonly run: AsyncDockerRun;
  private started = false;

  constructor(opts: RuntimeContainerOptions) {
    this.opts = {
      ...opts,
      runtimeName: runtimeInstanceName(opts.backendKind, opts.runtimeName),
      image: opts.image ?? DEFAULT_RUNTIME_IMAGE,
    };
    this.log = opts.logger ?? createLogger();
    this.run = opts.dockerRun ?? runDockerCommand;
  }

  // Boots the runtime container, awaiting readiness without blocking the event loop. Resolves
  // with no value; on any failure throws — callers should let the
  // exception propagate so the daemon exits with a clear error rather
  // than degrade silently.
  async start(): Promise<void> {
    await this.ensureDaemonReachable();

    const name = containerName(this.opts.backendKind, this.opts.runtimeName);
    if (await this.findContainer(name)) {
      if (this.opts.failIfExists) {
        throw new Error(
          `runtime container '${name}' already exists. ` +
            `Remove it first with \`${this.removeHint()}\`, then rerun init.`,
        );
      }
      if (await this.inspectRunning(name)) {
        this.log.info(`runtime container '${name}' already running — reusing`);
      } else {
        this.log.info(`runtime container '${name}' exists but stopped — starting`);
        await this.runDocker(['start', name]);
      }
    } else {
      if (!this.opts.createIfMissing) {
        throw new Error(
          `runtime container '${name}' does not exist. ` +
            `Create it first with \`vicoop-client container init ${this.opts.backendKind} --name ${this.opts.runtimeName}\`, ` +
            `then retry \`vicoop-client --backend ${this.opts.backendKind} --runtime container --runtime-name ${this.opts.runtimeName}\`.`,
        );
      }
      if (this.opts.failIfExists) {
        await this.ensureFreshVolumes();
      }
      await this.ensureImage();
      await this.ensureVolumes();
      await this.createContainer(name);
      await this.runDocker(['start', name]);
      this.log.info(`runtime container '${name}' created and started`);
    }

    await this.waitUntilRunning(name);
    this.started = true;
  }

  // Best-effort container stop. Awaited from the daemon's signal
  // handler so an orderly shutdown actually ends with the container
  // stopped. Already-stopped / missing containers are tolerated.
  async stop(): Promise<void> {
    const name = containerName(this.opts.backendKind, this.opts.runtimeName);
    const r = await this.run(['stop', '-t', '10', name]);
    if (r.exitCode === 0) {
      this.log.info(`runtime container '${name}' stopped`);
      return;
    }
    // Docker CLI emits "is not running" / "No such container" as
    // non-zero — both are no-ops for us.
    if (/is not running|No such container/i.test(r.stderr)) return;
    this.log.warn(
      `runtime container stop failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
    );
  }

  // Canonical container name. Used by spawn-adapter to build the
  // `docker exec` argv for each per-task spawn.
  getContainerName(): string {
    return containerName(this.opts.backendKind, this.opts.runtimeName);
  }

  // ──────────────────────────────────────────────────────────────────
  private async runDocker(args: readonly string[]): Promise<DockerResult> {
    const r = await this.run(args);
    if (r.exitCode !== 0) {
      throw new Error(
        `docker ${args[0]} failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
      );
    }
    return r;
  }

  private async ensureDaemonReachable(): Promise<void> {
    // `docker version --format '{{.Server.Version}}'` exits non-zero
    // when the daemon is unreachable and prints a stderr line we
    // forward verbatim into the operator-facing message.
    const r = await this.run(['version', '--format', '{{.Server.Version}}']);
    if (r.exitCode !== 0 || r.stdout.trim().length === 0) {
      throw new Error(
        `docker daemon is not reachable (${r.stderr.trim() || `exit ${r.exitCode}`}). ` +
          `The container runtime profile requires a local docker daemon. ` +
          `Switch to runtime: 'host' for this backend, or start docker and retry.`,
      );
    }
  }

  private async ensureImage(): Promise<void> {
    const image = this.opts.image;
    const inspect = await this.run(['image', 'inspect', image]);
    if (inspect.exitCode === 0) return;
    this.log.info(`pulling runtime image ${image}`);
    const r = await this.run(['pull', image], {
      inheritOutput: true,
      timeoutMs: 10 * 60_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(`docker pull ${image} failed (exit ${r.exitCode})`);
    }
  }

  private async ensureVolumes(): Promise<void> {
    const kind = this.opts.backendKind;
    const runtimeName = this.opts.runtimeName;
    for (const name of this.volumeNames()) {
      const inspect = await this.run(['volume', 'inspect', name]);
      if (inspect.exitCode === 0) continue;
      await this.runDocker([
        'volume',
        'create',
        '--label',
        RUNTIME_MANAGED_BY_LABEL,
        '--label',
        RUNTIME_COMPONENT_LABEL,
        '--label',
        `vicoop.kind=${kind}`,
        '--label',
        `vicoop.name=${runtimeName}`,
        name,
      ]);
      this.log.info(`created named volume '${name}'`);
    }
  }

  private async ensureFreshVolumes(): Promise<void> {
    const existing: string[] = [];
    for (const name of this.volumeNames()) {
      if ((await this.run(['volume', 'inspect', name])).exitCode === 0) existing.push(name);
    }
    if (existing.length === 0) return;
    throw new Error(
      `runtime volumes already exist: ${existing.join(', ')}. ` +
        `Remove them first with \`${this.removeHint()}\`, then rerun init.`,
    );
  }

  private volumeNames(): string[] {
    const kind = this.opts.backendKind;
    const runtimeName = this.opts.runtimeName;
    return [
      agentsVolumeName(kind, runtimeName),
      credsVolumeName(kind, runtimeName),
      sessionsVolumeName(kind, runtimeName),
    ];
  }

  private async findContainer(name: string): Promise<boolean> {
    // Anchored regex (`^…$`) so `vicoop-runtime-codex` doesn't false-
    // positive on a hypothetical `vicoop-runtime-codex-2`.
    const r = await this.run([
      'ps',
      '-a',
      '--filter',
      `name=^${name}$`,
      '--format',
      '{{.ID}}',
    ]);
    return r.exitCode === 0 && r.stdout.trim().length > 0;
  }

  private async inspectRunning(name: string): Promise<boolean> {
    const r = await this.run(['inspect', '--format', '{{.State.Running}}', name]);
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  }

  private async createContainer(name: string): Promise<void> {
    const kind = this.opts.backendKind;
    const runtimeName = this.opts.runtimeName;
    const args: string[] = [
      'create',
      '--name',
      name,
      // Decision §2 — daemon-side belt to the bridge-client's
      // health-check braces.
      '--restart',
      'unless-stopped',
      // NET_ADMIN / NET_RAW let init-firewall.sh program iptables
      // inside the container. Without them the entrypoint logs a
      // warning and skips the allowlist; we add them by default so
      // outbound isolation is on out of the box.
      '--cap-add',
      'NET_ADMIN',
      '--cap-add',
      'NET_RAW',
      '--label',
      RUNTIME_MANAGED_BY_LABEL,
      '--label',
      RUNTIME_COMPONENT_LABEL,
      '--label',
      `vicoop.kind=${kind}`,
      '--label',
      `vicoop.name=${runtimeName}`,
    ];
    if (this.opts.bridgeUrl) {
      args.push('-e', `VICOOP_BRIDGE_URL=${this.opts.bridgeUrl}`);
    }
    if (this.opts.skipFirewall) {
      args.push('-e', 'VICOOP_SKIP_FIREWALL=1');
    }
    // Per-kind named volumes — keeps the bridge-client-driven
    // /data/agents/<kind>, /data/creds/<kind>, /data/sessions/<kind>
    // persistent across container re-creation. Decisions §4, §5.
    args.push(
      '--mount',
      `type=volume,source=${agentsVolumeName(kind, runtimeName)},target=/data/agents/${kind}`,
      '--mount',
      `type=volume,source=${credsVolumeName(kind, runtimeName)},target=/data/creds/${kind}`,
      '--mount',
      `type=volume,source=${sessionsVolumeName(kind, runtimeName)},target=/data/sessions/${kind}`,
    );
    if (this.opts.workspaceDir) {
      // Workspace as a host bind-mount. Per-context branching
      // (a different workspace per task) is intentionally out of
      // scope for this PR — see #249's non-goals.
      args.push(
        '--mount',
        `type=bind,source=${this.opts.workspaceDir},target=/workspace`,
      );
    }
    args.push(this.opts.image);
    await this.runDocker(args);
  }

  private removeHint(): string {
    return `vicoop-client container rm ${this.opts.runtimeName}`;
  }

  private async waitUntilRunning(name: string): Promise<void> {
    const start = Date.now();
    const timeoutMs = 10_000;
    while (Date.now() - start < timeoutMs) {
      const r = await this.run(['inspect', '--format', '{{.State.Status}}', name], {
        timeoutMs: Math.max(1, timeoutMs - (Date.now() - start)),
      });
      if (r.exitCode === 0) {
        const status = r.stdout.trim();
        if (status === 'running') return;
        if (status === 'exited' || status === 'dead') {
          throw new Error(
            `runtime container entered terminal state '${status}' before becoming ready`,
          );
        }
      }
      await sleep(200);
    }
    throw new Error(`runtime container did not become ready within ${timeoutMs}ms`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
