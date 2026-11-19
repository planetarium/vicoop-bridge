import { OPERATION_APPROVAL_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { proposalEmitter } from './operation-proposals.js';
import { createCallerFileDelivery } from './caller-file-delivery.js';
import { createCodexModelCatalogCache } from './codex-model-catalog-cache.js';
import { assertCallerRuntimeVersion } from './caller-runtime-version.js';
import { CallerRuntimeConfig, assertCallerRuntimeBackend, callerOperatorInstructions } from './caller-runtime-config.js';
import {
  DockerCallerRuntimePool,
  type CallerKind,
  type CallerContainer,
} from './caller-runtime-docker.js';
import { CallerScopedBackend } from './caller-scoped-backend.js';
import {
  createClaudeCredentialReader,
  selectClaudeCallerSettings,
} from './claude-auth-broker.js';
import { createClaudeBrokerSpawn } from './claude-broker-spawn.js';
import {
  createCodexCredentialReader,
  createCodexAuthBroker,
  codexProviderAppServerArgs,
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
  assertCallerRuntimeBackend(args.kind, config);
  const claudeCredential =
    args.kind === 'claude' ? createClaudeCredentialReader() : undefined;
  const codexCredential =
    args.kind === 'codex' ? createCodexCredentialReader() : undefined;
  const selected = await (claudeCredential ?? codexCredential)!();
  const codexSelected = codexCredential ? await codexCredential() : undefined;
  const providerModel = codexSelected?.responsesProvider?.model ?? codexSelected?.azureModel;
  const claudeSettings = args.kind === 'claude' ? selectClaudeCallerSettings(args.claude?.settings) : undefined;
  const catalog = codexCredential ? createCodexModelCatalogCache(codexCredential) : undefined;
  const pool = new DockerCallerRuntimePool(args.kind, config, args.agentId);
  const backend = new CallerScopedBackend(
    args.agentId,
    pool,
    async (container, signal) => {
      signal.throwIfAborted();
      let boundContainer = container;
      const containerId = () => {
        const id = boundContainer.dockerId;
        if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Missing immutable caller container identity');
        return id;
      };
      const version = await runDockerCommand([
        'exec',
        '--user',
        '1000:1000',
        containerId(),
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
      let taskFiles: ReturnType<typeof createCallerFileDelivery> | undefined;
      let filesHealthy = true;
      let propose: ReturnType<typeof proposalEmitter> | undefined;
      const fileDelivery = config.fileDelivery || config.operations ? {
        get operations() { return propose ? config.operations : undefined; },
        filesEnabled: Boolean(config.fileDelivery),
        description: config.fileDelivery ? `Deliver a file as an A2A attachment. Allowed roots: ${config.fileDelivery.allowedRoots.join(', ')}. Limit ${config.fileDelivery.maxBytes} bytes per file, ${config.fileDelivery.maxTotalBytes} total bytes and ${config.fileDelivery.maxFiles} files per task.` : '',
        bind: () => {
          const bound = taskFiles;
          const boundProposal = propose;
          return async (input: unknown, signal: AbortSignal, tool?: string) => {
            signal.throwIfAborted();
            if (tool === 'propose_operation' && boundProposal) return boundProposal(input);
            if (!bound || (tool && tool !== 'send_file')) throw new Error('Tool unavailable');
            return bound.send(input, signal);
          };
        },
      } : undefined;
      const broker =
        args.kind === 'claude'
          ? createClaudeBrokerSpawn(containerId, {
              credential: claudeCredential!,
              authentication: selected.kind,
              ttlMs: config.taskTimeoutMs,
              credentialProxy: config.credentialProxy,
              fileDelivery,
            })
          : createExecutionBrokerSpawn(containerId, {
              backend: 'codex',
              ttlMs: config.taskTimeoutMs,
              credentialProxy: config.credentialProxy,
              codexCatalog,
              fileDelivery: codexSelected?.responsesProvider ? undefined : fileDelivery,
              createBroker: () => {
                const providerBroker = createCodexAuthBroker({
                  credential: codexCredential!,
                  authentication: selected.kind,
                  responsesProvider: codexSelected?.responsesProvider,
                  azureEndpoint: codexSelected?.azureEndpoint,
                  azureModel: codexSelected?.azureModel,
                  azureDeployment: codexSelected?.azureDeployment,
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
      const workspaceInstructions = container.context
        ? 'This conversation has its own persistent /workspace and backend session storage. Other conversations have separate writable workspaces. The caller’s previous shared workspace is available read-only at /caller-workspace; copy required files into /workspace before modifying them. Shared source assets under /shared are read-only. Write deliverables in /workspace/output.'
        : undefined;
      const proxyInstructions = config.credentialProxy ? 'Host-authenticated external services are available in VICOOP_CREDENTIAL_PROXY (JSON). Each service provides url, token, origins, socketPath and fetchModule. Import createProxyFetch from fetchModule to use an original JavaScript SDK with its custom fetch option. Do not persist execution tokens or endpoint paths: they expire when this execution ends. For gh use a temporary GH_CONFIG_DIR with http_unix_socket set to the GitHub service socketPath and GH_TOKEN set to its token. The proxy does not approve paid operations or retry requests.' : undefined;
      const appendPrompt = [callerOperatorInstructions(config), workspaceInstructions, proxyInstructions].filter(Boolean).join('\n\n');
      const worker =
        args.kind === 'claude'
          ? createClaudeBackend({
              ...args.claude,
              settings: claudeSettings,
              cwd: '/workspace',
              spawn: spawn as ClaudeSpawnFn,
              fetchUriPolicy: { enabled: false },
              extraArgs: [
                ...(appendPrompt ? ['--append-system-prompt', appendPrompt] : []),
                '--strict-mcp-config',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--setting-sources',
                '',
                ...(args.claude?.remoteApprovals ? [] : ['--dangerously-skip-permissions']),
              ],
            })
          : createCodexExecutionBackend({
              ...args.codex,
              functionFileDelivery: codexSelected?.responsesProvider && fileDelivery ? fileDelivery : undefined,
              ...(providerModel ? {
                appServerArgs: codexProviderAppServerArgs(codexSelected),
                readCodexConfigToml: async () => `model=${JSON.stringify(providerModel)}`,
              } : {}),
              operatorInstructions: callerOperatorInstructions(config),
              runtimeInstructions: [workspaceInstructions, proxyInstructions].filter(Boolean).join('\n\n') || undefined,
              cwd: '/workspace',
              sandboxMode: 'danger-full-access',
              spawn: spawn as AppServerSpawnFn,
              mkdtemp: (_prefix, signal) => pool.inputDirectory(container.id, signal, container.context, containerId()),
              writeFile: (path, data, signal) =>
                pool.inputWrite(container.id, path, data, signal, container.context, containerId()),
              rm: (path) => pool.inputRemove(container.id, path, container.context, containerId()),
            });
      return {
        bindContainer(next: CallerContainer) {
          if (next.id !== container.id || next.context !== container.context || processes.size || taskFiles || propose)
            throw new Error('Cannot rebind an active or unrelated caller worker');
          if (!next.dockerId || !/^[a-f0-9]{64}$/.test(next.dockerId))
            throw new Error('Missing immutable caller container identity');
          boundContainer = next;
        },
        backend: fileDelivery ? {
          ...worker,
          async handle(task, emit, signal) {
            if (taskFiles || propose) throw new Error('Concurrent file delivery within one caller scope');
            const files = config.fileDelivery ? createCallerFileDelivery(containerId(), task.taskId, emit, signal,
              config.fileDelivery, runDockerCommand, () => broker.close()) : undefined;
            propose = config.operations && task.requestedExtensions?.includes(OPERATION_APPROVAL_EXTENSION_URI)
              ? proposalEmitter(config.operations,task.taskId,emit,signal) : undefined;
            taskFiles = files;
            try { await worker.handle(task, emit, signal); } finally {
              // Broker exit aborts active reads. Drain their rejection handlers
              // before scope cleanup decides whether this worker is reusable.
              await files?.settle();
              filesHealthy &&= files?.healthy() ?? true;
              propose = undefined;
              taskFiles = undefined;
            }
          },
        } : worker,
        close: () => broker.close(),
        healthy: () => broker.healthy() && filesHealthy && (taskFiles?.healthy() ?? true),
        settle: async () => {
          await Promise.all([...processes]);
          await taskFiles?.settle();
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
  backend.remoteApprovals = args.kind === 'claude' ? args.claude?.remoteApprovals === true : args.codex?.approvalDecision === 'remote';
  await backend.initialize();
  return backend;
}
