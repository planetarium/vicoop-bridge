// Caller-management subcommands for vicoop-client. Thin wrappers over the
// bridge's deterministic /admin-api/* routes — no LLM round-trip — so they
// can be safely used in scripts and CI.
//
// Auth: each subcommand resolves an owner-session bearer via env
// (VICOOP_OWNER_TOKEN + VICOOP_BRIDGE) or the file written by
// `vicoop-client login --bridge <URL>`. If neither is present (or the
// stored token is expired) the user gets a clear "run login" hint and the
// process exits with code 1.

import { object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { argument, command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { string } from '@optique/core/valueparser';
import { resolveOwnerSession } from './owner-session.js';

// All six admin subcommands share the same auth/output flags. Define them
// once and splice into each command's parser to keep the surface uniform.
const sharedFlags = {
  bridge: optional(option('--bridge', string({ metavar: 'URL' }), {
    description: message`Override the bridge URL from the saved owner-session. Pair with --token.`,
  })),
  token: optional(option('--token', string({ metavar: 'TOKEN' }), {
    description: message`Override the owner-session token from disk. Pair with --bridge.`,
  })),
  json: withDefault(flag('--json', {
    description: message`Emit a machine-readable JSON response.`,
  }), false),
};

export const addCallerCmd = command(
  'add-caller',
  object({
    action: constant('add-caller' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    principal: argument(string({ metavar: 'PRINCIPAL' })),
  }),
  {
    brief: message`Add a principal to the agent's allowed-callers list.`,
    description: message`Calls POST /admin-api/agents/<AGENT_ID>/callers to add PRINCIPAL to the allowlist. Hot-reloaded — no daemon restart needed.`,
  },
);

export const removeCallerCmd = command(
  'remove-caller',
  object({
    action: constant('remove-caller' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    principal: argument(string({ metavar: 'PRINCIPAL' })),
  }),
  {
    brief: message`Remove a principal from the agent's allowed-callers list.`,
    description: message`Calls DELETE /admin-api/agents/<AGENT_ID>/callers?principal=<PRINCIPAL>. Hot-reloaded.`,
  },
);

export const listCallersCmd = command(
  'list-callers',
  object({
    action: constant('list-callers' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
  }),
  {
    brief: message`Show the agent's allowed-callers list.`,
  },
);

export const listAgentsCmd = command(
  'list-agents',
  object({
    action: constant('list-agents' as const),
    ...sharedFlags,
  }),
  {
    brief: message`List currently connected agents under this owner.`,
  },
);

export const listClientsCmd = command(
  'list-clients',
  object({
    action: constant('list-clients' as const),
    ...sharedFlags,
  }),
  {
    brief: message`List every client registration under this owner (including disconnected).`,
    description: message`Surfaces orphan clients left behind by an aborted setup, exited daemon, or leaked CLIENT_TOKEN. Use \`revoke-client\` to clean them up.`,
  },
);

export const revokeClientCmd = command(
  'revoke-client',
  object({
    action: constant('revoke-client' as const),
    ...sharedFlags,
    target: argument(string({ metavar: 'CLIENT_ID_OR_NAME' })),
  }),
  {
    brief: message`Revoke a client by id or unique name.`,
    description: message`Marks the clients row revoked=true and, if a daemon is live, closes its WebSocket with code 4014. Revoked clients cannot re-authenticate; the row is preserved for audit history.`,
  },
);

export type AddCallerArgs = InferValue<typeof addCallerCmd>;
export type RemoveCallerArgs = InferValue<typeof removeCallerCmd>;
export type ListCallersArgs = InferValue<typeof listCallersCmd>;
export type ListAgentsArgs = InferValue<typeof listAgentsCmd>;
export type ListClientsArgs = InferValue<typeof listClientsCmd>;
export type RevokeClientArgs = InferValue<typeof revokeClientCmd>;

interface Session {
  bridge: string;
  token: string;
}

// Auth resolution shared by every admin handler. Explicit --bridge/--token
// wins; otherwise we fall back to the file `vicoop-client login` wrote (or
// VICOOP_BRIDGE / VICOOP_OWNER_TOKEN if the operator prefers env, which is
// owner-session-bootstrap, *not* daemon runtime config — see #189 §5
// rationale).
function resolveSession(args: {
  bridge?: string;
  token?: string;
}): Session | { error: string } {
  if (args.bridge && args.token) {
    return { bridge: args.bridge.replace(/\/$/, ''), token: args.token };
  }
  const stored = resolveOwnerSession();
  const bridge = args.bridge ?? stored?.bridge;
  const token = args.token ?? stored?.token;
  if (!bridge || !token) {
    return {
      error:
        'No owner-session bearer found. Run `vicoop-client login --bridge <URL>` first, ' +
        'or pass --bridge and --token explicitly (or set VICOOP_BRIDGE / VICOOP_OWNER_TOKEN).',
    };
  }
  return { bridge: bridge.replace(/\/$/, ''), token };
}

interface RequestArgs {
  session: Session;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

interface ApiResult {
  status: number;
  body: unknown;
}

async function callApi({ session, method, path, body }: RequestArgs): Promise<ApiResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${session.bridge}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Surface DNS / ECONNREFUSED / TLS / aborted-connection failures through
    // the same emitError path the rest of the subcommands use, so the user
    // gets a clean "error (0): …" line + exit code 1 instead of an unhandled
    // rejection stack trace. Status 0 is a sentinel for "no HTTP response".
    return {
      status: 0,
      body: { error: `network error: ${(err as Error).message}` },
    };
  }
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as raw text
    }
  }
  return { status: res.status, body: parsed };
}

function emitError(result: ApiResult): void {
  if (result.body && typeof result.body === 'object' && 'error' in result.body) {
    process.stderr.write(`error (${result.status}): ${(result.body as { error: string }).error}\n`);
  } else {
    process.stderr.write(`error (${result.status}): ${JSON.stringify(result.body)}\n`);
  }
}

function emit(result: ApiResult, json: boolean, humanRender: (body: unknown) => string): number {
  // status 0 is the network-error sentinel from callApi; treat it as failure
  // alongside the regular HTTP error range.
  if (result.status === 0 || result.status >= 400) {
    emitError(result);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  } else {
    process.stdout.write(`${humanRender(result.body)}\n`);
  }
  return 0;
}

function renderCallerMutation(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as { agent_id?: string; allowed_callers?: string[]; message?: string };
  const callers = (b.allowed_callers ?? []).join(', ') || '(none — agent is public)';
  const note = b.message ? ` (${b.message})` : '';
  return `agent: ${b.agent_id}\nallowed_callers: ${callers}${note}`;
}

function renderCallerList(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as {
    agent_id?: string;
    owner_principal?: string;
    allowed_callers?: string[];
    is_public?: boolean;
  };
  const callers = (b.allowed_callers ?? []).join('\n  ') || '(none — agent is public)';
  return [
    `agent:           ${b.agent_id}`,
    `owner_principal: ${b.owner_principal}`,
    `is_public:       ${b.is_public}`,
    'allowed_callers:',
    `  ${callers}`,
  ].join('\n');
}

function renderClientList(body: unknown): string {
  if (!body || typeof body !== 'object' || !('clients' in body)) return String(body);
  const clients = (body as { clients: Array<Record<string, unknown>> }).clients;
  if (clients.length === 0) return '(no clients registered)';
  return clients
    .map((c) => {
      const agents = (c.allowed_agent_ids as string[] | undefined)?.join(', ') ?? '';
      return [
        `client_id:         ${c.client_id}`,
        `client_name:       ${c.client_name}`,
        `allowed_agent_ids: ${agents}`,
        `revoked:           ${c.revoked}`,
        `connected:         ${c.connected}`,
        `created_at:        ${c.created_at}`,
      ].join('\n');
    })
    .join('\n---\n');
}

function renderRevokeResult(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as {
    client_id?: string;
    client_name?: string;
    revoked?: boolean;
    closed_connections?: number;
  };
  return [
    `client_id:          ${b.client_id}`,
    `client_name:        ${b.client_name}`,
    `revoked:            ${b.revoked}`,
    `closed_connections: ${b.closed_connections}`,
  ].join('\n');
}

function renderAgentList(body: unknown): string {
  if (!body || typeof body !== 'object' || !('agents' in body)) return String(body);
  const agents = (body as { agents: Array<Record<string, unknown>> }).agents;
  if (agents.length === 0) return '(no connected agents)';
  return agents
    .map((a) => {
      const callers = (a.allowed_callers as string[] | undefined)?.join(', ') ?? '';
      return [
        `agent_id:    ${a.agent_id}`,
        `agent_name:  ${a.agent_name}`,
        `client_id:   ${a.client_id}`,
        `connected:   ${a.connected_at}`,
        `is_public:   ${(a.allowed_callers as string[] | undefined)?.length === 0}`,
        `callers:     ${callers}`,
      ].join('\n');
    })
    .join('\n---\n');
}

export async function runAddCaller(args: AddCallerArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'POST',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/callers`,
    body: { principal: args.principal },
  });
  return emit(result, args.json, renderCallerMutation);
}

export async function runRemoveCaller(args: RemoveCallerArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/callers?principal=${encodeURIComponent(args.principal)}`,
  });
  return emit(result, args.json, renderCallerMutation);
}

export async function runListCallers(args: ListCallersArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/callers`,
  });
  return emit(result, args.json, renderCallerList);
}

export async function runListClients(args: ListClientsArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: '/admin-api/clients',
  });
  return emit(result, args.json, renderClientList);
}

export async function runRevokeClient(args: RevokeClientArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/clients/${encodeURIComponent(args.target)}`,
  });
  return emit(result, args.json, renderRevokeResult);
}

export async function runListAgents(args: ListAgentsArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: '/admin-api/agents',
  });
  return emit(result, args.json, renderAgentList);
}

