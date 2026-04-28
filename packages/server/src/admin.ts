import crypto from 'node:crypto';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, tool, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import {
  A2XAgent,
  AgentExecutor,
  BaseAgent,
  DefaultRequestHandler,
  HttpBearerAuthorization,
  InMemoryRunner,
  InvalidParamsError,
  InvalidRequestError,
  StreamingMode,
  TaskState,
  type AgentCardV03,
  type AgentEvent,
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2x/sdk';
import type { Sql } from './db.js';
import { getSchemaTools } from './schema-tools.js';
import { runWithBearerToken } from './graphql-client.js';
import type { Registry } from './registry.js';
import { PostgresTaskStore, type ContextAwareTaskStore } from './postgres-task-store.js';
import { validatePrincipal } from './auth/principal.js';
import { listCallerTokens, revokeCallerToken } from './auth/caller-token.js';
import { logEvent } from './log.js';

// ── Helpers ──────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function agentMessage(text: string, taskId: string, contextId: string): Message {
  return {
    messageId: crypto.randomUUID(),
    role: 'agent',
    parts: [{ text: text || 'No response generated.' }],
    taskId,
    contextId,
  };
}

function extractText(message: Message): string {
  return message.parts
    .filter((p): p is { text: string } => 'text' in p && typeof (p as { text: unknown }).text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

function toModelMessages(history: Message[], userText: string): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const msg of history) {
    const text = extractText(msg);
    if (!text) continue;
    messages.push({ role: msg.role === 'agent' ? 'assistant' : 'user', content: text });
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

// AgentExecutor's constructor wants a Runner. The admin executor runs
// generateText() directly, never invoking the runner.
class NoopBaseAgent extends BaseAgent {
  constructor() {
    super({ name: 'admin-noop' });
  }
  async *run(): AsyncGenerator<AgentEvent> {
    // Never invoked.
  }
}

const ADMIN_NOOP_RUNNER = new InMemoryRunner({
  agent: new NoopBaseAgent(),
  appName: 'vicoop-bridge-admin-noop',
});

// ── Admin Wallet Check ───────────────────────────────────────────

const adminWallets = new Set(
  (process.env.ADMIN_WALLET_ADDRESSES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

function isAdmin(wallet: string): boolean {
  return adminWallets.has(wallet.toLowerCase());
}

export function getAdminWallets(): string[] {
  return [...adminWallets];
}

// ── System Prompt ────────────────────────────────────────────────

function buildSystemPrompt(walletAddress: string, sdl?: string): string {
  const admin = isAdmin(walletAddress);
  const scope = admin
    ? 'You are logged in as an **admin**. You can see and manage ALL clients across all owners.'
    : `You are logged in as wallet \`${walletAddress}\`. You can only see and manage clients you own (RLS enforced).`;

  let prompt = `You are the Server Admin Agent for vicoop-bridge. You manage client registrations and access control.

## Current User

${scope}

## What you manage

Clients are services that connect to the server via WebSocket to register A2A agents. Each client has:
- **id**: Unique identifier (UUID)
- **owner_wallet**: Wallet address of the owner
- **client_name**: Human-readable name
- **allowed_agent_ids**: List of agent IDs this client is authorized to register
- **revoked**: Whether this client has been revoked
- **created_at**: When it was created
- **token_hash**: Not exposed via GraphQL — use \`mutate_registerClient\` or \`mutate_rotateClientToken\` to obtain tokens

## Tool Usage

- Use \`query_*\` tools to read clients and agent policies. RLS enforces ownership (admins see all).
- Client lifecycle mutations are exposed as custom GraphQL functions:
  - \`mutate_registerClient(clientName, allowedAgentIds, ownerWallet?)\` — creates a new client and returns the raw bearer token (shown only once). Admins may pass \`ownerWallet\` to create on behalf of another wallet; non-admins always own the resulting client.
  - \`mutate_revokeClient(clientId)\` / \`mutate_unrevokeClient(clientId)\` — toggle the \`revoked\` flag. Existing WebSocket sessions stay connected until they reconnect.
  - \`mutate_rotateClientToken(clientId)\` — issues a new bearer token and invalidates the previous one. Returns the raw token once.
  - \`mutate_updateClientAllowedAgents(clientId, allowedAgentIds)\` — replaces the agent allowlist.
- Do NOT use the auto-generated \`mutate_updateClientById\` or \`mutate_deleteClientById\` for revoke/token rotation — always prefer the semantic mutations above.
- Use \`list_active_agents\` to see currently connected agents.
- Use \`add_caller\` / \`remove_caller\` / \`list_callers\` to manage per-agent access control. Do not use GraphQL mutations to manage \`allowed_callers\`.
- Use \`list_caller_tokens\` / \`revoke_caller_token\` (admin only) to manage opaque caller tokens. Issued via either Google OAuth device flow (provider=google) or SIWE exchange (provider=siwe).
- Use \`execute_graphql\` for complex queries and inspection not covered by auto-generated tools.

## Agent Access Control

Each agent has an access policy (\`agent_policies\` table) with an \`allowed_callers\` list:
- **Empty \`allowed_callers\`**: Agent is public — anyone can call it via A2A.
- **Non-empty \`allowed_callers\`**: Agent requires an authenticated Bearer token, and only listed principals can call.

Supported principal formats in \`allowed_callers\`:
- \`eth:0x<40 hex>\` — SIWE-authenticated Ethereum address
- \`google:sub:<sub>\` — specific Google account by stable id
- \`google:email:<email>\` — Google account by email (pinned to sub on first match)
- \`google:domain:<domain>\` — any verified Google Workspace account from the domain

When an agent registers via WebSocket, a default policy (public) is auto-created. Use \`add_caller\` to restrict access. The agent card automatically advertises \`securitySchemes\` when callers are configured.

## Conversation memory

Your conversation history is persisted in PostgreSQL. You remember all previous messages in this context, even across server restarts. The messages above this one are real history — treat them as your own memory. Do not claim you have forgotten or cannot recall earlier parts of the conversation.

## Important rules

- When registering a client or rotating a token, always warn the user that the raw token is shown only once.
- When registering on behalf of another wallet (admin only), echo back the chosen \`ownerWallet\` so the user can confirm.
- When adding a caller, explain that the agent will require an authenticated bearer token from that point on (either SIWE-exchanged or Google-device-flow-issued, depending on the principal format).
- Present data clearly in tables or lists.
- If asked about something outside client management, politely explain your scope.

## PostGraphile Conventions

- **Connection types**: List queries return \`{ nodes { ...fields } totalCount }\`.
- **Filtering**: Use \`condition\` argument, e.g. \`condition: { revoked: false }\`.
- **Sorting**: Use \`orderBy\` with values like \`CREATED_AT_DESC\`.
- **Field naming**: snake_case SQL → camelCase GraphQL (e.g. \`owner_wallet\` → \`ownerWallet\`).
`;

  if (sdl) {
    prompt += `\n## GraphQL Schema\n\n\`\`\`graphql\n${sdl}\n\`\`\`\n`;
  }

  return prompt;
}

// ── Custom Tools (token generation, active agents) ───────────────

function buildCustomTools(db: Sql, registry: Registry, walletAddress: string) {
  return {
    list_active_agents: tool({
      description: 'List currently connected agents with their client identity and connection time. Non-admin users only see their own agents.',
      inputSchema: z.object({}),
      execute: async () => {
        const admin = isAdmin(walletAddress);
        return registry.listAgents()
          .filter((a) => admin || a.ownerWallet.toLowerCase() === walletAddress.toLowerCase())
          .map((a) => ({
            agent_id: a.agentId,
            client_id: a.clientId,
            agent_name: a.agentCard.name,
            allowed_callers: a.allowedCallers,
            connected_at: new Date(a.connectedAt).toISOString(),
          }));
      },
    }),

    add_caller: tool({
      description:
        'Add a principal to an agent\'s allowed callers. Once any caller is added, the agent requires authenticated Bearer token.\n' +
        'Supported principal formats:\n' +
        '  eth:0x<40 hex>         Ethereum address (SIWE)\n' +
        '  0x<40 hex>             Plain wallet, auto-prefixed with eth:\n' +
        '  google:sub:<sub>       Specific Google account (stable id)\n' +
        '  google:email:<addr>    Google account by email (pins to sub on first match)\n' +
        '  google:domain:<d>      Google Workspace domain (any verified account)',
      inputSchema: z.object({
        agent_id: z.string().describe('The agent ID to add the caller to'),
        principal: z.string().describe('Principal string (see tool description)'),
      }),
      execute: async ({ agent_id, principal }) => {
        const normalized = validatePrincipal(principal);
        if (!normalized) {
          return { error: 'Invalid principal format. See tool description for supported formats.' };
        }
        const adminAddresses = process.env.ADMIN_WALLET_ADDRESSES ?? '';
        const result = await db.begin(async (tx) => {
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
          await tx`SELECT set_config('app.admin_addresses', ${adminAddresses}, true)`;
          return tx`
            UPDATE agent_policies
            SET allowed_callers = array_append(allowed_callers, ${normalized}),
                updated_at = now()
            WHERE agent_id = ${agent_id}
              AND NOT (${normalized} = ANY(allowed_callers))
            RETURNING agent_id, owner_wallet, allowed_callers
          `;
        });
        if (result.length === 0) {
          const adminAddrs = process.env.ADMIN_WALLET_ADDRESSES ?? '';
          const existing = await db.begin(async (tx) => {
            await tx`SELECT set_config('role', 'app_authenticated', true)`;
            await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
            await tx`SELECT set_config('app.admin_addresses', ${adminAddrs}, true)`;
            return tx`SELECT allowed_callers FROM agent_policies WHERE agent_id = ${agent_id}`;
          });
          if (existing.length === 0) return { error: 'Agent policy not found or not authorized.' };
          if ((existing[0].allowed_callers as string[]).includes(normalized)) {
            return { agent_id, message: 'Principal already in allowed callers', allowed_callers: existing[0].allowed_callers };
          }
          return { error: 'Not authorized to modify this agent policy.' };
        }
        const callers = result[0].allowed_callers as string[];
        registry.updateAllowedCallers(agent_id, callers);
        return { agent_id, principal: normalized, allowed_callers: callers };
      },
    }),

    remove_caller: tool({
      description:
        'Remove a principal from an agent\'s allowed callers. If the list becomes empty, the agent becomes public again. ' +
        'Accepts the same principal formats as add_caller.',
      inputSchema: z.object({
        agent_id: z.string().describe('The agent ID to remove the caller from'),
        principal: z.string().describe('Principal string to remove'),
      }),
      execute: async ({ agent_id, principal }) => {
        const normalized = validatePrincipal(principal);
        if (!normalized) {
          return { error: 'Invalid principal format. See add_caller description for supported formats.' };
        }
        const adminAddresses = process.env.ADMIN_WALLET_ADDRESSES ?? '';
        const result = await db.begin(async (tx) => {
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
          await tx`SELECT set_config('app.admin_addresses', ${adminAddresses}, true)`;
          return tx`
            UPDATE agent_policies
            SET allowed_callers = array_remove(allowed_callers, ${normalized}),
                updated_at = now()
            WHERE agent_id = ${agent_id}
              AND ${normalized} = ANY(allowed_callers)
            RETURNING agent_id, owner_wallet, allowed_callers
          `;
        });
        if (result.length === 0) {
          return { error: 'Principal not found in allowed callers, agent policy not found, or not authorized.' };
        }
        const callers = result[0].allowed_callers as string[];
        registry.updateAllowedCallers(agent_id, callers);
        return { agent_id, principal: normalized, allowed_callers: callers };
      },
    }),

    list_callers: tool({
      description: 'List the allowed callers for an agent. Empty list means the agent is public.',
      inputSchema: z.object({
        agent_id: z.string().describe('The agent ID to list callers for'),
      }),
      execute: async ({ agent_id }) => {
        const adminAddresses = process.env.ADMIN_WALLET_ADDRESSES ?? '';
        const result = await db.begin(async (tx) => {
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
          await tx`SELECT set_config('app.admin_addresses', ${adminAddresses}, true)`;
          return tx`
            SELECT agent_id, owner_wallet, allowed_callers, created_at, updated_at
            FROM agent_policies WHERE agent_id = ${agent_id}
          `;
        });
        if (result.length === 0) return { error: 'Agent policy not found.' };
        const policy = result[0];
        return {
          agent_id: policy.agent_id,
          owner_wallet: policy.owner_wallet,
          allowed_callers: policy.allowed_callers,
          is_public: (policy.allowed_callers as string[]).length === 0,
        };
      },
    }),

    list_caller_tokens: tool({
      description:
        'List caller tokens (opaque bearer tokens issued via Google OAuth device flow). Admin only. ' +
        'Filter by principal_id (e.g. "google:1234567890") or email.',
      inputSchema: z.object({
        principal_id: z.string().optional().describe('Filter by exact principal_id match'),
        email: z.string().optional().describe('Filter by exact email match'),
        include_revoked: z.boolean().optional().describe('Include revoked tokens (default false)'),
      }),
      execute: async ({ principal_id, email, include_revoked }) => {
        if (!isAdmin(walletAddress)) {
          return { error: 'Admin-only tool. Current wallet is not in ADMIN_WALLET_ADDRESSES.' };
        }
        const rows = await listCallerTokens(db, {
          principalId: principal_id,
          email,
          includeRevoked: include_revoked,
        });
        return {
          count: rows.length,
          tokens: rows.map((r) => ({
            id: r.id,
            principal_id: r.principalId,
            provider: r.provider,
            email: r.email,
            label: r.label,
            expires_at: r.expiresAt.toISOString(),
            last_used_at: r.lastUsedAt?.toISOString() ?? null,
            revoked: r.revoked,
            created_at: r.createdAt.toISOString(),
          })),
        };
      },
    }),

    revoke_caller_token: tool({
      description:
        'Revoke a caller token by id. Admin only. Idempotent — revoking an already-revoked or ' +
        'nonexistent token is not an error. Effect propagates within ~60s due to the in-memory ' +
        'verification cache.',
      inputSchema: z.object({
        caller_id: z.string().describe('The caller token id (from list_caller_tokens)'),
      }),
      execute: async ({ caller_id }) => {
        if (!isAdmin(walletAddress)) {
          return { error: 'Admin-only tool. Current wallet is not in ADMIN_WALLET_ADDRESSES.' };
        }
        await revokeCallerToken(db, caller_id);
        return { caller_id, revoked: true };
      },
    }),
  };
}

// ── Executor ─────────────────────────────────────────────────────

class AdminA2XExecutor extends AgentExecutor {
  private readonly abortControllers = new Map<string, AbortController>();
  constructor(
    private readonly db: Sql,
    private readonly registry: Registry,
    private readonly taskStoreImpl: ContextAwareTaskStore,
  ) {
    super({
      runner: ADMIN_NOOP_RUNNER,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
  }

  override async execute(task: Task, message: Message): Promise<Task> {
    for await (const _event of this.executeStream(task, message)) {
      void _event;
    }
    return task;
  }

  override async *executeStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const taskId = task.id;
    const contextId = task.contextId ?? taskId;

    const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
    const walletAddress = metadata?._walletAddress as string | undefined;
    const bearerToken = metadata?._bearerToken as string | undefined;
    if (!walletAddress || !bearerToken) {
      throw new InvalidRequestError('Authenticated wallet address is required.');
    }

    const userText = extractText(message);
    if (!userText) {
      throw new InvalidParamsError('message.parts with text is required');
    }

    // Initial 'working' status echoes the user message so the streaming
    // consumer can render it immediately (matches pre-migration behavior
    // that emitted a status-update with state='working' carrying the
    // user message).
    yield {
      taskId,
      contextId,
      final: false,
      status: {
        state: TaskState.WORKING,
        timestamp: nowIso(),
        message,
      },
    };

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    try {
      const answer = await runWithBearerToken(bearerToken, async () => {
        const { tools: schemaTools, sdl } = await getSchemaTools();
        const customTools = buildCustomTools(this.db, this.registry, walletAddress);
        const tools = { ...schemaTools, ...customTools };

        // Load conversation history from previous tasks in the same
        // context, plus any history already on the current task.
        const previousTasks = await this.taskStoreImpl.loadByContextId(
          contextId,
          walletAddress,
          taskId,
        );
        const contextHistory: Message[] = [];
        for (const prev of previousTasks) {
          if (prev.history) contextHistory.push(...prev.history);
          const statusMsg = prev.status?.message;
          if (statusMsg && !prev.history?.some((m) => m.messageId === statusMsg.messageId)) {
            contextHistory.push(statusMsg);
          }
        }
        const currentHistory = task.history ?? [];
        const history = [...contextHistory, ...currentHistory];

        return generateText({
          model: anthropic('claude-sonnet-4-6'),
          system: buildSystemPrompt(walletAddress, sdl),
          messages: toModelMessages(history, userText),
          tools,
          stopWhen: stepCountIs(10),
          abortSignal: controller.signal,
        });
      });

      const final = agentMessage(answer.text, taskId, contextId);
      task.status = {
        state: TaskState.COMPLETED,
        timestamp: nowIso(),
        message: final,
      };
      task.history = [...(task.history ?? []), message, final];

      try {
        await this.taskStoreImpl.updateTask(taskId, {
          status: task.status,
          history: task.history,
        });
      } catch (err) {
        logEvent('admin_persist_error', { taskId, error: String(err) });
      }

      yield {
        taskId,
        contextId,
        final: true,
        status: task.status,
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const errorText = error instanceof Error ? error.message : 'Unknown error';
      const state = aborted ? TaskState.CANCELED : TaskState.FAILED;
      const text = aborted ? 'Task canceled.' : `Error: ${errorText}`;
      const final = agentMessage(text, taskId, contextId);

      task.status = { state, timestamp: nowIso(), message: final };
      task.history = [...(task.history ?? []), message, final];

      try {
        await this.taskStoreImpl.updateTask(taskId, {
          status: task.status,
          history: task.history,
        });
      } catch (err) {
        logEvent('admin_persist_error', { taskId, error: String(err) });
      }

      yield {
        taskId,
        contextId,
        final: true,
        status: task.status,
      };
    } finally {
      this.abortControllers.delete(taskId);
    }
  }

  override async cancel(task: Task): Promise<Task> {
    const taskId = task.id;
    const controller = this.abortControllers.get(taskId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    task.status = {
      state: TaskState.CANCELED,
      timestamp: nowIso(),
    };
    return task;
  }
}

// ── Agent Card & Transport ───────────────────────────────────────

export interface AdminAgentOptions {
  db: Sql;
  registry: Registry;
  publicUrl?: string;
}

const ADMIN_DESCRIPTION =
  'Manages client registration, revocation, and access control for Vicoop Bridge Server. ' +
  'Clients are WebSocket services that bridge local A2A agents to the server. Each client ' +
  'is scoped to an owner wallet and an explicit agent ID allowlist. Requires a bridge-issued ' +
  'opaque caller token (vbc_caller_*) tied to a wallet principal; obtain one by signing a ' +
  'SIWE message at POST /auth/siwe/exchange.';

export function createAdminA2XAgent(opts: AdminAgentOptions): {
  a2xAgent: A2XAgent;
  handler: DefaultRequestHandler;
  taskStore: PostgresTaskStore;
} {
  const taskStore = new PostgresTaskStore(opts.db);
  const executor = new AdminA2XExecutor(opts.db, opts.registry, taskStore);

  const a2xAgent = new A2XAgent({
    taskStore,
    executor,
    protocolVersion: '0.3',
  })
    .setName('Vicoop Bridge Server Admin')
    .setDescription(ADMIN_DESCRIPTION)
    .setVersion('0.1.0')
    .setDefaultUrl(opts.publicUrl ?? '/')
    .setDefaultInputModes(['text/plain'])
    .setDefaultOutputModes(['text/plain'])
    .addSkill({
      id: 'client-management',
      name: 'Client Management',
      description:
        'Register, revoke, and list clients with per-agent-id authorization. Wallet-based ownership with RLS.',
      tags: ['admin', 'auth', 'client', 'siwe'],
    })
    .addSecurityScheme(
      'bridge',
      new HttpBearerAuthorization({
        scheme: 'bearer',
        bearerFormat: 'Opaque',
        description:
          'Bridge-issued opaque bearer token (vbc_caller_*). Acquire via POST /auth/siwe/exchange by signing a SIWE message.',
      }),
    )
    .addSecurityRequirement({ bridge: [] });
  // The route layer enforces caller-token verification before
  // dispatching to handler.handle(). We invoke handler.handle() without
  // a RequestContext so a2x's per-request `_authenticate` path is
  // skipped; the AgentCard still advertises the scheme + requirement
  // (declarative, for spec-compliant card consumers) but the schemes'
  // `validator` callbacks are never reached at runtime.

  const handler = new DefaultRequestHandler(a2xAgent);
  return { a2xAgent, handler, taskStore };
}

