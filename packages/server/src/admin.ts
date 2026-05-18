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
import { listCallerTokens, revokeCallerToken } from './auth/caller-token.js';
import { logEvent } from './log.js';
import { isAdmin } from './admin-scope.js';
import {
  AdminApiError,
  addCaller,
  listActiveAgents,
  listCallers,
  removeCaller,
} from './admin-api.js';
import { appendHistoryMessage } from './executor.js';

export { getAdminWallets } from './admin-scope.js';

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

// Render principal-kind-specific copy for the "logged in as" line. Email is
// optional; we surface it for google: principals so the human reading the
// chat sees their address rather than the opaque numeric `sub`.
function describePrincipal(principalId: string, email?: string): string {
  if (principalId.startsWith('eth:')) {
    const addr = principalId.slice('eth:'.length);
    return `wallet \`${addr}\``;
  }
  if (principalId.startsWith('google:')) {
    return email ? `Google account \`${email}\`` : `Google account \`${principalId}\``;
  }
  return `principal \`${principalId}\``;
}

// ── System Prompt ────────────────────────────────────────────────

function buildSystemPrompt(principalId: string, email: string | undefined, sdl?: string): string {
  const admin = isAdmin(principalId);
  const scope = admin
    ? 'You are logged in as an **admin**. You can see and manage ALL clients across all owners.'
    : `You are logged in as ${describePrincipal(principalId, email)}. You can only see and manage clients you own (RLS enforced).`;

  let prompt = `You are the Server Admin Agent for vicoop-bridge. You manage client registrations and access control.

## Current User

${scope}

## What you manage

Clients are services that connect to the server via WebSocket to register A2A agents. Each client has:
- **id**: Unique identifier (UUID)
- **owner_principal**: Principal of the owner (e.g. \`eth:0x<40 hex>\` or \`google:sub:<sub>\`)
- **client_name**: Human-readable name
- **allowed_agent_ids**: List of agent IDs this client is authorized to register
- **revoked**: Whether this client has been revoked
- **created_at**: When it was created
- **token_hash**: Not exposed via GraphQL — use \`mutate_registerClient\` or \`mutate_rotateClientToken\` to obtain tokens

## Tool Usage

- Use \`query_*\` tools to read clients and agent policies. RLS enforces ownership (admins see all).
- Client lifecycle mutations are exposed as custom GraphQL functions:
  - \`mutate_registerClient(clientName, allowedAgentIds, ownerPrincipal?)\` — creates a new client and returns the raw bearer token (shown only once). Admins may pass \`ownerPrincipal\` to create on behalf of another principal; non-admins always own the resulting client.
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

Supported principal formats in \`allowed_callers\` (and as \`owner_principal\`):
- \`eth:0x<40 hex>\` — SIWE-authenticated Ethereum address
- \`google:sub:<sub>\` — specific Google account by stable id
- \`google:email:<email>\` — Google account by email (pinned to sub on first match)
- \`google:domain:<domain>\` — any verified Google Workspace account from the domain (allowed_callers only)

When an agent registers via WebSocket, a default policy (public) is auto-created. Use \`add_caller\` to restrict access. The agent card automatically advertises \`securitySchemes\` when callers are configured.

## Conversation memory

Your conversation history is persisted in PostgreSQL. You remember all previous messages in this context, even across server restarts. The messages above this one are real history — treat them as your own memory. Do not claim you have forgotten or cannot recall earlier parts of the conversation.

## Important rules

- When registering a client or rotating a token, always warn the user that the raw token is shown only once.
- When registering on behalf of another principal (admin only), echo back the chosen \`ownerPrincipal\` so the user can confirm.
- When adding a caller, explain that the agent will require an authenticated bearer token from that point on (either SIWE-exchanged or Google-device-flow-issued, depending on the principal format).
- Present data clearly in tables or lists.
- If asked about something outside client management, politely explain your scope.

## PostGraphile Conventions

- **Connection types**: List queries return \`{ nodes { ...fields } totalCount }\`.
- **Filtering**: Use \`condition\` argument, e.g. \`condition: { revoked: false }\`.
- **Sorting**: Use \`orderBy\` with values like \`CREATED_AT_DESC\`.
- **Field naming**: snake_case SQL → camelCase GraphQL (e.g. \`owner_principal\` → \`ownerPrincipal\`).
`;

  if (sdl) {
    prompt += `\n## GraphQL Schema\n\n\`\`\`graphql\n${sdl}\n\`\`\`\n`;
  }

  return prompt;
}

