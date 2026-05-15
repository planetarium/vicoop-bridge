// `vicoop-client setup` — create a bridge client token using an existing
// owner-session bearer, then persist the daemon credentials to the canonical
// `config.json`. `--write-env-file` remains as an opt-in for operators who
// want a shell-sourceable env file alongside the canonical config — see #137.

import { existsSync } from 'node:fs';
import { object } from '@optique/core/constructs';
import { map, multiple, optional, withDefault } from '@optique/core/modifiers';
import { command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { string } from '@optique/core/valueparser';
import { atomicWriteFile, resolveOwnerSession } from './owner-session.js';
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
    // semicolon-or-comma trivia.
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
      description: message`Also emit a shell-sourceable env file. Daemon does NOT consume these env vars (#189 §5); the file is purely an operator-side credentials backup / scripting hook.`,
    })),
    // `--env-file` is an alias for `--write-env-file` (older docs used it).
    envFileAlias: optional(option('--env-file', string({ metavar: 'PATH' }))),
    bridge: optional(option('--bridge', string({ metavar: 'URL' }), {
      description: message`Override the bridge URL from the saved owner-session. Pair with --token.`,
    })),
    token: optional(option('--token', string({ metavar: 'TOKEN' }), {
      description: message`Override the owner-session token from disk. Pair with --bridge.`,
    })),
    json: withDefault(flag('--json', {
      description: message`Print the registerClient response as JSON to stdout instead of persisting to config.json.`,
    }), false),
  }),
  {
    brief: message`Register a bridge client and persist daemon credentials.`,
    description: message`Calls the bridge's \`registerClient\` GraphQL mutation using the owner-session bearer (saved by \`vicoop-client login\`, or supplied via --bridge/--token), receives a one-time CLIENT_TOKEN, and writes the daemon credentials into the canonical \`~/.vicoop/config.json\` (mode 600). The token is unrecoverable after this single output; back up config.json before rotating hosts. \`--json\` skips disk persistence and prints the raw response instead.`,
  },
);

