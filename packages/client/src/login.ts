// `vicoop-client login` — device-flow login (issue #79). Two intents:
//
//   * default: `intent=client_register` — registers a new client and returns
//     a CLIENT_TOKEN bound to the resulting client. Required flags:
//     --bridge, --client-name, --agent-ids.
//
//   * `--owner-session`: `intent=owner_session` — issues an owner-session
//     bearer (`vbc_owner_*`) used by the admin-management subcommands
//     (add-caller etc) to authenticate against /admin-api/*. The bearer is
//     persisted to ~/.vicoop/owner-session.json (chmod 600) by default.
//     Only --bridge is required.
//
// Output: stderr is always used for human guidance. The destination of the
// "final result" depends on intent + flags:
//   * client_register, default          → stdout, env-style block
//   * client_register, --json            → stdout, JSON document
//   * client_register, --write-env-file  → file at the given path, env-style
//   * owner_session, default             → ~/.vicoop/owner-session.json (chmod 600)
//   * owner_session, --json              → stdout, JSON document
//   * owner_session, --write-env-file    → file at the given path, env-style
// Stdout-as-default for client_register keeps shell composition working
// (`$(vicoop-client login --json | jq -r .client_token)`); owner-session's
// default-to-file matches the way `gh auth login` plants ~/.config/gh/hosts.yml,
// so subsequent admin subcommands pick up the bearer with no env wiring.

import {
  atomicWriteFile,
  defaultStorePath,
  saveOwnerSession,
} from './owner-session.js';

type Intent = 'client_register' | 'owner_session';

// Modelled as a discriminated union on `intent` so TypeScript blocks
// accidental access to `clientName` / `allowedAgentIds` on the
// owner-session path (where they don't apply) and parseArgs is forced to
// validate them before constructing a ClientRegisterArgs.
interface BaseLoginArgs {
  bridge: string;
  envFile: string | null;
  json: boolean;
  pollOnce: boolean; // for tests / CI smoke
}

interface ClientRegisterArgs extends BaseLoginArgs {
  intent: 'client_register';
  clientName: string;
  allowedAgentIds: string[];
}

interface OwnerSessionArgs extends BaseLoginArgs {
  intent: 'owner_session';
}

type LoginArgs = ClientRegisterArgs | OwnerSessionArgs;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface ClientRegisterSuccess {
  intent: 'client_register';
  client_id: string;
  client_token: string;
  owner_principal: string;
  owner_email: string | null;
  client_name: string;
  allowed_agent_ids: string[];
}

interface OwnerSessionSuccess {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  principal_id: string;
  email: string | null;
}

type TokenSuccessResponse = ClientRegisterSuccess | OwnerSessionSuccess;

function isClientRegister(body: TokenSuccessResponse): body is ClientRegisterSuccess {
  return (body as ClientRegisterSuccess).intent === 'client_register';
}

interface OAuthError {
  error: string;
  error_description?: string;
}

function usage(): void {
  process.stderr.write(
    [
      'usage: vicoop-client login --bridge <https://...> --client-name <name>',
      '                          --agent-ids <id1,id2> [--write-env-file <path>] [--json]',
      '       vicoop-client login --owner-session --bridge <https://...>',
      '                          [--write-env-file <path>] [--json]',
      '',
      'Default: drives Google OAuth device flow to register a new client and prints',
      '         the resulting CLIENT_TOKEN once. Required: --bridge, --client-name, --agent-ids.',
      '',
      '--owner-session: drives the same flow but issues an owner-session bearer used',
      '         by add-caller / list-callers / list-agents / remove-caller. The token',
      '         is saved to ~/.vicoop/owner-session.json (chmod 600) by default.',
      '',
      'Flags:',
      '  --bridge          Bridge HTTP URL (e.g. https://vicoop-bridge-server.fly.dev)',
      '  --owner-session   Issue an owner-session bearer instead of registering a client.',
      '  --client-name     Human-readable client name (client_register only).',
      '  --agent-ids       CSV of agent ids this client is allowed to register as.',
      '  --write-env-file PATH',
      '                    Write env block to PATH (chmod 600).',
      '                      client_register: SERVER_URL / SERVER_TOKEN / AGENT_ID',
      '                      owner-session:   VICOOP_BRIDGE / VICOOP_OWNER_TOKEN',
      '  --env-file PATH   Deprecated alias for --write-env-file. Avoid on Node 24+',
      '                    unless your wrapper invokes node with "--" before the script.',
      '  --json            Print the token endpoint response as JSON to stdout.',
      '',
    ].join('\n'),
  );
}

