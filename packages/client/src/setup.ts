// Agent registration command surface: the new `vicoop-client agent register`
// (agent-first; see #224) and the legacy `vicoop-client setup` alias, both
// backed by `executeRegistration`. `setup` keeps working but prints a
// deprecation hint to stderr.

import { existsSync } from 'node:fs';
import { object } from '@optique/core/constructs';
import { map, multiple, optional, withDefault } from '@optique/core/modifiers';
import { command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { choice, string } from '@optique/core/valueparser';
import { atomicWriteFile, resolveOwnerSession } from './owner-session.js';
import { BACKEND_KINDS, type BackendKind } from './cli-args.js';
import {
  defaultConfigPath,
  readConfigRaw,
  writeConfig,
} from './config.js';

export const setupCmd = command(
  'setup',
  object({
    action: constant('setup' as const),
    clientName: option('--client-name', string({ metavar: 'NAME' }), {
      description: message`Human-readable label saved with this client registration.`,
    }),
    // We accept comma-separated IDs in a single occurrence and explode
    // them post-parse. `map()` does the split so the handler always sees
    // a clean array — no callers need to remember the historical
    // semicolon-or-comma trivia. After #219 the server enforces a single
    // id; we keep the comma-list shape here only for backward-compat.
    allowedAgentIds: map(option('--agent-ids', string({ metavar: 'ID1,ID2' }), {
      description: message`Comma-separated agent ids this client is allowed to run as.`,
    }), (raw) => raw.split(',').map((s) => s.trim()).filter(Boolean)),
    // `--caller` is repeatable; we also accept comma-separated values in a
    // single occurrence for symmetry with `--agent-ids`. `multiple` collects
    // them all; the handler flattens the per-occurrence comma split.
    callers: multiple(option('--caller', string({ metavar: 'PRINCIPAL' }), {
      description: message`Principal allowed to call this agent. Repeatable; comma-separated lists also accepted within a single occurrence.`,
    })),
    envFile: optional(option('--write-env-file', string({ metavar: 'PATH' }), {
      description: message`Also emit a shell-sourceable env file. Daemon does NOT consume these env vars; the file is purely an operator-side credentials backup / scripting hook.`,
    })),
    // `--env-file` is an alias for `--write-env-file` (older docs used it).
    envFileAlias: optional(option('--env-file', string({ metavar: 'PATH' }))),
    server: optional(option('--server', string({ metavar: 'URL' }), {
      description: message`Override the bridge URL from the saved owner-session. Pair with --token.`,
    })),
    token: optional(option('--token', string({ metavar: 'TOKEN' }), {
      description: message`Override the owner-session token from disk. Pair with --server.`,
    })),
    json: withDefault(flag('--json', {
      description: message`Print the registerClient response as JSON to stdout instead of persisting to config.json.`,
    }), false),
  }),
  {
    brief: message`[deprecated] Use \`agent register\`.`,
    description: message`Deprecated alias for \`vicoop-client agent register\`. Calls the bridge's \`registerClient\` GraphQL mutation, persists daemon credentials to \`~/.vicoop/config.json\`, and supports \`--write-env-file\` for an optional shell-sourceable env file. Will be removed in a future release.`,
  },
);

export type SetupArgs = InferValue<typeof setupCmd>;

export const agentRegisterCmd = command(
  'register',
  object({
    action: constant('agent-register' as const),
    agentId: option('--agent-id', string({ metavar: 'ID' }), {
      description: message`Agent id (routing key external A2A callers will use). The server enforces a single agent per registration.`,
    }),
    callers: multiple(option('--caller', string({ metavar: 'PRINCIPAL' }), {
      description: message`Principal allowed to call this agent. Repeatable; comma-separated lists also accepted within a single occurrence.`,
    })),
    backend: optional(option('--backend', choice([...BACKEND_KINDS]), {
      description: message`Persist this backend choice into config.json so the daemon picks it up on next start. Without this flag, the daemon falls back to the existing \`backend\` field (or the entrypoint wizard).`,
    })),
    envFile: optional(option('--write-env-file', string({ metavar: 'PATH' }), {
      description: message`Also emit a shell-sourceable env file. Daemon does NOT consume these env vars; the file is purely an operator-side credentials backup / scripting hook.`,
    })),
    envFileAlias: optional(option('--env-file', string({ metavar: 'PATH' }))),
    server: optional(option('--server', string({ metavar: 'URL' }), {
      description: message`Override the bridge URL from the saved owner-session. Pair with --token.`,
    })),
    token: optional(option('--token', string({ metavar: 'TOKEN' }), {
      description: message`Override the owner-session token from disk. Pair with --server.`,
    })),
    json: withDefault(flag('--json', {
      description: message`Print the registration response as JSON to stdout instead of persisting to config.json.`,
    }), false),
  }),
  {
    brief: message`Register an agent and persist daemon credentials.`,
    description: message`Calls the bridge's \`registerClient\` GraphQL mutation (compat name; the unified server model is agent-first) using the owner-session bearer saved by \`vicoop-client login\`, receives a one-time AGENT_TOKEN, and writes the daemon credentials into the canonical \`~/.vicoop/config.json\` (mode 600). The token is unrecoverable after this single output; back up config.json before rotating hosts. \`--json\` skips disk persistence and prints the raw response instead.`,
  },
);

export type AgentRegisterArgs = InferValue<typeof agentRegisterCmd>;

interface RegisterClientGraphQLResponse {
  data?: {
    registerClient?: {
      clientWithToken?: {
        id: string;
        token: string;
        ownerPrincipal: string;
        allowedAgentIds: string[];
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

interface ClientRegisterSuccess {
  intent: 'client_register';
  client_id: string;
  client_token: string;
  owner_principal: string;
  client_name: string;
  allowed_agent_ids: string[];
}

function gqlString(value: string): string {
  return JSON.stringify(value);
}

function gqlStringArray(values: string[]): string {
  return `[${values.map(gqlString).join(',')}]`;
}

// Wrap a string as a POSIX single-quoted shell literal so that sourcing the
// generated env file cannot trigger expansion or command substitution if any
// value (notably AGENT_ID, which echoes operator input back from the bridge)
// ever contains shell metacharacters. Single quotes disable all expansion;
// literal single quotes in the value are escaped via close-escape-reopen.
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Convert the bridge's HTTP(S) URL to the WebSocket scheme the daemon
// connects with. Shared by both the canonical config writer and the
// env-file emitter so the rewrite rule has one source of truth.
function wsUrlFromBridge(bridgeUrl: string): string {
  return bridgeUrl.replace(/^http(s?):\/\//, (_m, s) => (s === 's' ? 'wss://' : 'ws://'));
}

function envLines(success: ClientRegisterSuccess, bridgeUrl: string): string[] {
  return [
    `export SERVER_URL=${shSingleQuote(wsUrlFromBridge(bridgeUrl))}`,
    `export SERVER_TOKEN=${shSingleQuote(success.client_token)}`,
    `export AGENT_ID=${shSingleQuote(success.allowed_agent_ids[0] ?? '')}`,
  ];
}

function writeClientEnvFile(path: string, success: ClientRegisterSuccess, bridgeUrl: string): void {
  // `export` so that `. vicoop-client.env` propagates these to the daemon
  // child process. Without it, bare `KEY=VALUE` lines become shell-local
  // and the daemon exits with "missing required: agentId, server".
  atomicWriteFile(path, [
    `# vicoop-client env (generated by 'vicoop-client setup')`,
    ...envLines(success, bridgeUrl),
    '',
  ].join('\n'), 0o600);
}

// Merge into any existing config.json so operator-edited fields (backend
// defaults, card path, etc.) survive a setup re-run that's only rotating
// the server token. Returns the path written for the success message.
//
// Throws when `allowed_agent_ids` is empty — the bridge contract guarantees
// at least one entry (the operator passed `--agent-ids ...` and the mutation
// echoes them back), so an empty array is a server bug or a tampered
// response. Failing here is safer than silently overwriting a populated
// `agent_id` in config.json with `""`, which would break the daemon on
// next start with no obvious cause.
function writeConfigForSetup(
  success: ClientRegisterSuccess,
  bridgeUrl: string,
  backend: BackendKind | null,
): string {
  const firstAgentId = success.allowed_agent_ids[0];
  if (!firstAgentId) {
    throw new Error(
      'registerClient returned no allowed_agent_ids — refusing to overwrite config.json with an empty agent_id',
    );
  }
  const path = defaultConfigPath();
  // Distinguish "file does not exist" (fresh install — start from empty) from
  // "file exists but raw parse returned null" (malformed JSON / unreadable —
  // operator hand-edited it into a broken state). Silently overwriting the
  // latter would clobber whatever backend defaults the operator added before
  // the typo. Refuse and let them inspect/fix or move it aside; setup never
  // owns enough context to know whether the corrupted bytes should be lost.
  //
  // We use `readConfigRaw` rather than `readConfig` so the round trip
  // preserves operator-added or future-version keys that `normalizeConfig`
  // would drop. Setup only owns the three credential fields below;
  // everything else in the file is the operator's domain and must survive.
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const loaded = readConfigRaw(path);
    if (!loaded) {
      throw new Error(
        `${path} exists but is unreadable or not a valid JSON object — refusing to overwrite. ` +
          'Inspect / fix the file (or move it aside) and rerun setup.',
      );
    }
    existing = loaded;
  }
  existing.server_url = wsUrlFromBridge(bridgeUrl);
  existing.server_token = success.client_token;
  existing.agent_id = firstAgentId;
  if (backend) existing.backend = backend;
  writeConfig(path, existing);
  return path;
}

// Persist the canonical credentials. Returns the path written (or `null` on
// the --json path, which writes to stdout instead and has no disk side
// effect). Throws on persistence failure — the caller must surface the
// just-minted token as a recovery hatch because the bridge cannot reissue
// it. The optional `--write-env-file` write is intentionally NOT performed
// here; see `writeOptionalEnvFile` for that path's separate failure
// handling.
function persistCanonical(
  args: { json: boolean; backend: BackendKind | null },
  success: ClientRegisterSuccess,
  bridgeUrl: string,
): string | null {
  // --json keeps its scripting contract: no disk side effects, raw response
  // on stdout.
  if (args.json) {
    process.stdout.write(`${JSON.stringify(success, null, 2)}\n`);
    return null;
  }
  const configPath = writeConfigForSetup(success, bridgeUrl, args.backend);
  process.stderr.write(`Wrote ${configPath} (mode 600).\n`);
  return configPath;
}

async function registerClient(
  session: { bridge: string; token: string },
  args: { clientName: string; allowedAgentIds: readonly string[] },
): Promise<ClientRegisterSuccess> {
  const query =
    'mutation{' +
    'registerClient(input:{' +
    `clientName:${gqlString(args.clientName)},` +
    `allowedAgentIds:${gqlStringArray([...args.allowedAgentIds])}` +
    '}){clientWithToken{id token ownerPrincipal allowedAgentIds}}' +
    '}';

  const res = await fetch(`${session.bridge.replace(/\/$/, '')}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let parsed: RegisterClientGraphQLResponse | null = null;
  try {
    parsed = JSON.parse(text) as RegisterClientGraphQLResponse;
  } catch {
    // handled below
  }
  if (!res.ok || parsed?.errors?.length) {
    const detail = parsed?.errors?.map((e) => e.message).filter(Boolean).join('; ') || text;
    throw new Error(`registerClient failed (${res.status}): ${detail}`);
  }
  const client = parsed?.data?.registerClient?.clientWithToken;
  if (!client?.id || !client.token || !client.ownerPrincipal || !client.allowedAgentIds) {
    throw new Error('registerClient returned an unexpected response');
  }
  return {
    intent: 'client_register',
    client_id: client.id,
    client_token: client.token,
    owner_principal: client.ownerPrincipal,
    client_name: args.clientName,
    allowed_agent_ids: client.allowedAgentIds,
  };
}

interface CallerSetupResult {
  agent_id?: string;
  principal?: string;
  allowed_callers?: string[];
}

async function addCaller(
  session: { bridge: string; token: string },
  agentId: string,
  principal: string,
): Promise<CallerSetupResult> {
  const res = await fetch(
    `${session.bridge.replace(/\/$/, '')}/admin-api/agents/${encodeURIComponent(agentId)}/callers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ principal }),
    },
  );
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // leave raw text
    }
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    throw new Error(`add-caller failed for ${agentId} (${res.status}): ${detail}`);
  }
  return parsed as CallerSetupResult;
}

