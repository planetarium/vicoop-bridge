import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import semver from 'semver';
import { CALLER_IMAGE_FILES } from './caller-image-assets.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { CallerRuntimeStore } from './caller-runtime-store.js';
import {
  createClaudeCredentialReader,
  assertClaudeBrokerSettings,
} from './claude-auth-broker.js';
import {
  createCodexCredentialReader,
  isSupportedCodexBrokerVersion,
} from './codex-auth-broker.js';
import {
  BACKENDS_MANIFEST,
  type InstallableBackendKind,
} from './backends-manifest.js';
import { defaultConfigPath, writeConfig } from './config.js';
import { runDockerCommand, type AsyncDockerRun } from './docker-command.js';
import { createLogger, type Logger } from './logger.js';
import { PROVIDER_ENV_PATTERN } from './provider-environment.js';

export interface CallerContainerInitOptions {
  kind: InstallableBackendKind;
  configPath?: string;
  image?: string;
  stateDirectory?: string;
  rebuild?: boolean;
  logger?: Logger;
  dockerRun?: AsyncDockerRun;
  validateCredentials?: () => Promise<unknown>;
}

const object = z.record(z.unknown());
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Prepare a per-caller image/state and save configuration only after validation. */
export async function runCallerContainerInit(
  opts: CallerContainerInitOptions,
): Promise<number> {
  if (process.platform === 'win32')
    throw new Error('container requires Linux or macOS Docker');
  const log = opts.logger ?? createLogger();
  const path = resolve(opts.configPath ?? defaultConfigPath());
  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'register an agent first with vicoop-client auth login and vicoop-client agent register, then run container init',
      );
    throw error;
  }
  const config = object.parse(JSON.parse(original));
  if (typeof config.agent_id !== 'string' || !config.agent_id)
    throw new Error(
      'config has no agent ID; run vicoop-client agent register first',
    );
  const agentId = config.agent_id;
  if (typeof config.server_token !== 'string' || !config.server_token)
    throw new Error(
      'config has no agent token; run vicoop-client agent register first',
    );
  const backends = object.parse(config.backends ?? {});
  const backend = object.parse(backends[opts.kind] ?? {});
  const previous = object.parse(backend.caller_runtime ?? {});
  if (opts.kind === 'claude')
    assertClaudeBrokerSettings(
      backend.settings === undefined
        ? undefined
        : object.parse(backend.settings),
    );
  if (opts.rebuild && opts.image)
    throw new Error('choose --rebuild or --image, not both');
  const stateDirectory = resolve(
    opts.stateDirectory ??
      z.string().optional().parse(previous.stateDirectory) ??
      join(
        dirname(path),
        'caller-state',
        createHash('sha256').update(agentId).digest('hex'),
        opts.kind,
      ),
  );
  if (
    typeof previous.stateDirectory === 'string' &&
    resolve(previous.stateDirectory) !== stateDirectory
  )
    throw new Error(
      'container init preserves the existing stateDirectory; moving caller state requires a separate migration',
    );
  // Validate limits before Docker/build work; the real immutable ID is filled below.
  CallerRuntimeConfig.parse({
    ...previous,
    image: `sha256:${'0'.repeat(64)}`,
    stateDirectory,
  });
  const credential =
    opts.validateCredentials ??
    (opts.kind === 'claude'
      ? createClaudeCredentialReader()
      : createCodexCredentialReader());
  await credential();
  log.info(
    `${opts.kind} host authentication found; credentials remain on the host.`,
  );
  const run = opts.dockerRun ?? runDockerCommand;
  const command = async (
    args: string[],
    options?: Parameters<AsyncDockerRun>[1],
  ) => {
    const result = await run(args, options);
    if (result.exitCode !== 0)
      throw new Error(
        `docker ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    return result.stdout;
  };
  await command(['info', '--format', '{{.OSType}}']).then((out) => {
    if (out.trim() !== 'linux')
      throw new Error('container requires a Linux Docker engine');
  });
  const store = new CallerRuntimeStore(stateDirectory, agentId);
  await store.lock();
  try {
    const namespaceFilter = `label=vicoop.caller-namespace=${store.namespace}`;
    if ((await command(['ps', '-q', '--filter', namespaceFilter])).trim())
      throw new Error('stop managed caller containers before initialization');
    let reference =
      opts.image ??
      (opts.rebuild ? undefined : z.string().optional().parse(previous.image));
    if (!reference) {
      const context = await mkdtemp(join(tmpdir(), 'vicoop-caller-build-'));
      try {
        for (const [name, content] of Object.entries(CALLER_IMAGE_FILES)) {
          const target = join(context, name);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { mode: 0o600 });
        }
        log.info(
          'Building the bundled Claude/Codex image (first build downloads the backend CLIs).',
        );
        const iid = join(context, 'image-id');
        await command(
          [
            'build',
            '--iidfile',
            iid,
            '-f',
            join(context, 'Dockerfile'),
            context,
          ],
          { timeoutMs: 20 * 60_000, inheritOutput: true },
        );
        reference = imageId.parse((await readFile(iid, 'utf8')).trim());
      } finally {
        await rm(context, { recursive: true, force: true });
      }
    }
    if (!reference || reference.startsWith('-') || /\s/.test(reference))
      throw new Error('invalid image reference');
    let inspected = await run(['image', 'inspect', reference]);
    if (inspected.exitCode !== 0) {
      if (!/No such image|No such object/i.test(inspected.stderr))
        throw new Error(
          `cannot inspect caller image: ${inspected.stderr.trim()}`,
        );
      await command(['pull', reference], {
        timeoutMs: 10 * 60_000,
        inheritOutput: true,
      });
      inspected = await run(['image', 'inspect', reference]);
    }
    if (inspected.exitCode !== 0)
      throw new Error('cannot inspect caller image');
    const [image] = z
      .array(
        z.object({
          Id: imageId,
          Config: z.object({
            Volumes: z.record(z.unknown()).nullable().optional(),
            Env: z.array(z.string()).nullable().optional(),
          }),
        }),
      )
      .nonempty()
      .parse(JSON.parse(inspected.stdout));
    if (
      Object.keys(image.Config.Volumes ?? {}).length ||
      image.Config.Env?.some((v) =>
        PROVIDER_ENV_PATTERN.test(v.split('=', 1)[0]),
      )
    )
      throw new Error(
        'caller image must not declare volumes or provider environment',
      );
    if ((await store.scopes()).length && previous.image !== image.Id) {
      // Re-pinning a registry digest to the same local image ID is safe.
      const old =
        typeof previous.image === 'string'
          ? await run(['image', 'inspect', previous.image])
          : undefined;
      if (
        (!old ||
          old.exitCode !== 0 ||
          JSON.parse(old.stdout)[0]?.Id !== image.Id) &&
        (await command(['ps', '-aq', '--filter', namespaceFilter])).trim()
      )
        throw new Error(
          'retained caller containers use another image; remove them with caller-state --recreate-scope before changing the image',
        );
    }
    const name = `vicoop-caller-check-${randomUUID()}`;
    try {
      const output = await command([
        'run',
        '--name',
        name,
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '1000:1000',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--pids-limit',
        '64',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=64m',
        '--tmpfs',
        '/home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000',
        '--entrypoint',
        '/bin/sh',
        image.Id,
        '-ec',
        `/usr/local/bin/node --version >/dev/null; test -x /usr/bin/tini; command -v iptables >/dev/null; command -v ip6tables >/dev/null; ${opts.kind} --version`,
      ]);
      const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
      if (
        !version ||
        !(opts.kind === 'codex'
          ? isSupportedCodexBrokerVersion(version)
          : semver.satisfies(version, BACKENDS_MANIFEST.claude.supportedRange, {
              includePrerelease: true,
            }))
      )
        throw new Error(
          `caller image has an unsupported or missing ${opts.kind} version`,
        );
      log.info(`Validated ${opts.kind} ${version} in ${image.Id}.`);
    } finally {
      const removed = await run(['rm', '-f', name]);
      if (
        removed.exitCode !== 0 &&
        !/No such (container|object)/i.test(removed.stderr)
      )
        throw new Error(
          `cannot remove validation container ${name}: ${removed.stderr.trim()}`,
        );
    }
    const caller_runtime = CallerRuntimeConfig.parse({
      ...previous,
      image: image.Id,
      stateDirectory,
    });
    const { cwd: _cwd, runtime_name: _name, ...preserved } = backend;
    const next = {
      ...config,
      backend: opts.kind,
      backends: {
        ...backends,
        [opts.kind]: { ...preserved, runtime: 'container', caller_runtime },
      },
    };
    // Build/pull can take minutes. Never overwrite an intervening operator edit.
    if (readFileSync(path, 'utf8') !== original)
      throw new Error(
        'config changed during initialization; retry without overwriting the new settings',
      );
    writeConfig(path, next);
    log.info(
      `Saved container configuration to ${path}. Caller state: ${stateDirectory}`,
    );
    log.info(
      `Start with: vicoop-client start --config ${JSON.stringify(path)}`,
    );
    return 0;
  } finally {
    await store.unlock();
  }
}
