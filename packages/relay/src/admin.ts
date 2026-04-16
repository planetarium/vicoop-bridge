import crypto from 'node:crypto';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, tool, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Message } from '@a2a-js/sdk';
import {
  A2AError,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import type { AgentCard as SdkAgentCard } from '@a2a-js/sdk';
import { hashToken, generateToken, type Sql } from './db.js';
import { getSchemaTools } from './schema-tools.js';
import { runWithBearerToken } from './graphql-client.js';
import type { Registry } from './registry.js';

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

// ── System Prompt ────────────────────────────────────────────────

function buildSystemPrompt(walletAddress: string, sdl?: string): string {
  const admin = isAdmin(walletAddress);
  const scope = admin
    ? 'You are logged in as an **admin**. You can see and manage ALL connectors across all owners.'
    : `You are logged in as wallet \`${walletAddress}\`. You can only see and manage connectors you own (RLS enforced).`;

  let prompt = `You are the Relay Admin Agent for vicoop-bridge. You manage connector registrations and access control.

## Current User

${scope}

## What you manage

Connectors are services that connect to the relay via WebSocket to register A2A agents. Each connector has:
- **id**: Unique identifier (UUID)
- **owner_wallet**: Wallet address of the owner
- **connector_name**: Human-readable name
- **allowed_agent_ids**: List of agent IDs this connector is authorized to register
- **revoked**: Whether this connector has been revoked
- **created_at**: When it was created
- **token_hash**: Not exposed via GraphQL — use register_connector tool to create tokens

## Tool Usage

- Use \`query_*\` and \`mutate_*\` tools for standard CRUD operations on connectors. RLS enforces ownership.
- Use \`register_connector\` to create a new connector — this generates a token and hashes it before storing.
- Use \`list_active_agents\` to see currently connected agents.
- Use \`execute_graphql\` for complex queries not covered by auto-generated tools.

## Important rules

- When registering a connector, always warn the user that the token is shown only once.
- Present data clearly in tables or lists.
- If asked about something outside connector management, politely explain your scope.

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
    register_connector: tool({
      description:
        'Register a new connector owned by the current wallet. Generates a bearer token (shown only once) and stores its hash.',
      inputSchema: z.object({
        connector_name: z.string().describe('Human-readable connector name'),
        allowed_agent_ids: z
          .array(z.string())
          .describe('List of agent IDs this connector is authorized to register'),
      }),
      execute: async ({ connector_name, allowed_agent_ids }) => {
        const rawToken = generateToken();
        const tokenHash = hashToken(rawToken);
        const adminAddresses = process.env.ADMIN_WALLET_ADDRESSES ?? '';
        const result = await db.begin(async (tx) => {
          await tx`SELECT set_config('role', 'app_authenticated', true)`;
          await tx`SELECT set_config('jwt.claims.wallet_address', ${walletAddress.toLowerCase()}, true)`;
          await tx`SELECT set_config('app.admin_addresses', ${adminAddresses}, true)`;
          return tx`
            INSERT INTO connectors (owner_wallet, connector_name, token_hash, allowed_agent_ids)
            VALUES (${walletAddress.toLowerCase()}, ${connector_name}, ${tokenHash}, ${allowed_agent_ids})
            RETURNING id, owner_wallet, connector_name, allowed_agent_ids, created_at
          `;
        });
        return { ...result[0], token: rawToken };
      },
    }),

    list_active_agents: tool({
      description: 'List currently connected agents with their connector identity and connection time.',
      inputSchema: z.object({}),
      execute: async () => {
        return registry.listAgents().map((a) => ({
          agent_id: a.agentId,
          connector_id: a.connectorId,
          agent_name: a.agentCard.name,
          connected_at: new Date(a.connectedAt).toISOString(),
        }));
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
        const history: Message[] = task?.history ?? [];

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

export const ADMIN_AGENT_ID = '_relay-admin';

export function buildAdminAgentCard(publicUrl?: string): SdkAgentCard {
  const url = publicUrl
    ? `${publicUrl}/agents/${ADMIN_AGENT_ID}`
    : `/agents/${ADMIN_AGENT_ID}`;
  return {
    name: 'Relay Admin',
    description:
      'Manage connector registrations, revocations, and access control for this relay. Authenticated via SIWE.',
    version: '0.1.0',
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'connector-management',
        name: 'Connector Management',
        description:
          'Register, revoke, and list connectors with per-agent-id authorization. Wallet-based ownership with RLS.',
        tags: ['admin', 'auth', 'connector', 'siwe'],
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
  const executor = new AdminAgentExecutor(opts.db, opts.registry);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  return new JsonRpcTransportHandler(handler);
}