function parseArgs(args: string[]): LoginArgs | null {
  let intent: Intent = 'client_register';
  let bridge: string | undefined;
  let clientName: string | undefined;
  let allowedAgentIds: string[] = [];
  let envFile: string | null = null;
  let json = false;
  let pollOnce = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--owner-session') {
      intent = 'owner_session';
      continue;
    }
    if (a === '--poll-once') {
      // Internal: bail after a single poll, regardless of state. Used by tests.
      pollOnce = true;
      continue;
    }
    const v = args[i + 1];
    if (v === undefined) {
      process.stderr.write(`flag ${a} requires a value\n`);
      return null;
    }
    switch (a) {
      case '--bridge':
        bridge = v;
        break;
      case '--client-name':
        clientName = v;
        break;
      case '--agent-ids':
        allowedAgentIds = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--write-env-file':
      case '--env-file':
        envFile = v;
        break;
      default:
        process.stderr.write(`unknown flag: ${a}\n`);
        return null;
    }
    i++;
  }
  if (!bridge) {
    usage();
    return null;
  }
  const base = { bridge, envFile, json, pollOnce };
  if (intent === 'client_register') {
    if (!clientName || allowedAgentIds.length === 0) {
      usage();
      return null;
    }
    return { intent, ...base, clientName, allowedAgentIds };
  }
  return { intent, ...base };
}

async function fetchDeviceCode(args: LoginArgs): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ intent: args.intent });
  if (args.intent === 'client_register') {
    body.set('client_name', args.clientName);
    body.set('allowed_agent_ids', args.allowedAgentIds.join(','));
  }
  const res = await fetch(`${args.bridge.replace(/\/$/, '')}/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: OAuthError | null = null;
    try {
      parsed = JSON.parse(text) as OAuthError;
    } catch {
      // ignore
    }
    const detail = parsed?.error_description ?? parsed?.error ?? text;
    throw new Error(`device/code request failed (${res.status}): ${detail}`);
  }
  return JSON.parse(text) as DeviceCodeResponse;
}

async function pollOnce(
  bridgeUrl: string,
  deviceCode: string,
): Promise<
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; body: TokenSuccessResponse }
> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  });
  const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (res.ok) {
    return { kind: 'success', body: JSON.parse(text) as TokenSuccessResponse };
  }
  let parsed: OAuthError | null = null;
  try {
    parsed = JSON.parse(text) as OAuthError;
  } catch {
    // not JSON — wrap raw text below
  }
  const code = parsed?.error;
  if (code === 'authorization_pending') return { kind: 'pending' };
  if (code === 'slow_down') return { kind: 'slow_down' };
  if (code === 'expired_token') return { kind: 'expired' };
  return {
    kind: 'error',
    message: parsed?.error_description ?? parsed?.error ?? text,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeEnvFile(path: string, success: TokenSuccessResponse, bridgeUrl: string): void {
  const lines = isClientRegister(success)
    ? [
        `# vicoop-client env (generated by 'vicoop-client login')`,
        `SERVER_URL=${bridgeUrl.replace(/^http(s?):\/\//, (_m, s) => (s === 's' ? 'wss://' : 'ws://'))}`,
        `SERVER_TOKEN=${success.client_token}`,
        `AGENT_ID=${success.allowed_agent_ids[0] ?? ''}`,
        '',
      ].join('\n')
    : [
        `# vicoop-client env (generated by 'vicoop-client login --owner-session')`,
        `VICOOP_BRIDGE=${bridgeUrl.replace(/\/$/, '')}`,
        `VICOOP_OWNER_TOKEN=${success.access_token}`,
        '',
      ].join('\n');
  // Shared atomic write helper: creates a 0o600 temp sibling and renames it
  // into place, handling Windows' non-overwriting rename so re-running
  // `login --write-env-file` updates an existing file reliably. Same
  // semantics saveOwnerSession uses.
  atomicWriteFile(path, lines, 0o600);
}

