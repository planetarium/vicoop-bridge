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
import { readFile } from 'node:fs/promises';
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

function federatedCallerCommand<
  const A extends 'agent-callers-add-federated' | 'agent-callers-remove-federated',
>(name: 'add-federated' | 'remove-federated', action: A) {
  const adding = action === 'agent-callers-add-federated';
  const description = adding
    ? message`Adds one exact (issuer, method, subject) tuple to the agent's allowed callers. The values are case-sensitive and must exactly match the Connector's later subject assertion. This changes receiver policy only: it does not mint an access token, resolve the DID, or contact the Connector. The policy is hot-reloaded with no daemon restart. WARNING: when allowed_callers is empty, adding this first entry changes the agent from public to restricted.`
    : message`Removes one exact (issuer, method, subject) tuple from the agent's allowed callers. The policy is hot-reloaded with no daemon restart. New exchanges are rejected immediately, existing message tokens fail their live policy check, and follow-up access to tasks bound to this tuple is revoked. WARNING: removing the final allowed caller makes the agent public for new messages; add a replacement first if it must remain restricted.`;
  const footer = adding
    ? message`Example: vicoop-client agent callers add-federated my-agent --issuer did:web:connector.example --method urn:mentionable:auth:slack-workspace-member:v0.1 --subject slack:T123/U456. Guide: https://github.com/planetarium/vicoop-bridge/blob/main/docs/manage-federated-callers.md`
    : message`Use agent callers list AGENT_ID --json to copy the exact tuple before removal. Guide: https://github.com/planetarium/vicoop-bridge/blob/main/docs/manage-federated-callers.md`;
  return command(
    name,
    object({
      action: constant(action),
      ...sharedFlags,
      agentId: argument(string({ metavar: 'AGENT_ID' }), {
        description: message`Target agent id. Find owned ids with vicoop-client agent list.`,
      }),
      issuer: option('--issuer', string({ metavar: 'DID' }), {
        description: message`Exact, case-sensitive did:web Connector issuer. Must match both the subject assertion iss and OAuth client id.`,
      }),
      method: option('--method', string({ metavar: 'URN' }), {
        description: message`Exact, case-sensitive Mentionable authentication method URN from the Connector profile. No wildcards.`,
      }),
      subject: option('--subject', string({ metavar: 'SUBJECT' }), {
        description: message`Exact, case-sensitive canonical platform subject from the assertion sub, e.g. slack:T123/U456.`,
      }),
    }),
    {
      brief: adding
        ? message`Allow one exact federated Connector/method/subject caller.`
        : message`Remove one exact federated caller and revoke its task/token authority.`,
      description,
      footer,
    },
  );
}

const agentCallersAddFederatedSubCmd = federatedCallerCommand(
  'add-federated',
  'agent-callers-add-federated',
);
const agentCallersRemoveFederatedSubCmd = federatedCallerCommand(
  'remove-federated',
  'agent-callers-remove-federated',
);