async function configureCallers(
  session: { bridge: string; token: string },
  agentIds: string[],
  callers: string[],
): Promise<void> {
  for (const agentId of agentIds) {
    for (const caller of callers) {
      const result = await addCaller(session, agentId, caller);
      const configured = (result.allowed_callers ?? []).join(', ') || '(none)';
      process.stderr.write(
        `Configured caller for ${agentId}: ${result.principal ?? caller}\n` +
          `  allowed_callers   ${configured}\n`,
      );
    }
  }
}

// Label set for human-output text. The new `agent register` and the
// deprecated `setup` share the same wire path (and identical --json shape so
// scripts on either entry point keep working) but diverge in their stderr
// vocabulary. `renderSuccessBlock` picks the right identifier (agent_id is
// the operator-supplied routing key; client_id is the legacy registration
// UUID returned by registerClient) per surface.
interface RegistrationLabels {
  cmdName: string;        // 'agent register' or 'setup'
  agentsFlag: string;     // '--agent-id' or '--agent-ids'
  tokenLabel: string;     // 'AGENT_TOKEN' or 'CLIENT_TOKEN'
  addCallerHint: string;  // 'vicoop-client agent callers add' or 'vicoop-client add-caller'
  renderSuccessBlock: (s: ClientRegisterSuccess) => string;
  renderRecoveryBlock: (s: ClientRegisterSuccess, serverUrl: string) => string;
}