export type SetupArgs = InferValue<typeof setupCmd>;

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
function writeConfigForSetup(success: ClientRegisterSuccess, bridgeUrl: string): string {
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
  args: { json: boolean },
  success: ClientRegisterSuccess,
  bridgeUrl: string,
): string | null {
  // --json keeps its scripting contract: no disk side effects, raw response
  // on stdout.
  if (args.json) {
    process.stdout.write(`${JSON.stringify(success, null, 2)}\n`);
    return null;
  }
  const configPath = writeConfigForSetup(success, bridgeUrl);
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

export async function runSetup(args: SetupArgs): Promise<number> {
  if (args.allowedAgentIds.length === 0) {
    process.stderr.write('--agent-ids is required\n');
    return 1;
  }
  // `--caller` is repeatable AND accepts comma-separated values within each
  // occurrence — explode both into a flat list.
  const callers = args.callers.flatMap((c) =>
    c.split(',').map((s) => s.trim()).filter(Boolean),
  );
  const envFile = args.envFile ?? args.envFileAlias ?? null;

  const stored = resolveOwnerSession();
  if ((args.bridge && !args.token) || (!args.bridge && args.token)) {
    process.stderr.write(
      'Pass --bridge and --token together. Owner-session credentials are tied to their bridge URL.\n',
    );
    return 1;
  }

  const session = args.bridge && args.token
    ? { bridge: args.bridge, token: args.token }
    : stored;
  const bridge = session?.bridge;
  const token = session?.token;
  if (!bridge || !token) {
    process.stderr.write(
      'No owner-session bearer found. Run `vicoop-client login --bridge <URL>` first, ' +
        'or pass --bridge and --token explicitly (or set VICOOP_BRIDGE / VICOOP_OWNER_TOKEN).\n',
    );
    return 1;
  }

  // Preflight: if the canonical config.json already exists but readConfigRaw
  // returns null (malformed JSON / not an object), abort BEFORE minting a
  // client token. Otherwise `registerClient` succeeds, the token comes back
  // exactly once from the bridge, and `writeConfigForSetup` then throws the
  // same "refusing to overwrite" error — leaving the operator with no token
  // and no record of it. Only `--json` is exempt (it skips
  // `writeClientSetupOutput` entirely and prints the token to stdout);
  // `--bridge/--token` overrides change *where* the owner session comes
  // from, not *where* the client credentials get persisted, so they still
  // write canonical config.json and need the same preflight.
  if (!args.json) {
    const configPath = defaultConfigPath();
    if (existsSync(configPath) && readConfigRaw(configPath) === null) {
      process.stderr.write(
        `${configPath} exists but is unreadable / not a JSON object — ` +
          'fix or move it aside before rerunning setup (refusing to mint a token we cannot save).\n',
      );
      return 1;
    }
  }

  let success: ClientRegisterSuccess;
  try {
    success = await registerClient(
      { bridge, token },
      { clientName: args.clientName, allowedAgentIds: args.allowedAgentIds },
    );
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  process.stderr.write(
    `  client_id        ${success.client_id}\n` +
      `  owner_principal  ${success.owner_principal}\n` +
      `  client_name      ${success.client_name}\n` +
      `  allowed_agents   ${success.allowed_agent_ids.join(', ')}\n\n` +
      'The CLIENT_TOKEN is one-time — the bridge cannot reissue it.\n' +
      '  setup persists it to the canonical config below; --json prints it to\n' +
      '  stdout instead. Back up that file before rotating hosts.\n' +
      '  To also stash it in a shell-sourceable env file, pass --write-env-file\n' +
      '  on this same setup invocation — rerunning setup later would call\n' +
      '  registerClient again and mint a NEW CLIENT_TOKEN, invalidating this\n' +
      '  one. To populate an env file from an already-issued token, copy\n' +
      '  SERVER_URL / SERVER_TOKEN / AGENT_ID out of config.json by hand.\n\n',
  );

  // Canonical persistence: if this fails the operator is left with a
  // just-minted token that exists nowhere, so dump it to stderr as a
  // recovery hatch.
  let canonicalPath: string | null;
  try {
    canonicalPath = persistCanonical({ json: args.json }, success, bridge);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    // The preflight above catches the common "existing config is malformed"
    // case before minting, but a disk-full / EPERM failure during the
    // write itself can still strand the token. Surface it on stderr so
    // the operator can save it manually instead of being left with an
    // unrecoverable bridge registration. The token still goes to stderr
    // (not stdout) so `--json`-style pipelines aren't affected — they
    // would have taken the --json branch inside persistCanonical.
    process.stderr.write(
      '\n[recovery] canonical persistence failed AFTER registerClient succeeded. The bridge has issued this CLIENT_TOKEN exactly once:\n' +
        `\n  CLIENT_ID:      ${success.client_id}\n` +
        `  CLIENT_TOKEN:   ${success.client_token}\n` +
        `  SERVER_URL:     ${wsUrlFromBridge(bridge)}\n` +
        `  AGENT_ID:       ${success.allowed_agent_ids[0] ?? ''}\n\n` +
        '  Save these values now; they cannot be retrieved later. Rotate via ' +
        '`rotateClientToken` GraphQL mutation if you suspect leakage.\n',
    );
    return 1;
  }

  // Optional env-file emission (shell-sourceable). Errors here
  // are NOT recovery situations: the token is already safe in canonical
  // config.json. Surface a targeted warning that tells the operator how
  // to populate the env file by hand without rotating the token (rerunning
  // `setup --write-env-file` would mint a new CLIENT_TOKEN). Exit
  // non-zero so CI / scripts catch the partial failure, but with a
  // distinct message — not the "token was not persisted" recovery block.
  if (envFile && !args.json) {
    try {
      writeClientEnvFile(envFile, success, bridge);
      process.stderr.write(`Wrote env block to ${envFile} (mode 600).\n`);
    } catch (e) {
      process.stderr.write(
        `\nWARNING: --write-env-file ${envFile} failed: ${(e as Error).message}\n` +
          `  The CLIENT_TOKEN was persisted to ${canonicalPath ?? '(canonical config)'} — the daemon can start without the env file.\n` +
          '  To populate the env file without rotating the token, copy SERVER_URL / SERVER_TOKEN / AGENT_ID out of config.json by hand.\n' +
          '  Re-running `setup --write-env-file ...` would mint a NEW CLIENT_TOKEN and invalidate the one just written.\n',
      );
      return 1;
    }
  }

  if (callers.length > 0) {
    try {
      await configureCallers({ bridge, token }, [...success.allowed_agent_ids], callers);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    process.stderr.write('\n');
  } else {
    process.stderr.write(
      'WARNING: no callers configured. The agent is public until you run ' +
        '`vicoop-client add-caller <agent_id> <principal>`.\n\n',
    );
  }

  return 0;
}
