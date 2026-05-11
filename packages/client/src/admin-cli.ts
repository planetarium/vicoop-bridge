// Caller-management subcommands for vicoop-client. Thin wrappers over the
// bridge's deterministic /admin-api/* routes — no LLM round-trip — so they
// can be safely used in scripts and CI.
//
// Auth: each subcommand resolves an owner-session bearer via env
// (VICOOP_OWNER_TOKEN + VICOOP_BRIDGE) or the file written by
// `vicoop-client login --bridge <URL>`. If neither is present (or the
// stored token is expired) the user gets a clear "run login" hint and the
// process exits with code 1.

import { resolveOwnerSession } from './owner-session.js';

type Subcommand = 'add-caller' | 'remove-caller' | 'list-callers' | 'list-agents';

interface ParsedArgs {
  positional: string[];
  bridge?: string;
  token?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { positional: [], json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (a === '--bridge' || a === '--token') {
      const v = args[i + 1];
      if (v === undefined) return { error: `${a} requires a value` };
      if (a === '--bridge') out.bridge = v;
      else out.token = v;
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      return { error: `unknown flag: ${a}` };
    }
    out.positional.push(a);
  }
  return out;
}

function usage(sub: Subcommand): string {
  switch (sub) {
    case 'add-caller':
      return 'usage: vicoop-client add-caller <agent_id> <principal> [--bridge URL] [--token TOKEN] [--json]';
    case 'remove-caller':
      return 'usage: vicoop-client remove-caller <agent_id> <principal> [--bridge URL] [--token TOKEN] [--json]';
    case 'list-callers':
      return 'usage: vicoop-client list-callers <agent_id> [--bridge URL] [--token TOKEN] [--json]';
    case 'list-agents':
      return 'usage: vicoop-client list-agents [--bridge URL] [--token TOKEN] [--json]';
  }
}

interface Session {
  bridge: string;
  token: string;
}

function resolveSession(parsed: ParsedArgs): Session | { error: string } {
  // Explicit --bridge / --token wins over env wins over file.
  if (parsed.bridge && parsed.token) {
    return { bridge: parsed.bridge.replace(/\/$/, ''), token: parsed.token };
  }
  const stored = resolveOwnerSession();
  // Allow --bridge or --token to override one half.
  const bridge = parsed.bridge ?? stored?.bridge;
  const token = parsed.token ?? stored?.token;
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

export async function runAddCaller(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${usage('add-caller')}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${usage('add-caller')}\n`);
    return 0;
  }
  if (parsed.positional.length !== 2) {
    process.stderr.write(`${usage('add-caller')}\n`);
    return 1;
  }
  const [agentId, principal] = parsed.positional;
  const session = resolveSession(parsed);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'POST',
    path: `/admin-api/agents/${encodeURIComponent(agentId)}/callers`,
    body: { principal },
  });
  return emit(result, parsed.json, renderCallerMutation);
}

export async function runRemoveCaller(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${usage('remove-caller')}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${usage('remove-caller')}\n`);
    return 0;
  }
  if (parsed.positional.length !== 2) {
    process.stderr.write(`${usage('remove-caller')}\n`);
    return 1;
  }
  const [agentId, principal] = parsed.positional;
  const session = resolveSession(parsed);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'DELETE',
    path: `/admin-api/agents/${encodeURIComponent(agentId)}/callers?principal=${encodeURIComponent(principal)}`,
  });
  return emit(result, parsed.json, renderCallerMutation);
}

export async function runListCallers(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${usage('list-callers')}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${usage('list-callers')}\n`);
    return 0;
  }
  if (parsed.positional.length !== 1) {
    process.stderr.write(`${usage('list-callers')}\n`);
    return 1;
  }
  const [agentId] = parsed.positional;
  const session = resolveSession(parsed);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: `/admin-api/agents/${encodeURIComponent(agentId)}/callers`,
  });
  return emit(result, parsed.json, renderCallerList);
}

export async function runListAgents(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${usage('list-agents')}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${usage('list-agents')}\n`);
    return 0;
  }
  if (parsed.positional.length !== 0) {
    process.stderr.write(`${usage('list-agents')}\n`);
    return 1;
  }
  const session = resolveSession(parsed);
  if ('error' in session) {
    process.stderr.write(`${session.error}\n`);
    return 1;
  }
  const result = await callApi({
    session,
    method: 'GET',
    path: '/admin-api/agents',
  });
  return emit(result, parsed.json, renderAgentList);
}