// `issue-api-key` mints a static API key — a caller the bridge creates a
// secret for, for non-interactive callers (CI, backend services) that can't
// run the Google/SIWE login flow. It lives under `callers` alongside
// add/remove/list because a key is just another caller: the `apikey:<key-id>`
// principal it returns is added to allowed-callers and listed/revoked through
// the same `callers list` / `callers remove` commands.
const agentCallersIssueSubCmd = command(
  'issue-api-key',
  object({
    action: constant('agent-callers-issue' as const),
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
    brief: message`Mint a static API key caller for the agent.`,
    description: message`Calls POST /admin-api/agents/<AGENT_ID>/apikeys. Prints the raw key exactly once — store it now; it cannot be recovered. The returned \`apikey:<key-id>\` principal is added to allowed-callers (hot-reloaded); list it with \`agent callers list\` and revoke with \`agent callers remove <AGENT_ID> apikey:<key-id>\`.`,
  },
);

const agentCallersSubCmd = command(
  'callers',
  longestMatch(
    agentCallersListSubCmd,
    agentCallersAddSubCmd,
    agentCallersRemoveSubCmd,
    agentCallersAddFederatedSubCmd,
    agentCallersRemoveFederatedSubCmd,
    agentCallersIssueSubCmd,
  ),
  {
    brief: message`Manage the agent's callers — external identities and API keys.`,
  },
);

// ----- agent x402 (pricing) ---------------------------------------------------
//
// Pricing is server-side state, not client config: `payTo` names the wallet
// that receives money, so it is stored on the agent's DB row and written only
// with the owner-session bearer. A stolen agent token can therefore not
// reprice an agent or redirect its payments. These commands are the operator's
// interface to that state, mirroring `agent callers`.

const agentX402ShowSubCmd = command(
  'show',
  object({
    action: constant('agent-x402-show' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
  }),
  {
    brief: message`Show what this agent charges, or that it is free.`,
    description: message`Calls GET /admin-api/agents/<AGENT_ID>/x402.`,
  },
);

const agentX402SetSubCmd = command(
  'set',
  object({
    action: constant('agent-x402-set' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
    file: optional(option('--file', string({ metavar: 'PATH' }), {
      description: message`Read the pricing object as JSON from PATH, or from stdin when PATH is \`-\`. Mutually exclusive with the field flags below.`,
    })),
    scheme: optional(option('--scheme', string({ metavar: 'exact|upto' }), {
      description: message`Pricing scheme. Defaults to \`exact\` (a flat fee per call).`,
    })),
    network: optional(option('--network', string({ metavar: 'CAIP2' }), {
      description: message`Chain id, e.g. eip155:84532 for Base Sepolia.`,
    })),
    asset: optional(option('--asset', string({ metavar: 'ADDRESS' }), {
      description: message`Token contract address.`,
    })),
    payTo: optional(option('--pay-to', string({ metavar: 'ADDRESS' }), {
      description: message`Wallet that receives the payment.`,
    })),
    amount: optional(option('--amount', string({ metavar: 'ATOMIC' }), {
      description: message`exact only: price per call, in the asset's smallest unit (USDC has 6 decimals, so 10000 = 0.01 USDC).`,
    })),
    maxAmount: optional(option('--max-amount', string({ metavar: 'ATOMIC' }), {
      description: message`upto only: the ceiling the payer authorizes. The metered charge is clamped to it.`,
    })),
    minAmount: optional(option('--min-amount', string({ metavar: 'ATOMIC' }), {
      description: message`upto only: floor for a completed call, and what is charged when the backend reported no token usage. Set this — without it such calls are free.`,
    })),
    rateInput: optional(option('--rate-input', string({ metavar: 'ATOMIC' }), {
      description: message`upto only: price per MILLION input tokens, in atomic units.`,
    })),
    rateOutput: optional(option('--rate-output', string({ metavar: 'ATOMIC' }), {
      description: message`upto only: price per MILLION output tokens, in atomic units.`,
    })),
    rateCachedInput: optional(option('--rate-cached-input', string({ metavar: 'ATOMIC' }), {
      description: message`upto only: price per MILLION cache-read input tokens. Omitted means the same as --rate-input, NOT free.`,
    })),
    facilitator: optional(option('--facilitator', string({ metavar: 'ADDRESS' }), {
      description: message`upto only: facilitator address the payer's Permit2 witness binds to. Read it from the facilitator's GET /supported.`,
    })),
    description: optional(option('--description', string({ metavar: 'TEXT' }), {
      description: message`Shown in the payer's wallet consent prompt.`,
    })),
  }),
  {
    brief: message`Set what this agent charges.`,
    description: message`Calls PUT /admin-api/agents/<AGENT_ID>/x402. Validated server-side against the same schema the payment gate uses, so a bad address or a non-atomic amount is rejected here rather than silently disabling payments at the agent's next connect. Hot-reloaded — no daemon restart needed. Amounts are always atomic units as decimal strings, never dollars.`,
  },
);

const agentX402ClearSubCmd = command(
  'clear',
  object({
    action: constant('agent-x402-clear' as const),
    ...sharedFlags,
    agentId: argument(string({ metavar: 'AGENT_ID' })),
  }),
  {
    brief: message`Make this agent free again.`,
    description: message`Calls DELETE /admin-api/agents/<AGENT_ID>/x402. The agent stops requesting payment on the next call.`,
  },
);

const agentX402SubCmd = command(
  'x402',
  longestMatch(agentX402ShowSubCmd, agentX402SetSubCmd, agentX402ClearSubCmd),
  {
    brief: message`Manage the agent's x402 pricing.`,
  },
);

export const agentCmd = command(
  'agent',
  // `agentCallersSubCmd` MUST come before `agentListSubCmd` / `agentRemoveSubCmd`.
  // `@optique` `longestMatch` breaks consumed-token ties by source order, and the
  // top-level `list` / `remove` commands have all-optional bodies that tie with
  // the nested `callers {list,remove} <AGENT_ID>` match — when they win the tie
  // the AGENT_ID positional is dropped and parsing fails with "Unexpected ... <id>".
  // Putting the AGENT_ID-consuming group first makes the correct branch win.
  // See admin-cli.test.ts.
  longestMatch(
    agentRegisterCmd,
    agentCallersSubCmd,
    agentX402SubCmd,
    agentListSubCmd,
    agentRemoveSubCmd,
  ),
  {
    brief: message`Manage agent registrations, their callers, and their pricing.`,
    description: message`Operator-facing umbrella for agent state. Subcommands: \`register\`, \`list\`, \`remove\`, \`callers {list, add, remove, add-federated, remove-federated, issue-api-key}\`, \`x402 {show, set, clear}\`. Replaces the older flat \`setup\` / \`list-agents\` / \`list-clients\` / \`revoke-client\` / \`{add,remove,list}-caller\` commands, which remain as deprecated aliases.`,
    hidden: 'usage',
  },
);

export type AgentCliArgs = InferValue<typeof agentCmd>;
export type AgentListArgs = Extract<AgentCliArgs, { action: 'agent-list' }>;
export type AgentDeleteArgs = Extract<AgentCliArgs, { action: 'agent-delete' }>;
export type AgentCallersListArgs = Extract<AgentCliArgs, { action: 'agent-callers-list' }>;
export type AgentCallersAddArgs = Extract<AgentCliArgs, { action: 'agent-callers-add' }>;
export type AgentCallersRemoveArgs = Extract<AgentCliArgs, { action: 'agent-callers-remove' }>;
export type AgentCallersAddFederatedArgs = Extract<
  AgentCliArgs,
  { action: 'agent-callers-add-federated' }
>;
export type AgentCallersRemoveFederatedArgs = Extract<
  AgentCliArgs,
  { action: 'agent-callers-remove-federated' }
>;
export type AgentCallersIssueArgs = Extract<AgentCliArgs, { action: 'agent-callers-issue' }>;
export type AgentX402ShowArgs = Extract<AgentCliArgs, { action: 'agent-x402-show' }>;
export type AgentX402SetArgs = Extract<AgentCliArgs, { action: 'agent-x402-set' }>;
export type AgentX402ClearArgs = Extract<AgentCliArgs, { action: 'agent-x402-clear' }>;

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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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

function renderIssuedKey(body: unknown): string {
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

// The `TYPE` column of the callers table is display-only; the `PRINCIPAL`
// column keeps the full canonical form (`eth:0x…`, `google:email:…`) so an
// operator can copy a row straight into `agent callers remove <id> <principal>`.
// `eth` is a single-segment scheme; the google schemes carry a sub-kind, so the
// type is the first two colon-separated segments.
function principalType(principal: string): string {
  if (principal.startsWith('google:')) {
    const [, kind] = principal.split(':');
    return kind ? `google:${kind}` : 'google';
  }
  const idx = principal.indexOf(':');
  return idx === -1 ? '' : principal.slice(0, idx);
}

function renderCallerList(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const b = body as {
    allowed_callers?: string[];
    federated_callers?: Array<{ issuer: string; method: string; subject: string }>;
  };
  const callers = b.allowed_callers ?? [];
  // Empty allowed_callers means the dispatcher treats the agent as public.
  // Surface that as the table's empty-state, matching the other `list`
  // commands (e.g. `agent list` → "(no connected agents)"). The agent_id /
  // owner_principal / is_public fields remain available via --json.
  if (callers.length === 0) {
    return '(no callers — agent is public)';
  }
  const callerTable = renderTable(
    ['TYPE', 'PRINCIPAL'],
    callers.map((p) => [principalType(p), p]),
  );
  const federated = b.federated_callers ?? [];
  if (federated.length === 0) return callerTable;
  return [
    callerTable,
    '',
    'FEDERATED CALLERS',
    renderTable(
      ['ISSUER', 'METHOD', 'SUBJECT'],
      federated.map((entry) => [entry.issuer, entry.method, entry.subject]),
    ),
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

interface FederatedCallerArgs extends CallerCommonArgs {
  issuer: string;
  method: string;
  subject: string;
}

async function execFederatedCaller(
  args: FederatedCallerArgs,
  method: 'POST' | 'DELETE',
): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method,
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/federated-callers`,
    body: { issuer: args.issuer, method: args.method, subject: args.subject },
  });
  return emit(result, args.json, renderCallerMutation);
}

export async function runAgentCallersAddFederated(
  args: AgentCallersAddFederatedArgs,
): Promise<number> {
  return execFederatedCaller(args, 'POST');
}

export async function runAgentCallersRemoveFederated(
  args: AgentCallersRemoveFederatedArgs,
): Promise<number> {
  return execFederatedCaller(args, 'DELETE');
}

// ----- agent x402 (pricing) ---------------------------------------------------

/**
 * Assemble the pricing object from the field flags.
 *
 * Deliberately assembles rather than validates: the server checks the result
 * against the same schema the payment gate uses, so validating here would
 * mean two copies of the rules that could drift. The one thing done locally
 * is rejecting a mix of `--file` and field flags, which is a CLI-shape error
 * the server can't see.
 */
function buildPricingFromFlags(args: AgentX402SetArgs): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  put('scheme', args.scheme);
  put('network', args.network);
  put('asset', args.asset);
  put('payTo', args.payTo);
  put('amount', args.amount);
  put('maxAmount', args.maxAmount);
  put('minAmount', args.minAmount);
  put('facilitatorAddress', args.facilitator);
  put('description', args.description);

  const rates: Record<string, unknown> = {};
  if (args.rateInput !== undefined) rates.input = args.rateInput;
  if (args.rateOutput !== undefined) rates.output = args.rateOutput;
  if (args.rateCachedInput !== undefined) rates.cachedInput = args.rateCachedInput;
  if (Object.keys(rates).length > 0) out.rates = rates;

  return Object.keys(out).length > 0 ? out : null;
}

async function readPricingFile(path: string): Promise<unknown> {
  const raw =
    path === '-'
      ? await new Promise<string>((resolve, reject) => {
          let buf = '';
          process.stdin.setEncoding('utf-8');
          process.stdin.on('data', (chunk) => {
            buf += chunk;
          });
          process.stdin.on('end', () => resolve(buf));
          process.stdin.on('error', reject);
        })
      : await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

function renderPricing(body: unknown): string {
  const b = body as { agent_id?: string; x402_pricing?: Record<string, unknown> | null };
  if (!b.x402_pricing) {
    return `agent:   ${b.agent_id ?? '?'}\npricing: free (no x402 pricing configured)`;
  }
  const p = b.x402_pricing;
  const lines = [`agent:   ${b.agent_id ?? '?'}`, `scheme:  ${String(p.scheme ?? 'exact')}`];
  lines.push(`network: ${String(p.network ?? '')}`);
  lines.push(`asset:   ${String(p.asset ?? '')}`);
  lines.push(`payTo:   ${String(p.payTo ?? '')}`);
  if (p.scheme === 'upto') {
    const rates = (p.rates ?? {}) as Record<string, unknown>;
    lines.push(`ceiling: ${String(p.maxAmount ?? '')} (authorized maximum, not the charge)`);
    lines.push(
      `rates:   in=${String(rates.input ?? '')} out=${String(rates.output ?? '')}` +
        ` cached=${rates.cachedInput === undefined ? 'same as in' : String(rates.cachedInput)}` +
        ' (per million tokens)',
    );
    lines.push(
      `floor:   ${p.minAmount === undefined ? '0 — calls the backend cannot meter are FREE' : String(p.minAmount)}`,
    );
    lines.push(`facilitator: ${String(p.facilitatorAddress ?? '')}`);
  } else {
    lines.push(`amount:  ${String(p.amount ?? '')} (per call)`);
  }
  if (p.description !== undefined) lines.push(`description: ${String(p.description)}`);
  return lines.join('\n');
}

export async function runAgentX402Show(args: AgentX402ShowArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/x402`,
  });
  return emit(result, args.json, renderPricing);
}

export async function runAgentX402Set(args: AgentX402SetArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }

  const fromFlags = buildPricingFromFlags(args);
  if (args.file !== undefined && fromFlags !== null) {
    process.stderr.write(
      '--file cannot be combined with the pricing field flags; pass the whole object one way or the other.\n',
    );
    return 1;
  }

  let pricing: unknown;
  if (args.file !== undefined) {
    try {
      pricing = await readPricingFile(args.file);
    } catch (err) {
      process.stderr.write(`could not read pricing JSON: ${(err as Error).message}\n`);
      return 1;
    }
  } else if (fromFlags !== null) {
    pricing = fromFlags;
  } else {
    process.stderr.write(
      'Nothing to set. Pass --file <path|-> or the pricing field flags (see `vicoop-client agent x402 set --help`).\n',
    );
    return 1;
  }

  const result = await callApi({
    session,
    method: 'PUT',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/x402`,
    body: pricing,
  });
  return emit(result, args.json, renderPricing);
}

export async function runAgentX402Clear(args: AgentX402ClearArgs): Promise<number> {
  const session = resolveSession(args);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/agents/${encodeURIComponent(args.agentId)}/x402`,
  });
  return emit(result, args.json, renderPricing);
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

// ----- agent callers issue-api-key (API key minting, #308) --------------------------

export async function runAgentCallersIssue(args: AgentCallersIssueArgs): Promise<number> {
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
  return emit(result, args.json, renderIssuedKey);
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
