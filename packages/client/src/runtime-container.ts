// Lifecycle wrapper around the external-runtime container (#249).
//
// One RuntimeContainer instance owns one long-lived Docker container —
// per-backend (claude / codex / …), per-bridge-client process. Wiring:
//
//   bridge client startup
//     → pickBackend (cli.ts) decides runtime = 'container'
//       → new RuntimeContainer({ backendKind, ... }).start()
//         - pings docker daemon (Decision §6)
//         - ensures named volumes exist (creds, sessions)
//         - looks for an existing container by canonical name; reuses
//           if found, otherwise pulls the image and creates a new one
//         - starts the container (firewall + sleep infinity from
//           container/runtime/entrypoint.sh in PR A)
//       → wires a docker-exec SpawnAdapter (spawn-adapter.ts) into the
//         backend factory; backend sees a normal SpawnFn signature
//   bridge client shutdown
//     → backend.stop() → runtime.stop() fire-and-forget
//       (docker --restart unless-stopped will not auto-restart after
//       an explicit `docker stop`, matching expected operator UX)
//
// Containers are intentionally named so a daemon restart finds the
// previous container instead of leaving orphans behind. The
// `vicoop-runtime-<kind>` shape keeps it human-readable and easy to
// `docker exec` / `docker logs` into from the host.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import type { Container, ContainerInspectInfo, DockerOptions, Exec } from 'dockerode';
import { createLogger, type Logger } from './logger.js';

export const DEFAULT_RUNTIME_IMAGE = 'ghcr.io/planetarium/vicoop-runtime:latest';

export interface RuntimeContainerOptions {
  // Which backend this container hosts. Used in the canonical
  // container/volume names so claude and codex get isolated runtimes.
  backendKind: string;
  // OCI image to run. Defaults to DEFAULT_RUNTIME_IMAGE; env override
  // `VICOOP_RUNTIME_IMAGE` is resolved by the caller (cli.ts) so this
  // module stays env-clean.
  image?: string;
  // Host directory bind-mounted as the agent's workspace at /workspace.
  // Optional — `claude --cwd` and `codex --cwd` can also point inside
  // the container's /workspace once we land per-context branching
  // (separate issue).
  workspaceDir?: string;
  // Bridge WS URL forwarded into the container so init-firewall.sh's
  // outbound allowlist resolves the same host the bridge client speaks
  // to.
  bridgeUrl?: string;
  // Skip the in-container firewall init. Mostly a dev / CI escape
  // hatch; production runs should leave this off and pass NET_ADMIN.
  skipFirewall?: boolean;
  logger?: Logger;
  // Test seam — inject a stub Docker client so unit tests don't need
  // a live daemon.
  docker?: Docker;
}

function containerName(kind: string): string {
  return `vicoop-runtime-${kind}`;
}
function credsVolumeName(kind: string): string {
  return `vicoop-creds-${kind}`;
}
function sessionsVolumeName(kind: string): string {
  return `vicoop-sessions-${kind}`;
}

export class RuntimeContainer {
  private readonly docker: Docker;
  private readonly opts: Required<Pick<RuntimeContainerOptions, 'backendKind' | 'image'>> &
    RuntimeContainerOptions;
  private readonly log: Logger;
  private container?: Container;
  private started = false;

  constructor(opts: RuntimeContainerOptions) {
    this.opts = {
      ...opts,
      image: opts.image ?? DEFAULT_RUNTIME_IMAGE,
    };
    // dockerode's zero-arg constructor picks the platform default
    // (unix:///var/run/docker.sock on linux/mac). We don't pass an
    // explicit socket path so DOCKER_HOST env still wins for operators
    // running rootless / podman-with-docker-shim.
    this.docker = opts.docker ?? new Docker(resolveDockerOptions());
    this.log = opts.logger ?? createLogger();
  }

  // Boots the runtime container, blocking until it's running. Resolves
  // with no value; on any failure throws — callers should let the
  // exception propagate so the daemon exits with a clear error rather
  // than degrade silently.
  async start(): Promise<void> {
    await this.ensureDaemonReachable();
    await this.ensureImage();
    await this.ensureVolumes();

    const name = containerName(this.opts.backendKind);
    const existing = await this.findContainerByName(name);
    if (existing) {
      // Reuse path: a previous bridge-client process (or a manual
      // operator run) left a container with the same canonical name.
      // We inspect first to decide whether to just start it or
      // re-create — re-create only when something runtime-affecting
      // (image, mounts) drifted, which we keep out of scope for PR B.
      // Today: reuse and start if stopped.
      this.container = this.docker.getContainer(existing.Id);
      const info = await this.container.inspect();
      if (!info.State.Running) {
        this.log.info(`runtime container '${name}' exists but stopped — starting`);
        await this.container.start();
      } else {
        this.log.info(`runtime container '${name}' already running — reusing`);
      }
    } else {
      this.container = await this.createContainer(name);
      await this.container.start();
      this.log.info(`runtime container '${name}' created and started`);
    }

    await this.waitUntilRunning();
    this.started = true;
  }

