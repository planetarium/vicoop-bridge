import { createCodexModelCatalogCache } from './codex-model-catalog-cache.js';
import { assertCallerRuntimeVersion } from './caller-runtime-version.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import {
  DockerCallerRuntimePool,
  type CallerKind,
} from './caller-runtime-docker.js';
import { CallerScopedBackend } from './caller-scoped-backend.js';
import {
  createClaudeCredentialReader,
  assertClaudeBrokerSettings,
} from './claude-auth-broker.js';
import { createClaudeBrokerSpawn } from './claude-broker-spawn.js';
import {
  createCodexCredentialReader,
  createCodexAuthBroker,
} from './codex-auth-broker.js';
import { createExecutionBrokerSpawn } from './execution-broker-spawn.js';
import {
  createClaudeBackend,
  type ClaudeBackendOptions,
  type ClaudeSpawnFn,
} from './backends/claude.js';
import { createCodexExecutionBackend } from './backends/codex-execution.js';
import type { CodexBackendOptions } from './backends/codex.js';
import type { AppServerSpawnFn } from './backends/codex-rpc.js';
import type { SpawnFn } from './spawn-adapter.js';
import { runDockerCommand } from './docker-command.js';

export async function createCallerRuntime(args: {
  kind: CallerKind;
  agentId: string;
  config: unknown;
  claude?: ClaudeBackendOptions;
  codex?: CodexBackendOptions;
}): Promise<CallerScopedBackend> {
  const config = CallerRuntimeConfig.parse(args.config);
  const claudeCredential =
    args.kind === 'claude' ? createClaudeCredentialReader() : undefined;
  const codexCredential =
    args.kind === 'codex' ? createCodexCredentialReader() : undefined;
  const selected = await (claudeCredential ?? codexCredential)!();
  if (args.kind === 'claude') assertClaudeBrokerSettings(args.claude?.settings);
  const catalog = codexCredential ? createCodexModelCatalogCache(codexCredential) : undefined;
  const pool = new DockerCallerRuntimePool(args.kind, config, args.agentId);
  const backend = new CallerScopedBackend(
    args.agentId,
    pool,
    async (container, signal) => {
      signal.throwIfAborted();
      const version = await runDockerCommand([
        'exec',
        '--user',
        '1000:1000',
        container.name,
        args.kind,
        '--version',
      ], { signal });
      signal.throwIfAborted();
      if (version.exitCode !== 0)
        throw new Error('caller image must contain installed backend');
      const installed = assertCallerRuntimeVersion(args.kind, version.stdout);
      const brokerStats: Array<{
        forwarded: number;
        rejected: number;
        lastRejectedStatus?: number;
      }> = [];
      const codexCatalog = args.kind === 'codex'
        ? await catalog!(installed, signal)
        : undefined;
      signal.throwIfAborted();
      const broker =
        args.kind === 'claude'
          ? createClaudeBrokerSpawn(container.name, {
              credential: claudeCredential!,
              authentication: selected.kind,
              ttlMs: config.taskTimeoutMs,
            })
          : createExecutionBrokerSpawn(container.name, {
              backend: 'codex',
              ttlMs: config.taskTimeoutMs,
              codexCatalog,
              createBroker: () => {
                const providerBroker = createCodexAuthBroker({
                  credential: codexCredential!,
                  authentication: selected.kind,
                });
                brokerStats.push(providerBroker.stats);
                return providerBroker;
              },
            });
      const processes = new Set<Promise<void>>();
      const spawn: SpawnFn = (command, argv, options) => {
        const child = broker.spawn(command, argv, options);
        const closed = new Promise<void>((resolve) =>
          child.on('close', () => resolve()),
        );
        processes.add(closed);
        void closed.then(() => processes.delete(closed));
        return child;
      };
      const worker =
        args.kind === 'claude'
          ? createClaudeBackend({
              ...args.claude,
              cwd: '/workspace',
              spawn: spawn as ClaudeSpawnFn,
              fetchUriPolicy: { enabled: false },
              extraArgs: [
                '--strict-mcp-config',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--setting-sources',
                '',
                '--dangerously-skip-permissions',
              ],
            })
          : createCodexExecutionBackend({
              ...args.codex,
              cwd: '/workspace',
              sandboxMode: 'danger-full-access',
              spawn: spawn as AppServerSpawnFn,
              mkdtemp: (_prefix, signal) => pool.inputDirectory(container.id, signal),
              writeFile: (path, data, signal) =>
                pool.inputWrite(container.id, path, data, signal),
              rm: (path) => pool.inputRemove(container.id, path),
            });
      return {
        backend: worker,
        close: () => broker.close(),
        healthy: () => broker.healthy(),
        settle: async () => {
          await Promise.all([...processes]);
          for (const stats of brokerStats.splice(0)) {
            if (
              stats.rejected &&
              (stats.lastRejectedStatus !== 426 || stats.rejected > 1)
            )
              console.warn(
                'Caller Codex authentication broker rejection:',
                JSON.stringify(stats),
              );
          }
        },
      };
    },
  );
  await backend.initialize();
  return backend;
}