export async function runLogin(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    return 0;
  }

  const parsed = parseArgs(args);
  if (!parsed) return 1;

  let device: DeviceCodeResponse;
  try {
    device = await fetchDeviceCode(parsed);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  process.stderr.write(
    [
      '',
      'Open the following URL in your browser to authorize this client:',
      `  ${device.verification_uri_complete}`,
      '',
      `If the URL is unwieldy, browse to ${device.verification_uri} and enter:`,
      `  ${device.user_code}`,
      '',
      `Waiting for approval (expires in ${Math.floor(device.expires_in / 60)} min)…`,
      '',
    ].join('\n'),
  );

  // Hard cap polling at the session's expires_in so we don't poll forever
  // on an abandoned approval.
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(device.interval, 1) * 1000;

  while (Date.now() < deadline) {
    const result = await pollOnce(parsed.bridge, device.device_code);
    if (result.kind === 'success') {
      const success = result.body;
      process.stderr.write('\nApproved.\n\n');

      if (isClientRegister(success)) {
        process.stderr.write(
          `  client_id        ${success.client_id}\n` +
            `  owner_principal  ${success.owner_principal}\n` +
            `  owner_email      ${success.owner_email ?? '(none)'}\n` +
            `  client_name      ${success.client_name}\n` +
            `  allowed_agents   ${success.allowed_agent_ids.join(', ')}\n\n`,
        );
        process.stderr.write(
          'The CLIENT_TOKEN below is shown only once and cannot be retrieved later.\n' +
            '  Save it now (export to env, write to a vault, etc.).\n\n',
        );

        if (parsed.envFile) {
          writeEnvFile(parsed.envFile, success, parsed.bridge);
          process.stderr.write(`Wrote env block to ${parsed.envFile} (mode 600).\n`);
        } else if (parsed.json) {
          process.stdout.write(`${JSON.stringify(success, null, 2)}\n`);
        } else {
          const wsUrl = parsed.bridge.replace(/^http(s?):\/\//, (_m, s) =>
            s === 's' ? 'wss://' : 'ws://',
          );
          process.stdout.write(
            [
              `SERVER_URL=${wsUrl}`,
              `SERVER_TOKEN=${success.client_token}`,
              `AGENT_ID=${success.allowed_agent_ids[0] ?? ''}`,
              '',
            ].join('\n'),
          );
        }
      } else {
        process.stderr.write(
          `  principal_id     ${success.principal_id}\n` +
            `  email            ${success.email ?? '(none)'}\n` +
            `  expires_in       ${success.expires_in}s\n\n`,
        );

        const expiresAt = new Date(Date.now() + success.expires_in * 1000).toISOString();

        if (parsed.envFile) {
          writeEnvFile(parsed.envFile, success, parsed.bridge);
          process.stderr.write(`Wrote env block to ${parsed.envFile} (mode 600).\n`);
        } else if (parsed.json) {
          process.stdout.write(`${JSON.stringify(success, null, 2)}\n`);
        } else {
          // Default for owner-session: persist to ~/.vicoop/owner-session.json so
          // subsequent admin-management subcommands pick it up automatically. This
          // mirrors how `gh auth login` plants ~/.config/gh/hosts.yml — no env
          // wiring required for the common single-host case.
          const path = defaultStorePath();
          saveOwnerSession({
            bridge: parsed.bridge.replace(/\/$/, ''),
            token: success.access_token,
            principal_id: success.principal_id,
            email: success.email,
            expires_at: expiresAt,
            saved_at: new Date().toISOString(),
          }, path);
          process.stderr.write(
            `Saved owner-session bearer to ${path} (mode 600).\n` +
              `Use VICOOP_OWNER_TOKEN / VICOOP_BRIDGE to override per-invocation.\n`,
          );
        }
      }
      return 0;
    }
    if (result.kind === 'expired') {
      process.stderr.write('\nDevice session expired. Re-run `vicoop-client login`.\n');
      return 1;
    }
    if (result.kind === 'error') {
      process.stderr.write(`\nToken endpoint error: ${result.message}\n`);
      return 1;
    }
    if (result.kind === 'slow_down') {
      // RFC-8628 §3.5: bump interval by 5 seconds on slow_down.
      intervalMs += 5000;
    }
    if (parsed.pollOnce) return 0;
    await sleep(intervalMs);
  }

  process.stderr.write('\nDeadline exceeded waiting for approval.\n');
  return 1;
}