interface ExecuteRegistrationOpts {
  name: string;
  allowedAgentIds: string[];
  callers: string[];
  envFile: string | null;
  // Override URL for the bridge (was `--bridge` pre-rename). Surfaced as
  // `--server` on the CLI for parity with the daemon flag (#225-style
  // rename); kept as `server` here to match the args field name.
  server: string | null;
  token: string | null;
  // Backend choice to persist into config.json (top-level `backend` field).
  // null means "leave whatever is already there"; the daemon's existing
  // precedence (CLI flag > env > config > default 'echo') still applies.
  backend: BackendKind | null;
  json: boolean;
  labels: RegistrationLabels;
}

// Shared registration flow used by both `agent register` and the legacy
// `setup` alias. Label strings are injected so callers can use the
// vocabulary appropriate to their command surface; everything else
// (preflight, GraphQL call, persistence, env-file write, caller
// configuration, recovery hatches) is identical.
async function executeRegistration(opts: ExecuteRegistrationOpts): Promise<number> {
  if (opts.allowedAgentIds.length === 0) {
    process.stderr.write(`${opts.labels.agentsFlag} is required\n`);
    return 1;
  }

  const stored = resolveOwnerSession();
  if ((opts.server && !opts.token) || (!opts.server && opts.token)) {
    process.stderr.write(
      'Pass --server and --token together. Owner-session credentials are tied to their bridge URL.\n',
    );
    return 1;
  }

  const session = opts.server && opts.token
    ? { bridge: opts.server, token: opts.token }
    : stored;
  const bridge = session?.bridge;
  const token = session?.token;
  if (!bridge || !token) {
    process.stderr.write(
      'No owner-session bearer found. Run `vicoop-client auth login --server <URL>` first, ' +
        'or pass --server and --token explicitly (or set VICOOP_BRIDGE / VICOOP_OWNER_TOKEN).\n',
    );
    return 1;
  }

  // Preflight: if the canonical config.json already exists but readConfigRaw
  // returns null (malformed JSON / not an object), abort BEFORE minting a
  // client token. Otherwise `registerClient` succeeds, the token comes back
  // exactly once from the bridge, and `writeConfigForSetup` then throws the
  // same "refusing to overwrite" error — leaving the operator with no token
  // and no record of it. Only `--json` is exempt (it skips persistence and
  // prints the token to stdout); `--server/--token` overrides change *where*
  // the owner session comes from, not *where* the credentials get persisted,
  // so they still write canonical config.json and need the same preflight.
  if (!opts.json) {
    const configPath = defaultConfigPath();
    if (existsSync(configPath) && readConfigRaw(configPath) === null) {
      process.stderr.write(
        `${configPath} exists but is unreadable / not a JSON object — ` +
          `fix or move it aside before rerunning ${opts.labels.cmdName} (refusing to mint a token we cannot save).\n`,
      );
      return 1;
    }
  }

  let success: ClientRegisterSuccess;
  try {
    success = await registerClient(
      { bridge, token },
      { clientName: opts.name, allowedAgentIds: opts.allowedAgentIds },
    );
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  process.stderr.write(
    `${opts.labels.renderSuccessBlock(success)}\n\n` +
      `The ${opts.labels.tokenLabel} is one-time — the bridge cannot reissue it.\n` +
      `  ${opts.labels.cmdName} persists it to the canonical config below; --json prints it to\n` +
      '  stdout instead. Back up that file before rotating hosts.\n' +
      '  To also stash it in a shell-sourceable env file, pass --write-env-file\n' +
      `  on this same ${opts.labels.cmdName} invocation — rerunning ${opts.labels.cmdName} later would call\n` +
      `  registerClient again and mint a NEW ${opts.labels.tokenLabel}, invalidating this\n` +
      '  one. To populate an env file from an already-issued token, copy\n' +
      '  SERVER_URL / SERVER_TOKEN / AGENT_ID out of config.json by hand.\n\n',
  );

  // Canonical persistence: if this fails the operator is left with a
  // just-minted token that exists nowhere, so dump it to stderr as a
  // recovery hatch.
  let canonicalPath: string | null;
  try {
    canonicalPath = persistCanonical(
      { json: opts.json, backend: opts.backend },
      success,
      bridge,
    );
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.stderr.write(
      `\n[recovery] canonical persistence failed AFTER registerClient succeeded. ` +
        `The bridge has issued this ${opts.labels.tokenLabel} exactly once:\n\n` +
        `${opts.labels.renderRecoveryBlock(success, wsUrlFromBridge(bridge))}\n\n` +
        '  Save these values now; they cannot be retrieved later. Rotate via ' +
        '`rotateClientToken` GraphQL mutation if you suspect leakage.\n',
    );
    return 1;
  }

  // Optional env-file emission (shell-sourceable). Errors here are NOT
  // recovery situations: the token is already safe in canonical config.json.
  // Surface a targeted warning instead of the "token was not persisted"
  // recovery block; exit non-zero so CI / scripts catch the partial failure.
  if (opts.envFile && !opts.json) {
    try {
      writeClientEnvFile(opts.envFile, success, bridge);
      process.stderr.write(`Wrote env block to ${opts.envFile} (mode 600).\n`);
    } catch (e) {
      process.stderr.write(
        `\nWARNING: --write-env-file ${opts.envFile} failed: ${(e as Error).message}\n` +
          `  The ${opts.labels.tokenLabel} was persisted to ${canonicalPath ?? '(canonical config)'} — the daemon can start without the env file.\n` +
          '  To populate the env file without rotating the token, copy SERVER_URL / SERVER_TOKEN / AGENT_ID out of config.json by hand.\n' +
          `  Re-running \`${opts.labels.cmdName} --write-env-file ...\` would mint a NEW ${opts.labels.tokenLabel} and invalidate the one just written.\n`,
      );
      return 1;
    }
  }

  if (opts.callers.length > 0) {
    try {
      await configureCallers({ bridge, token }, [...success.allowed_agent_ids], opts.callers);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    process.stderr.write('\n');
  } else {
    process.stderr.write(
      `WARNING: no callers configured. The agent is public until you run ` +
        `\`${opts.labels.addCallerHint} <agent_id> <principal>\`.\n\n`,
    );
  }

  return 0;
}

// Renderers for `setup`'s client-first stderr vocabulary. Kept here so the
// legacy alias surfaces unchanged for operators (and scripts) still parsing
// stderr; `success.client_id` is the legacy registration UUID returned by
// registerClient, not the operator-supplied agent id.
function renderSetupSuccessBlock(success: ClientRegisterSuccess): string {
  return [
    `  client_id        ${success.client_id}`,
    `  owner_principal  ${success.owner_principal}`,
    `  client_name      ${success.client_name}`,
    `  allowed_agents   ${success.allowed_agent_ids.join(', ')}`,
  ].join('\n');
}

function renderSetupRecoveryBlock(success: ClientRegisterSuccess, serverUrl: string): string {
  return [
    `  CLIENT_ID:      ${success.client_id}`,
    `  CLIENT_TOKEN:   ${success.client_token}`,
    `  SERVER_URL:     ${serverUrl}`,
    `  AGENT_ID:       ${success.allowed_agent_ids[0] ?? ''}`,
  ].join('\n');
}

// Renderers for `agent register`. Surfaces the operator-supplied agent_id
// (= `allowed_agent_ids[0]`) as the primary identifier. The legacy
// registration UUID is exposed only on the recovery path, where the operator
// may need it for an out-of-band revoke / audit.
function renderAgentRegisterSuccessBlock(success: ClientRegisterSuccess): string {
  return [
    `  agent_id         ${success.allowed_agent_ids[0] ?? ''}`,
    `  owner_principal  ${success.owner_principal}`,
  ].join('\n');
}

function renderAgentRegisterRecoveryBlock(success: ClientRegisterSuccess, serverUrl: string): string {
  return [
    `  AGENT_ID:        ${success.allowed_agent_ids[0] ?? ''}`,
    `  AGENT_TOKEN:     ${success.client_token}`,
    `  SERVER_URL:      ${serverUrl}`,
    `  registration_id: ${success.client_id}`,
  ].join('\n');
}

export async function runSetup(args: SetupArgs): Promise<number> {
  process.stderr.write(
    '[warning] `vicoop-client setup` is deprecated; ' +
      'use `vicoop-client agent register --agent-id ID` instead. ' +
      'The deprecated form will be removed in a future release.\n',
  );
  // `--caller` is repeatable AND accepts comma-separated values within each
  // occurrence — explode both into a flat list.
  const callers = args.callers.flatMap((c) =>
    c.split(',').map((s) => s.trim()).filter(Boolean),
  );
  return executeRegistration({
    name: args.clientName,
    allowedAgentIds: args.allowedAgentIds,
    callers,
    envFile: args.envFile ?? args.envFileAlias ?? null,
    server: args.server ?? null,
    token: args.token ?? null,
    backend: null,
    json: args.json,
    labels: {
      cmdName: 'setup',
      agentsFlag: '--agent-ids',
      tokenLabel: 'CLIENT_TOKEN',
      addCallerHint: 'vicoop-client add-caller',
      renderSuccessBlock: renderSetupSuccessBlock,
      renderRecoveryBlock: renderSetupRecoveryBlock,
    },
  });
}

export async function runAgentRegister(args: AgentRegisterArgs): Promise<number> {
  const callers = args.callers.flatMap((c) =>
    c.split(',').map((s) => s.trim()).filter(Boolean),
  );
  // `clientName` is required by the server's `register_client` SQL function
  // (NOT NULL on `agents.name` / `clients.client_name`) but is no longer
  // operator-supplied — it's pure display metadata that no authz / lookup
  // path depends on. Default to the agent id so the field stays populated
  // without surfacing a redundant flag in the CLI.
  return executeRegistration({
    name: args.agentId,
    allowedAgentIds: [args.agentId],
    callers,
    envFile: args.envFile ?? args.envFileAlias ?? null,
    server: args.server ?? null,
    token: args.token ?? null,
    backend: args.backend ?? null,
    json: args.json,
    labels: {
      cmdName: 'agent register',
      agentsFlag: '--agent-id',
      tokenLabel: 'AGENT_TOKEN',
      addCallerHint: 'vicoop-client agent callers add',
      renderSuccessBlock: renderAgentRegisterSuccessBlock,
      renderRecoveryBlock: renderAgentRegisterRecoveryBlock,
    },
  });
}
