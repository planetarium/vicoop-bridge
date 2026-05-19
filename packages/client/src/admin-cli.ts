// Caller-management subcommands for vicoop-client. Thin wrappers over the
// bridge's deterministic /admin-api/* routes — no LLM round-trip — so they
// can be safely used in scripts and CI.
//
// Auth: each subcommand resolves an owner-session bearer via env
// (VICOOP_OWNER_TOKEN + VICOOP_BRIDGE) or the file written by
// `vicoop-client login --bridge <URL>`. If neither is present (or the
// stored token is expired) the user gets a clear "run login" hint and the
// process exits with code 1.

import { longestMatch, object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { argument, command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { string } from '@optique/core/valueparser';
import { resolveOwnerSession } from './owner-session.js';
import { agentRegisterCmd } from './setup.js';

// All six admin subcommands share the same auth/output flags. Define them
// once and splice into each command's parser to keep the surface uniform.
const sharedFlags = {
  server: optional(option('--server', string({ metavar: 'URL' }), {
    description: message`Override the bridge URL from the saved owner-session. Pair with --token.`,
  })),
  token: optional(option('--token', string({ metavar: 'TOKEN' }), {
    description: message`Override the owner-session token from disk. Pair with --server.`,
  })),
  json: withDefault(flag('--json', {
    description: message`Emit a machine-readable JSON response.`,
  }), false),
};

// ----- New `agent <sub>` command group (#218) --------------------------------
// `agent` is the operator-facing primary resource. The legacy `list-agents` /
// `list-clients` / `revoke-client` / `{add,remove,list}-caller` commands below
// remain as deprecated aliases (see DEPRECATION_HINTS).

const agentListSubCmd = command(
  'list',
  object({
    action: constant('agent-list' as const),
    ...sharedFlags,
    connected: withDefault(flag('--connected', {
      description: message`Only show agents whose daemon is currently connected.`,
    }), false),
  }),
  {
    brief: message`List agent registrations under this owner.`,
    description: message`Calls GET /admin-api/clients (backed by the unified \`agents\` table) and prints one block per agent, including revoked and disconnected ones. Use --connected to filter to live daemons.`,
  },
);

const agentRevokeSubCmd = command(
  'revoke',
  object({
    action: constant('agent-revoke' as const),
    ...sharedFlags,
    target: argument(string({ metavar: 'AGENT_ID' })),
  }),
  {
    brief: message`Revoke an agent by id (or registration name).`,
    description: message`Calls DELETE /admin-api/clients/<AGENT_ID>. Marks the agent revoked=true and, if a daemon is live, closes its WebSocket with code 4014. The row is preserved for audit history. The legacy client_id and the registration name are still accepted for backward compatibility.`,
  },
);

const agentCallersListSubCmd = command(
  'list',
  object({
    action: constant('agent-callers-list' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
  }),
  {
    brief: message`Show the agent's allowed-callers list.`,
  },
);

const agentCallersAddSubCmd = command(
  'add',
  object({
    action: constant('agent-callers-add' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    principal: argument(string({ metavar: 'PRINCIPAL' })),
  }),
  {
    brief: message`Add a principal to the agent's allowed-callers list.`,
    description: message`Calls POST /admin-api/agents/<AGENT_ID>/callers. Hot-reloaded — no daemon restart needed.`,
  },
);

const agentCallersRemoveSubCmd = command(
  'remove',
  object({
    action: constant('agent-callers-remove' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    principal: argument(string({ metavar: 'PRINCIPAL' })),
  }),
  {
    brief: message`Remove a principal from the agent's allowed-callers list.`,
    description: message`Calls DELETE /admin-api/agents/<AGENT_ID>/callers?principal=<PRINCIPAL>. Hot-reloaded.`,
  },
);

const agentCallersSubCmd = command(
  'callers',
  longestMatch(agentCallersListSubCmd, agentCallersAddSubCmd, agentCallersRemoveSubCmd),
  {
    brief: message`Manage the agent's allowed-callers list.`,
  },
);

export const agentCmd = command(
  'agent',
  longestMatch(agentRegisterCmd, agentListSubCmd, agentRevokeSubCmd, agentCallersSubCmd),
  {
    brief: message`Manage agent registrations and their allowed callers.`,
    description: message`Operator-facing umbrella for agent state. Subcommands: \`register\`, \`list\`, \`revoke\`, \`callers {list,add,remove}\`. Replaces the older flat \`setup\` / \`list-agents\` / \`list-clients\` / \`revoke-client\` / \`{add,remove,list}-caller\` commands, which remain as deprecated aliases.`,
  },
);

export type AgentCliArgs = InferValue<typeof agentCmd>;
export type AgentListArgs = Extract<AgentCliArgs, { action: 'agent-list' }>;
export type AgentRevokeArgs = Extract<AgentCliArgs, { action: 'agent-revoke' }>;
export type AgentCallersListArgs = Extract<AgentCliArgs, { action: 'agent-callers-list' }>;
export type AgentCallersAddArgs = Extract<AgentCliArgs, { action: 'agent-callers-add' }>;
export type AgentCallersRemoveArgs = Extract<AgentCliArgs, { action: 'agent-callers-remove' }>;

// ----- Legacy flat commands (deprecated, kept as aliases) --------------------

export const addCallerCmd = command(
  'add-caller',
  object({
    action: constant('add-caller' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    principal: argument(string({ metavar: 'PRINCIPAL' })),
  }),
  {
    brief: message`[deprecated] Use \`agent callers add\`.`,
    description: message`Deprecated alias for \`vicoop-client agent callers add\`. Will be removed in a future release.`,
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
    brief: message`[deprecated] Use \`agent callers remove\`.`,
    description: message`Deprecated alias for \`vicoop-client agent callers remove\`. Will be removed in a future release.`,
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
    brief: message`[deprecated] Use \`agent callers list\`.`,
    description: message`Deprecated alias for \`vicoop-client agent callers list\`. Will be removed in a future release.`,
  },
);

export const listAgentsCmd = command(
  'list-agents',
  object({
    action: constant('list-agents' as const),
    ...sharedFlags,
  }),
  {
    brief: message`[deprecated] Use \`agent list --connected\`.`,
    description: message`Deprecated alias for \`vicoop-client agent list --connected\`. Will be removed in a future release.`,
  },
);

export const listClientsCmd = command(
  'list-clients',
  object({
    action: constant('list-clients' as const),
    ...sharedFlags,
  }),
  {
    brief: message`[deprecated] Use \`agent list\`.`,
    description: message`Deprecated alias for \`vicoop-client agent list\`. Will be removed in a future release.`,
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
    brief: message`[deprecated] Use \`agent revoke\`.`,
    description: message`Deprecated alias for \`vicoop-client agent revoke\`. Will be removed in a future release.`,
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

// Auth resolution shared by every admin handler. Explicit --server/--token
// wins; otherwise we fall back to the file `vicoop-client auth login` wrote
// (or VICOOP_BRIDGE / VICOOP_OWNER_TOKEN if the operator prefers env, which
// is owner-session-bootstrap, *not* daemon runtime config — see #189 §5
// rationale). The on-disk owner-session schema still names the field
// `bridge`; only the args / flag layer was renamed to `server` for parity
// with the daemon flag (#225-style rename folded into #218 / #224).
function resolveSession(args: {
  server?: string;
  token?: string;
}): Session | { error: string } {
  if (args.server && args.token) {
    return { bridge: args.server.replace(/\/$/, ''), token: args.token };
  }
  const stored = resolveOwnerSession();
  const bridge = args.server ?? stored?.bridge;
  const token = args.token ?? stored?.token;
  if (!bridge || !token) {
    return {
      error:
        'No owner-session bearer found. Run `vicoop-client auth login --server <URL>` first, ' +
        'or pass --server and --token explicitly (or set VICOOP_BRIDGE / VICOOP_OWNER_TOKEN).',
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

// Minimal whitespace-padded table renderer for list outputs. Column widths
// are computed from the data so short rows do not get oversize gaps; trailing
// padding on the last cell is trimmed so the output diffs cleanly. No
// box-drawing characters — terminals, pagers, and grep all stay happy.
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
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

// Agent-centric renderer for `agent list`. The /admin-api/clients response
// now carries `agent_id` (#219) which is the operator-facing primary key, so
// that's what we surface. The legacy `client_id` (a separate UUID kept for
// backward-compat with old GraphQL/scripts) stays in the --json output but is
// omitted from the human table — operators don't need to read it day to day.
function renderAgentRegistrationList(body: unknown, connectedOnly: boolean): string {
  if (!body || typeof body !== 'object' || !('clients' in body)) return String(body);
  let rows = (body as { clients: Array<Record<string, unknown>> }).clients;
  if (connectedOnly) rows = rows.filter((c) => c.connected === true);
  if (rows.length === 0) {
    return connectedOnly ? '(no connected agents)' : '(no agents registered)';
  }
  const tableRows = rows.map((c) => [
    String(c.agent_id ?? ((c.allowed_agent_ids as string[] | undefined)?.[0] ?? '')),
    String(c.client_name ?? ''),
    String(c.connected),
    String(c.revoked),
    String(c.created_at ?? ''),
  ]);
  return renderTable(
    ['AGENT_ID', 'NAME', 'CONNECTED', 'REVOKED', 'REGISTERED_AT'],
    tableRows,
  );
}

// Filter `clients[]` to connected==true while preserving the response envelope
// when emitting JSON, so `agent list --connected --json` returns the same
// shape as `agent list --json` minus disconnected rows.
function filterConnected(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !('clients' in body)) return body;
  const clients = (body as { clients: Array<Record<string, unknown>> }).clients;
  return { ...(body as object), clients: clients.filter((c) => c.connected === true) };
}

function renderClientList(body: unknown): string {
  if (!body || typeof body !== 'object' || !('clients' in body)) return String(body);
  const clients = (body as { clients: Array<Record<string, unknown>> }).clients;
  if (clients.length === 0) return '(no clients registered)';
  const tableRows = clients.map((c) => [
    String(c.client_id ?? ''),
    String(c.client_name ?? ''),
    (c.allowed_agent_ids as string[] | undefined)?.join(',') ?? '',
    String(c.revoked),
    String(c.connected),
    String(c.created_at ?? ''),
  ]);
  return renderTable(
    ['CLIENT_ID', 'CLIENT_NAME', 'ALLOWED_AGENT_IDS', 'REVOKED', 'CONNECTED', 'CREATED_AT'],
    tableRows,
  );
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
  const tableRows = agents.map((a) => {
    const callers = a.allowed_callers as string[] | undefined;
    return [
      String(a.agent_id ?? ''),
      String(a.agent_name ?? ''),
      String(a.client_id ?? ''),
      String(a.connected_at ?? ''),
      String((callers?.length ?? 0) === 0),
      callers?.join(',') ?? '',
    ];
  });
  return renderTable(
    ['AGENT_ID', 'AGENT_NAME', 'CLIENT_ID', 'CONNECTED_AT', 'IS_PUBLIC', 'CALLERS'],
    tableRows,
  );
}

// ----- New agent-* handlers --------------------------------------------------

export async function runAgentList(args: AgentListArgs): Promise<number> {
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
  // status 0 / 4xx / 5xx: surface as-is via emit's error branch.
  if (result.status === 0 || result.status >= 400) {
    return emit(result, args.json, () => '');
  }
  const filtered: ApiResult = args.connected
    ? { status: result.status, body: filterConnected(result.body) }
    : result;
  return emit(filtered, args.json, (b) => renderAgentRegistrationList(b, args.connected));
}

export async function runAgentRevoke(args: AgentRevokeArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  // The server-side resolver accepts agent_id, legacy client_id, or the
  // registration name (admin-api.ts resolveClient), so we can keep the
  // same endpoint and let the operator pass any of those.
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/clients/${encodeURIComponent(args.target)}`,
  });
  return emit(result, args.json, renderRevokeResult);
}

interface CallerCommonArgs {
  bridge?: string;
  token?: string;
  json: boolean;
  agentId: string;
}

async function execListCallers(args: CallerCommonArgs): Promise<number> {
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

async function execAddCaller(args: CallerCommonArgs & { principal: string }): Promise<number> {
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

async function execRemoveCaller(args: CallerCommonArgs & { principal: string }): Promise<number> {
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

export async function runAgentCallersList(args: AgentCallersListArgs): Promise<number> {
  return execListCallers(args);
}

export async function runAgentCallersAdd(args: AgentCallersAddArgs): Promise<number> {
  return execAddCaller(args);
}

export async function runAgentCallersRemove(args: AgentCallersRemoveArgs): Promise<number> {
  return execRemoveCaller(args);
}

// ----- Deprecated flat handlers ---------------------------------------------
// Each emits a one-line stderr warning suggesting the new form and then
// dispatches to the same implementation.

function warnDeprecated(oldForm: string, newForm: string): void {
  process.stderr.write(
    `[warning] \`vicoop-client ${oldForm}\` is deprecated; ` +
      `use \`vicoop-client ${newForm}\` instead. ` +
      'The deprecated form will be removed in a future release.\n',
  );
}

export async function runAddCaller(args: AddCallerArgs): Promise<number> {
  warnDeprecated('add-caller', 'agent callers add');
  return execAddCaller(args);
}

export async function runRemoveCaller(args: RemoveCallerArgs): Promise<number> {
  warnDeprecated('remove-caller', 'agent callers remove');
  return execRemoveCaller(args);
}

export async function runListCallers(args: ListCallersArgs): Promise<number> {
  warnDeprecated('list-callers', 'agent callers list');
  return execListCallers(args);
}

export async function runListClients(args: ListClientsArgs): Promise<number> {
  warnDeprecated('list-clients', 'agent list');
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
  warnDeprecated('revoke-client', 'agent revoke');
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
  warnDeprecated('list-agents', 'agent list --connected');
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

