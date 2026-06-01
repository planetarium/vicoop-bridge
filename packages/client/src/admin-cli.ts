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
import { integer, string } from '@optique/core/valueparser';
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
// remain as deprecated aliases; each handler calls `warnDeprecated` before
// dispatching to the new shape.
//
// `list` / `remove` accept the docker-style short aliases (`ls` / `rm`) for
// parity with the `container` group; `agent delete` is kept as a third alias
// on the remove command because it was the canonical form briefly after the
// `revoke-client` rename. Each alias is registered with `hidden: 'help'` so
// only the canonical name shows in usage/docs — the aliases still parse and
// still surface in "did you mean?" suggestions.

function agentListCommand(name: 'list' | 'ls', alias: boolean) {
  return command(
    name,
    object({
      action: constant('agent-list' as const),
      ...sharedFlags,
      connected: withDefault(flag('--connected', {
        description: message`Only show agents whose daemon is currently connected.`,
      }), false),
    }),
    {
      brief: message`List agent registrations under this owner. (alias: \`ls\`)`,
      description: message`Calls GET /admin-api/clients (backed by the unified \`agents\` table) and prints one block per agent, including disconnected ones. Use --connected to filter to live daemons.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const agentListSubCmd = longestMatch(
  agentListCommand('list', false),
  agentListCommand('ls', true),
);

function agentRemoveCommand(name: 'remove' | 'rm' | 'delete', alias: boolean) {
  return command(
    name,
    object({
      action: constant('agent-delete' as const),
      ...sharedFlags,
      target: argument(string({ metavar: 'AGENT_ID' })),
      yes: withDefault(flag('--yes', {
        description: message`Skip the confirmation prompt.`,
      }), false),
    }),
    {
      brief: message`Remove an agent by id (or registration name). (aliases: \`rm\`, \`delete\`)`,
      description: message`Calls DELETE /admin-api/clients/<AGENT_ID>. Hard-deletes the agents and clients rows, and if a daemon is live closes its WebSocket with code 4014 ("client deleted") so it exits without reconnecting. There is no undo. The legacy client_id and the registration name are still accepted for backward compatibility. Prompts for Y/N confirmation unless --yes / -y is set.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const agentRemoveSubCmd = longestMatch(
  agentRemoveCommand('remove', false),
  agentRemoveCommand('rm', true),
  agentRemoveCommand('delete', true),
);

function agentCallersListCommand(name: 'list' | 'ls', alias: boolean) {
  return command(
    name,
    object({
      action: constant('agent-callers-list' as const),
      ...sharedFlags,
      agentId: argument(string({ metavar: 'AGENT_ID' })),
    }),
    {
      brief: message`Show the agent's allowed-callers list. (alias: \`ls\`)`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const agentCallersListSubCmd = longestMatch(
  agentCallersListCommand('list', false),
  agentCallersListCommand('ls', true),
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

function agentCallersRemoveCommand(name: 'remove' | 'rm', alias: boolean) {
  return command(
    name,
    object({
      action: constant('agent-callers-remove' as const),
      ...sharedFlags,
      agentId: argument(string({ metavar: 'AGENT_ID' })),
      principal: argument(string({ metavar: 'PRINCIPAL' })),
    }),
    {
      brief: message`Remove a principal from the agent's allowed-callers list. (alias: \`rm\`)`,
      description: message`Calls DELETE /admin-api/agents/<AGENT_ID>/callers?principal=<PRINCIPAL>. Hot-reloaded.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const agentCallersRemoveSubCmd = longestMatch(
  agentCallersRemoveCommand('remove', false),
  agentCallersRemoveCommand('rm', true),
);

const agentCallersSubCmd = command(
  'callers',
  longestMatch(agentCallersListSubCmd, agentCallersAddSubCmd, agentCallersRemoveSubCmd),
  {
    brief: message`Manage the agent's allowed-callers list.`,
  },
);

// ----- `agent apikey <sub>` command group (#308) -----------------------------
// Static API keys let non-interactive callers (CI, backend services)
// authenticate with a single Bearer instead of a Google/SIWE login flow. Each
// key is a server-minted caller token whose `apikey:<key-id>` principal is
// auto-added to the agent's allowed-callers, so issuing a key both creates the
// credential and authorizes it for the agent in one step.

const agentApikeyGenerateSubCmd = command(
  'generate',
  object({
    action: constant('agent-apikey-generate' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    label: optional(option('--label', string({ metavar: 'LABEL' }), {
      description: message`Human-readable label stored alongside the key (e.g. "ci-deploy").`,
    })),
    ttlDays: optional(option('--ttl-days', integer({ metavar: 'DAYS', min: 1 }), {
      description: message`Key lifetime in days. Defaults to 365 on the server.`,
    })),
  }),
  {
    brief: message`Mint a static API key for the agent.`,
    description: message`Calls POST /admin-api/agents/<AGENT_ID>/apikeys. Prints the raw key exactly once — store it now; it cannot be recovered. The key's principal is auto-added to the agent's allowed-callers and hot-reloaded.`,
  },
);

function agentApikeyListCommand(name: 'list' | 'ls', alias: boolean) {
  return command(
    name,
    object({
      action: constant('agent-apikey-list' as const),
      ...sharedFlags,
      agentId: argument(string({ metavar: 'AGENT_ID' })),
    }),
    {
      brief: message`List the agent's API keys. (alias: \`ls\`)`,
      description: message`Calls GET /admin-api/agents/<AGENT_ID>/apikeys. Shows key ids, labels, and expiry — never the raw secret.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const agentApikeyListSubCmd = longestMatch(
  agentApikeyListCommand('list', false),
  agentApikeyListCommand('ls', true),
);

function agentApikeyRevokeCommand(name: 'revoke' | 'rm', alias: boolean) {
  return command(
    name,
    object({
      action: constant('agent-apikey-revoke' as const),
      ...sharedFlags,
      agentId: argument(string({ metavar: 'AGENT_ID' })),
      keyId: argument(string({ metavar: 'KEY_ID' })),
    }),
    {
      brief: message`Revoke an API key by id. (alias: \`rm\`)`,
      description: message`Calls DELETE /admin-api/agents/<AGENT_ID>/apikeys/<KEY_ID>. Removes the principal from allowed-callers and marks the token revoked; takes effect within ~60s.`,
      ...(alias ? { hidden: 'help' as const } : {}),
    },
  );
}

const agentApikeyRevokeSubCmd = longestMatch(
  agentApikeyRevokeCommand('revoke', false),
  agentApikeyRevokeCommand('rm', true),
);

const agentApikeySubCmd = command(
  'apikey',
  longestMatch(agentApikeyGenerateSubCmd, agentApikeyListSubCmd, agentApikeyRevokeSubCmd),
  {
    brief: message`Manage the agent's static API keys.`,
  },
);

export const agentCmd = command(
  'agent',
  longestMatch(
    agentRegisterCmd,
    agentListSubCmd,
    agentRemoveSubCmd,
    agentCallersSubCmd,
    agentApikeySubCmd,
  ),
  {
    brief: message`Manage agent registrations, allowed callers, and API keys.`,
    description: message`Operator-facing umbrella for agent state. Subcommands: \`register\`, \`list\`, \`remove\`, \`callers {list, add, remove}\`, \`apikey {generate, list, revoke}\`. Replaces the older flat \`setup\` / \`list-agents\` / \`list-clients\` / \`revoke-client\` / \`{add,remove,list}-caller\` commands, which remain as deprecated aliases.`,
    hidden: 'usage',
  },
);

export type AgentCliArgs = InferValue<typeof agentCmd>;
export type AgentListArgs = Extract<AgentCliArgs, { action: 'agent-list' }>;
export type AgentDeleteArgs = Extract<AgentCliArgs, { action: 'agent-delete' }>;
export type AgentCallersListArgs = Extract<AgentCliArgs, { action: 'agent-callers-list' }>;
export type AgentCallersAddArgs = Extract<AgentCliArgs, { action: 'agent-callers-add' }>;
export type AgentCallersRemoveArgs = Extract<AgentCliArgs, { action: 'agent-callers-remove' }>;
export type AgentApikeyGenerateArgs = Extract<AgentCliArgs, { action: 'agent-apikey-generate' }>;
export type AgentApikeyListArgs = Extract<AgentCliArgs, { action: 'agent-apikey-list' }>;
export type AgentApikeyRevokeArgs = Extract<AgentCliArgs, { action: 'agent-apikey-revoke' }>;

// ----- Legacy flat commands (deprecated, kept as aliases) --------------------
//
// `hidden: 'help'` drops these from both the Usage: block and the brief
// listing at top-level help, while keeping scoped help
// (`vicoop-client add-caller --help`) and "did you mean?" suggestions —
// so operators still on the old form discover the deprecation warning
// from runtime stderr and from the per-command help page.

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
    hidden: 'help',
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
    hidden: 'help',
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
    hidden: 'help',
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
    hidden: 'help',
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
    hidden: 'help',
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
    brief: message`[deprecated] Use \`agent remove\`.`,
    description: message`Deprecated alias for \`vicoop-client agent remove\` (also accepts \`rm\` / \`delete\`). Hard-deletes the agent (renamed from revoke). Will be removed in a future release.`,
    hidden: 'help',
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

function renderApikeyGenerate(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as {
    agent_id?: string;
    key_id?: string;
    principal?: string;
    api_key?: string;
    label?: string | null;
    expires_at?: string;
  };
  return [
    `agent:      ${b.agent_id}`,
    `key_id:     ${b.key_id}`,
    `principal:  ${b.principal}`,
    `label:      ${b.label ?? '(none)'}`,
    `expires_at: ${b.expires_at}`,
    '',
    'API key (shown once — store it now, it cannot be recovered):',
    `  ${b.api_key}`,
  ].join('\n');
}

function renderApikeyList(body: unknown): string {
  if (!body || typeof body !== 'object' || !('keys' in body)) return String(body);
  const keys = (body as { keys: Array<Record<string, unknown>> }).keys;
  if (keys.length === 0) return '(no API keys)';
  const tableRows = keys.map((k) => [
    String(k.key_id ?? ''),
    String((k.label as string | null) ?? ''),
    String(k.revoked),
    String(k.expires_at ?? ''),
    String((k.last_used_at as string | null) ?? '(never)'),
  ]);
  return renderTable(
    ['KEY_ID', 'LABEL', 'REVOKED', 'EXPIRES_AT', 'LAST_USED_AT'],
    tableRows,
  );
}

function renderApikeyRevoke(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as { agent_id?: string; key_id?: string; revoked?: boolean };
  return `agent: ${b.agent_id}\nkey_id: ${b.key_id}\nrevoked: ${b.revoked}`;
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
    String(c.created_at ?? ''),
  ]);
  return renderTable(
    ['AGENT_ID', 'NAME', 'CONNECTED', 'REGISTERED_AT'],
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
    String(c.connected),
    String(c.created_at ?? ''),
  ]);
  return renderTable(
    ['CLIENT_ID', 'CLIENT_NAME', 'ALLOWED_AGENT_IDS', 'CONNECTED', 'CREATED_AT'],
    tableRows,
  );
}

function renderDeleteResult(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as {
    client_id?: string;
    client_name?: string;
    deleted?: boolean;
    closed_connections?: number;
  };
  return [
    `client_id:          ${b.client_id}`,
    `client_name:        ${b.client_name}`,
    `deleted:            ${b.deleted}`,
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

// Y/N confirmation prompt for destructive actions. Returns true when the
// operator typed `y` / `yes` (case-insensitive). Any other input — including
// EOF, just-pressing-enter, or stdin not being a TTY — returns false so a
// non-interactive invocation does not silently delete. Operators in scripts
// must pass --yes / -y to bypass.
async function confirmYN(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${promptText} [y/N] `);
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      process.stdin.off('data', onData);
      process.stdin.pause();
      const answer = buf.slice(0, nl).trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function execAgentDelete(
  session: Session,
  target: string,
  json: boolean,
): Promise<number> {
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/clients/${encodeURIComponent(target)}`,
  });
  return emit(result, json, renderDeleteResult);
}

export async function runAgentDelete(args: AgentDeleteArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  if (!args.yes) {
    const ok = await confirmYN(
      `Delete agent "${args.target}"? This hard-deletes the registration and cannot be undone.`,
    );
    if (!ok) {
      process.stderr.write('aborted\n');
      return 1;
    }
  }
  // The server-side resolver accepts agent_id, legacy client_id, or the
  // registration name (admin-api.ts resolveClient), so we can keep the
  // same endpoint and let the operator pass any of those.
  return execAgentDelete(session, args.target, args.json);
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

// ----- agent apikey handlers (#308) -----------------------------------------

export async function runAgentApikeyGenerate(args: AgentApikeyGenerateArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const body: { label?: string; ttlDays?: number } = {};
  if (args.label !== undefined) body.label = args.label;
  if (args.ttlDays !== undefined) body.ttlDays = args.ttlDays;
  const result = await callApi({
    session,
    method: 'POST',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/apikeys`,
    body,
  });
  return emit(result, args.json, renderApikeyGenerate);
}

export async function runAgentApikeyList(args: AgentApikeyListArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/apikeys`,
  });
  return emit(result, args.json, renderApikeyList);
}

export async function runAgentApikeyRevoke(args: AgentApikeyRevokeArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/apikeys/${encodeURIComponent(args.keyId)}`,
  });
  return emit(result, args.json, renderApikeyRevoke);
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
  warnDeprecated('revoke-client', 'agent remove');
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  // The deprecated alias intentionally skips the Y/N prompt to preserve the
  // previous behavior of revoke-client (revocation was script-friendly). The
  // new `agent delete` command is the prompting form.
  return execAgentDelete(session, args.target, args.json);
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

