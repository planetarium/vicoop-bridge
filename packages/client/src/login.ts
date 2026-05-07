// `vicoop-client login` — device-flow client registration (issue #79).
//
// Drives the bridge's RFC-8628 device authorization endpoint with
// intent=client_register, prints the verification URL + user_code for the
// operator to open in a browser, polls /oauth/token until approved, and
// hands back a CLIENT_TOKEN. No SIWE / wallet involved.
//
// Output goes to stderr for human guidance; the final result is written to
// stdout as either an env-style block or a JSON document. That keeps shell
// composition (`$(vicoop-client login --json | jq -r .client_token)`)
// straightforward.

import { writeFileSync, chmodSync } from 'node:fs';

interface LoginArgs {
  bridge: string;
  clientName: string;
  allowedAgentIds: string[];
  envFile: string | null;
  json: boolean;
  pollOnce: boolean; // for tests / CI smoke
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenSuccessResponse {
  intent: 'client_register';
  client_id: string;
  client_token: string;
  owner_principal: string;
  owner_email: string | null;
  client_name: string;
  allowed_agent_ids: string[];
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
      '',
      'Drives Google OAuth device flow against the bridge to register a new client.',
      'Prints the resulting CLIENT_TOKEN once — save it immediately, it is unrecoverable.',
      '',
      'Flags:',
      '  --bridge          Bridge HTTP URL (e.g. https://vicoop-bridge-server.fly.dev)',
      '  --client-name     Human-readable client name shown in admin tooling',
      '  --agent-ids       CSV of agent ids this client is allowed to register as',
      '  --write-env-file PATH',
      '                    Write SERVER_URL / SERVER_TOKEN / AGENT_ID env block to PATH',
      '                    (chmod 600). When omitted, the env block is printed to stdout.',
      '  --env-file PATH   Deprecated alias for --write-env-file. Avoid on Node 24+',
      '                    unless your wrapper invokes node with "--" before the script.',
      '  --json            Print the token endpoint response as JSON to stdout instead.',
      '',
    ].join('\n'),
  );
}

function parseArgs(args: string[]): LoginArgs | null {
  const out: Partial<LoginArgs> & { allowedAgentIds: string[] } = {
    allowedAgentIds: [],
    envFile: null,
    json: false,
    pollOnce: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      usage();
      return null;
    }
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--poll-once') {
      // Internal: bail after a single poll, regardless of state. Used by tests.
      out.pollOnce = true;
      continue;
    }
    const v = args[i + 1];
    if (v === undefined) {
      process.stderr.write(`flag ${a} requires a value\n`);
      return null;
    }
    switch (a) {
      case '--bridge':
        out.bridge = v;
        break;
      case '--client-name':
        out.clientName = v;
        break;
      case '--agent-ids':
        out.allowedAgentIds = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--write-env-file':
      case '--env-file':
        out.envFile = v;
        break;
      default:
        process.stderr.write(`unknown flag: ${a}\n`);
        return null;
    }
    i++;
  }
  if (!out.bridge || !out.clientName || out.allowedAgentIds.length === 0) {
    usage();
    return null;
  }
  return out as LoginArgs;
}

async function fetchDeviceCode(args: LoginArgs): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    intent: 'client_register',
    client_name: args.clientName,
    allowed_agent_ids: args.allowedAgentIds.join(','),
  });
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
  const wsUrl = bridgeUrl.replace(/^http(s?):\/\//, (_m, s) => (s === 's' ? 'wss://' : 'ws://'));
  const lines = [
    `# vicoop-client env (generated by 'vicoop-client login')`,
    `SERVER_URL=${wsUrl}`,
    `SERVER_TOKEN=${success.client_token}`,
    `AGENT_ID=${success.allowed_agent_ids[0] ?? ''}`,
    '',
  ].join('\n');
  writeFileSync(path, lines);
  // chmod 600 so a peer process on the same host can't read the token. Best
  // effort — fails silently on filesystems that don't support POSIX modes.
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
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
      process.stderr.write(
        `  client_id        ${success.client_id}\n` +
          `  owner_principal  ${success.owner_principal}\n` +
          `  owner_email      ${success.owner_email ?? '(none)'}\n` +
          `  client_name      ${success.client_name}\n` +
          `  allowed_agents   ${success.allowed_agent_ids.join(', ')}\n\n`,
      );
      process.stderr.write(
        '⚠ The CLIENT_TOKEN below is shown only once and cannot be retrieved later.\n' +
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