  // Run a one-shot command inside the long-lived runtime container.
  // Returns the dockerode Exec handle; the caller (spawn-adapter)
  // wires its stream into the ChildHandle the backends consume.
  //
  // `user` lets backend init do the one-time chown step against
  // named volumes that mount in root-owned (anonymous-bind path).
  // Default unset → docker uses the image's configured USER (node).
  async exec(opts: {
    command: string;
    args: readonly string[];
    cwd?: string;
    env?: readonly string[];
    user?: string;
  }): Promise<Exec> {
    if (!this.started || !this.container) {
      throw new Error('runtime container not started');
    }
    return this.container.exec({
      Cmd: [opts.command, ...opts.args],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
      ...(opts.env && opts.env.length > 0 ? { Env: [...opts.env] } : {}),
      ...(opts.user ? { User: opts.user } : {}),
    });
  }

  // Best-effort container stop. Fire-and-forget from backend.stop()
  // (which is sync); errors are logged but do not propagate so a
  // mid-shutdown daemon never blocks on docker.
  async stop(): Promise<void> {
    if (!this.container) return;
    try {
      await this.container.stop({ t: 10 });
      this.log.info(`runtime container '${containerName(this.opts.backendKind)}' stopped`);
    } catch (err) {
      // 304 = already stopped; not an error
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 304) {
        this.log.warn(`runtime container stop failed: ${errorMessage(err)}`);
      }
    }
  }

  // Expose the underlying dockerode handles so spawn-adapter can call
  // exec / inspect without re-implementing them. Internal use only.
  getDocker(): Docker {
    return this.docker;
  }
  getContainer(): Container {
    if (!this.container) throw new Error('runtime container not started');
    return this.container;
  }

  // Canonical container name for this backend kind. Used by
  // spawn-adapter's docker-exec implementation (which shells out to
  // the docker CLI for bun-compat reasons — see spawn-adapter.ts).
  getContainerName(): string {
    return containerName(this.opts.backendKind);
  }

  // ──────────────────────────────────────────────────────────────────
  private async ensureDaemonReachable(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (err) {
      throw new Error(
        `docker daemon is not reachable (${errorMessage(err)}). ` +
          `The container runtime profile (#249) requires a local docker daemon. ` +
          `Switch to runtime: 'host' for this backend, or start docker and retry.`,
      );
    }
  }

  private async ensureImage(): Promise<void> {
    const image = this.opts.image;
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 404) throw err;
    }
    this.log.info(`pulling runtime image ${image}`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        // followProgress drains the pull stream; we don't surface
        // layer-level progress (would spam logs for a 200MB image).
        this.docker.modem.followProgress(stream, (finishErr: Error | null) => {
          if (finishErr) reject(finishErr);
          else resolve();
        });
      });
    });
  }

  private async ensureVolumes(): Promise<void> {
    const names = [
      credsVolumeName(this.opts.backendKind),
      sessionsVolumeName(this.opts.backendKind),
      // The agents/<kind> tree lives in its own named volume too so
      // install-backend.sh's installs survive container re-creation.
      `vicoop-agents-${this.opts.backendKind}`,
    ];
    for (const name of names) {
      try {
        await this.docker.getVolume(name).inspect();
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status !== 404) throw err;
        await this.docker.createVolume({ Name: name, Labels: { 'vicoop.kind': this.opts.backendKind } });
        this.log.info(`created named volume '${name}'`);
      }
    }
  }

  private async findContainerByName(name: string): Promise<{ Id: string } | undefined> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { name: [name] },
    });
    // listContainers returns names prefixed with "/" — match the bare
    // name to avoid false positives on substrings.
    const hit = list.find((c) => c.Names.some((n) => n === `/${name}` || n === name));
    return hit ? { Id: hit.Id } : undefined;
  }

  private async createContainer(name: string): Promise<Container> {
    const kind = this.opts.backendKind;
    const env: string[] = [];
    if (this.opts.bridgeUrl) env.push(`VICOOP_BRIDGE_URL=${this.opts.bridgeUrl}`);
    if (this.opts.skipFirewall) env.push('VICOOP_SKIP_FIREWALL=1');

    const binds: string[] = [
      // Per-kind named volumes — keeps the bridge-client-driven
      // /data/agents/<kind>, /data/creds/<kind>, /data/sessions/<kind>
      // persistent across container re-creation. Decisions §4, §5.
      `vicoop-agents-${kind}:/data/agents/${kind}`,
      `${credsVolumeName(kind)}:/data/creds/${kind}`,
      `${sessionsVolumeName(kind)}:/data/sessions/${kind}`,
    ];
    if (this.opts.workspaceDir) {
      // Workspace as a host bind-mount. Per-context branching
      // (a different workspace per task) is intentionally out of
      // scope for this PR — see #249's non-goals.
      binds.push(`${this.opts.workspaceDir}:/workspace`);
    }

    return this.docker.createContainer({
      name,
      Image: this.opts.image,
      Env: env,
      Labels: { 'vicoop.kind': kind },
      HostConfig: {
        Binds: binds,
        // Decision §2 — daemon-side belt to the bridge-client's
        // health-check braces.
        RestartPolicy: { Name: 'unless-stopped' },
        // NET_ADMIN / NET_RAW let init-firewall.sh program iptables
        // inside the container. Without them the entrypoint logs a
        // warning and skips the allowlist; we add them by default so
        // outbound isolation is on out of the box.
        CapAdd: ['NET_ADMIN', 'NET_RAW'],
      },
    });
  }

  private async waitUntilRunning(): Promise<void> {
    if (!this.container) throw new Error('runtime container not started');
    const start = Date.now();
    const timeoutMs = 10_000;
    while (Date.now() - start < timeoutMs) {
      const info: ContainerInspectInfo = await this.container.inspect();
      if (info.State.Running) return;
      if (info.State.Status === 'exited' || info.State.Status === 'dead') {
        throw new Error(
          `runtime container entered terminal state '${info.State.Status}' before becoming ready`,
        );
      }
      await sleep(200);
    }
    throw new Error(`runtime container did not become ready within ${timeoutMs}ms`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Pick the socket / TCP host dockerode should connect to.
//
// dockerode's zero-arg constructor honors $DOCKER_HOST and otherwise
// falls back to `/var/run/docker.sock`. That misses the common macOS
// reality where colima / orbstack / rancher-desktop publish their
// socket somewhere under $HOME and rely on `docker context` to wire
// the CLI. dockerode doesn't read docker contexts itself, so without
// this resolver every container-mode bridge client on those setups
// would fail with `ENOENT /var/run/docker.sock`.
//
// Precedence:
//   1. $DOCKER_HOST  -> return undefined; dockerode parses it.
//   2. `currentContext` from ~/.docker/config.json -> read its
//      meta.json's Endpoints.docker.Host (unix:// or tcp://).
//   3. anything we don't recognize -> return undefined and let
//      dockerode use its default.
//
// Exported so unit tests can exercise it without spinning up a real
// daemon connection.
export function resolveDockerOptions(env: NodeJS.ProcessEnv = process.env): DockerOptions | undefined {
  if (env.DOCKER_HOST) return undefined;

  const home = homedir();
  const configPath = join(home, '.docker', 'config.json');
  if (!existsSync(configPath)) return undefined;

  let currentContext: string;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    currentContext = typeof config.currentContext === 'string' ? config.currentContext : 'default';
  } catch {
    return undefined;
  }
  if (!currentContext || currentContext === 'default') return undefined;

  // docker stores per-context metadata under a sha256-of-context-name
  // directory. The format is stable enough to lean on directly; the
  // alternative (shelling out to `docker context inspect`) would
  // defeat the point of using a programmatic API.
  const hash = createHash('sha256').update(currentContext).digest('hex');
  const metaPath = join(home, '.docker', 'contexts', 'meta', hash, 'meta.json');
  if (!existsSync(metaPath)) return undefined;

  let host: unknown;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    host = meta?.Endpoints?.docker?.Host;
  } catch {
    return undefined;
  }
  if (typeof host !== 'string') return undefined;

  if (host.startsWith('unix://')) {
    return { socketPath: host.slice('unix://'.length) };
  }
  if (host.startsWith('tcp://')) {
    try {
      const url = new URL(host);
      return {
        host: url.hostname,
        port: Number(url.port) || 2375,
        protocol: url.protocol === 'https:' ? 'https' : 'http',
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
