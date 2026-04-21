import crypto from 'node:crypto';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, tool, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Message } from '@a2a-js/sdk';
import {
  A2AError,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import type { AgentCard as SdkAgentCard } from '@a2a-js/sdk';
import type { Sql } from './db.js';
import { hashToken, generateToken } from './token.js';
import { getSchemaTools } from './schema-tools.js';
import { runWithBearerToken } from './graphql-client.js';
import type { Registry } from './registry.js';
import { PostgresTaskStore, type ContextAwareTaskStore } from './postgres-task-store.js';
import { validatePrincipal } from './auth/principal.js';
import { listCallerTokens, revokeCallerToken } from './auth/caller-token.js';

// ── Helpers ──────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function agentMessage(text: string, taskId: string, contextId: string): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'agent',
    parts: [{ kind: 'text', text: text || 'No response generated.' }],
    taskId,
    contextId,
  };
}

function extractText(message: Message): string {
  return message.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
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
- **token_hash**: Not exposed via GraphQL — use register_client tool to create tokens

## Tool Usage

- Use \`query_*\` and \`mutate_*\` tools for standard CRUD operations on clients. Use \`query_*\` tools to inspect agent policies. RLS enforces ownership.
- Use \`register_client\` to create a new client — this generates a token and hashes it before storing.
- Use \`list_active_agents\` to see currently connected agents.
- Use \`add_caller\` / \`remove_caller\` / \`list_callers\` to manage per-agent access control. Do not use GraphQL mutations to manage \`allowed_callers\`.
- Use \`list_caller_tokens\` / \`revoke_caller_token\` (admin only) to manage opaque caller tokens issued via Google OAuth device flow.
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

- When registering a client, always warn the user that the token is shown only once.
- When adding a caller, explain that the agent will require SIWE authentication from that point on.
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
    register_client: tool({
      description:
        'Register a new client owned by the current wallet. Generates a bearer token (shown only once) and stores its hash.',
      inputSchema: z.object({
        client_name: z.string().describe('Human-readable client name'),
        allowed_agent_ids: z
          .array(z.string())
          .describe('List of agent IDs this client is authorized to register'),
      }),
      execute: async ({ client_name, allowed_agent_ids }) => {
        const rawToken = generateToken();
        const tokenHash = hashToken(rawToken);
        const adminAddresses = process.env.ADMIN_WALLET_ADDRESSES ?? '';
        const result = await db.begin(async (tx) => {
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
          await tx`SELECT set_config('app.admin_addresses', ${adminAddresses}, true)`;
          return tx`
            INSERT INTO clients (owner_wallet, client_name, token_hash, allowed_agent_ids)
            VALUES (${walletAddress.toLowerCase()}, ${client_name}, ${tokenHash}, ${allowed_agent_ids})
            RETURNING id, owner_wallet, client_name, allowed_agent_ids, created_at
          `;
        });
        return { ...result[0], token: rawToken };
      },
    }),

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
        'Accepts the same principal formats as add_caller. To remove a legacy plain-0x entry, pass it as-is; ' +
        'the tool matches both the canonical eth:0x... form and the legacy form.',
      inputSchema: z.object({
        agent_id: z.string().describe('The agent ID to remove the caller from'),
        principal: z.string().describe('Principal string to remove'),
      }),
      execute: async ({ agent_id, principal }) => {
        const normalized = validatePrincipal(principal);
        if (!normalized) {
          return { error: 'Invalid principal format. See add_caller description for supported formats.' };
        }
        // Remove both canonical form and, when applicable, the legacy plain-0x form
        // (pre-principal-prefix data) so stale entries can still be cleaned out.
        const legacy = normalized.startsWith('eth:') ? normalized.slice(4) : null;
        const adminAddresses = process.env.ADMIN_WALLET_ADDRESSES ?? '';
        const result = await db.begin(async (tx) => {
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
          await tx`SELECT set_config('app.admin_addresses', ${adminAddresses}, true)`;
          if (legacy) {
            return tx`
              UPDATE agent_policies
              SET allowed_callers = array_remove(array_remove(allowed_callers, ${normalized}), ${legacy}),
                  updated_at = now()
              WHERE agent_id = ${agent_id}
                AND (${normalized} = ANY(allowed_callers) OR ${legacy} = ANY(allowed_callers))
              RETURNING agent_id, owner_wallet, allowed_callers
            `;
          }
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

class AdminAgentExecutor implements AgentExecutor {
  private readonly abortControllers = new Map<string, AbortController>();
  constructor(
    private readonly db: Sql,
    private readonly registry: Registry,
    private readonly taskStore: ContextAwareTaskStore,
  ) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;

    const metadata = (userMessage as { metadata?: Record<string, unknown> }).metadata;
    const walletAddress = metadata?._walletAddress as string | undefined;
    const bearerToken = metadata?._bearerToken as string | undefined;
    if (!walletAddress || !bearerToken) {
      throw A2AError.invalidRequest('Authenticated wallet address is required.');
    }

    const userText = extractText(userMessage);
    if (!userText) {
      throw A2AError.invalidParams('message.parts with text is required');
    }

    if (!task) {
      bus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: nowIso() },
        history: [userMessage],
        artifacts: [],
      });
    }

    bus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', message: userMessage, timestamp: nowIso() },
      final: false,
    });

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    try {
      // Run with bearer token so GraphQL tools use RLS
      const answer = await runWithBearerToken(bearerToken, async () => {
        const { tools: schemaTools, sdl } = await getSchemaTools();
        const customTools = buildCustomTools(this.db, this.registry, walletAddress);
        const tools = { ...schemaTools, ...customTools };

        // Load conversation history from previous tasks in the same context.
        // The SDK's ResultManager normally appends status.message into history
        // before saving, but as a fallback we also include status.message if
        // it wasn't recorded in history (e.g. edge cases around failures).
        const previousTasks = await this.taskStore.loadByContextId(contextId, walletAddress, taskId);
        const contextHistory: Message[] = [];
        for (const prev of previousTasks) {
          if (prev.history) contextHistory.push(...prev.history);
          const statusMsg = prev.status?.message;
          if (statusMsg && !prev.history?.some((m) => m.messageId === statusMsg.messageId)) {
            contextHistory.push(statusMsg);
          }
        }
        const currentHistory = task?.history ?? [];
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

      bus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'completed',
          message: agentMessage(answer.text, taskId, contextId),
          timestamp: nowIso(),
        },
        final: true,
      });
      bus.finished();
    } catch (error) {
      const aborted = controller.signal.aborted;
      const errorText = error instanceof Error ? error.message : 'Unknown error';
      const state = aborted ? 'canceled' : 'failed';
      const message = aborted ? 'Task canceled.' : `Error: ${errorText}`;

      bus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state,
          message: agentMessage(message, taskId, contextId),
          timestamp: nowIso(),
        },
        final: true,
      });
      bus.finished();
    } finally {
      this.abortControllers.delete(taskId);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const controller = this.abortControllers.get(taskId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }
}

// ── Agent Card & Transport ───────────────────────────────────────

export function buildAdminAgentCard(publicUrl?: string): SdkAgentCard {
  const url = publicUrl ?? '';
  return {
    name: 'Vicoop Bridge Server Admin',
    description:
      'Manages client registration, revocation, and access control for Vicoop Bridge Server. Clients are WebSocket services that bridge local A2A agents to the server. Each client is scoped to an owner wallet and an explicit agent ID allowlist. Requires SIWE authentication.',
    version: '0.1.0',
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'client-management',
        name: 'Client Management',
        description:
          'Register, revoke, and list clients with per-agent-id authorization. Wallet-based ownership with RLS.',
        tags: ['admin', 'auth', 'client', 'siwe'],
      },
    ],
  };
}

export interface AdminAgentOptions {
  db: Sql;
  registry: Registry;
  publicUrl?: string;
}

export function createAdminTransport(opts: AdminAgentOptions): JsonRpcTransportHandler {
  const card = buildAdminAgentCard(opts.publicUrl);
  const taskStore = new PostgresTaskStore(opts.db);
  const executor = new AdminAgentExecutor(opts.db, opts.registry, taskStore);
  const handler = new DefaultRequestHandler(card, taskStore, executor);
  return new JsonRpcTransportHandler(handler);
}