// ── Custom Tools (token generation, active agents) ───────────────

function buildCustomTools(db: Sql, registry: Registry, principalId: string) {
  // Caller-side admin tools that hit the DB pass jwt.claims.principal_id
  // through so RLS predicates (owner_principal = current_principal()) match
  // the operator's own rows. The principalId arrives already canonicalized
  // (eth:0x… or google:sub:…) from the http layer, so no normalization
  // here. The actual implementations live in admin-api.ts and are shared
  // with the deterministic /admin-api/* HTTP routes; these wrappers translate
  // AdminApiError into the `{error}` shape the LLM was trained to read.
  const wrap = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AdminApiError) return { error: err.message };
      throw err;
    }
  };
  return {
    list_active_agents: tool({
      description: 'List currently connected agents with their client identity and connection time. Non-admin users only see their own agents.',
      inputSchema: z.object({}),
      execute: async () => listActiveAgents(registry, principalId),
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
      execute: async ({ agent_id, principal }) =>
        wrap(() => addCaller(db, registry, principalId, agent_id, principal)),
    }),

    remove_caller: tool({
      description:
        'Remove a principal from an agent\'s allowed callers. If the list becomes empty, the agent becomes public again. ' +
        'Accepts the same principal formats as add_caller.',
      inputSchema: z.object({
        agent_id: z.string().describe('The agent ID to remove the caller from'),
        principal: z.string().describe('Principal string to remove'),
      }),
      execute: async ({ agent_id, principal }) =>
        wrap(() => removeCaller(db, registry, principalId, agent_id, principal)),
    }),

    list_callers: tool({
      description: 'List the allowed callers for an agent. Empty list means the agent is public.',
      inputSchema: z.object({
        agent_id: z.string().describe('The agent ID to list callers for'),
      }),
      execute: async ({ agent_id }) => wrap(() => listCallers(db, principalId, agent_id)),
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
        if (!isAdmin(principalId)) {
          return { error: 'Admin-only tool. Current principal is not in ADMIN_WALLET_ADDRESSES (admin scope is wallet-only).' };
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
        if (!isAdmin(principalId)) {
          return { error: 'Admin-only tool. Current principal is not in ADMIN_WALLET_ADDRESSES (admin scope is wallet-only).' };
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
    const principalId = metadata?._principalId as string | undefined;
    const bearerToken = metadata?._bearerToken as string | undefined;
    const callerEmail = metadata?._email as string | undefined;
    if (!principalId || !bearerToken) {
      throw new InvalidRequestError('Authenticated principal is required.');
    }

    const userText = extractText(message);
    if (!userText) {
      throw new InvalidParamsError('message.parts with text is required');
    }

    // Initial 'working' status echoes the user message so the streaming
    // consumer can render it immediately (matches pre-migration behavior
    // that emitted a status-update with state='working' carrying the
    // user message).
    const initialStatus: TaskStatusUpdateEvent = {
      taskId,
      contextId,
      final: false,
      status: {
        state: TaskState.WORKING,
        timestamp: nowIso(),
        message,
      },
    };
    task.history = appendHistoryMessage(task.history ?? [], initialStatus.status.message);
    yield initialStatus;

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    try {
      const answer = await runWithBearerToken(bearerToken, async () => {
        const { tools: schemaTools, sdl } = await getSchemaTools();
        const customTools = buildCustomTools(this.db, this.registry, principalId);
        const tools = { ...schemaTools, ...customTools };

        // Load conversation history from previous tasks in the same
        // context, plus any history already on the current task.
        const previousTasks = await this.taskStoreImpl.loadByContextId(
          contextId,
          principalId,
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
          system: buildSystemPrompt(principalId, callerEmail, sdl),
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
      task.history = appendHistoryMessage(task.history ?? [], task.status.message);

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
      task.history = appendHistoryMessage(task.history ?? [], task.status.message);

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
