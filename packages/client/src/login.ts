// `vicoop-client login` — authenticate the operator and persist an
// owner-session bearer. Client creation is deliberately handled by
// `vicoop-client setup` so login has no server-side client-registration
// side effects.

import { object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { parse } from '@optique/core/parser';
import { formatMessage } from '@optique/core/message';
import { string } from '@optique/core/valueparser';
import {
  defaultStorePath,
  saveOwnerSession,
} from './owner-session.js';

interface LoginArgs {
  bridge: string;
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

interface OwnerSessionSuccess {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  principal_id: string;
  email: string | null;
}

interface OAuthError {
  error: string;
  error_description?: string;
}

function usage(): void {
  process.stderr.write(
    [
      'usage: vicoop-client login --bridge <https://...> [--json]',
      '',
      'Drives Google OAuth device flow and issues an owner-session bearer used',
      'by setup / add-caller / list-callers / list-agents / remove-caller.',
      'By default the token is saved to ~/.vicoop/owner-session.json (chmod',
      '600) so admin subcommands pick it up automatically; pass --json to',
      'print the raw token-endpoint response to stdout instead (that mode',
      'does NOT persist the session).',
      '',
      'Flags:',
      '  --bridge          Bridge HTTP URL (e.g. https://vicoop-bridge-server.fly.dev)',
      '  --owner-session   Accepted for compatibility; login always issues owner-session.',
      '  --json            Print the token endpoint response as JSON to stdout',
      '                    without persisting ~/.vicoop/owner-session.json.',
      '',
    ].join('\n'),
  );
}

const loginParser = object({
  bridge: optional(option('--bridge', string({ metavar: 'URL' }))),
  json: withDefault(flag('--json'), false),
  // `--owner-session` is accepted for backward compatibility — login always
  // issues an owner-session bearer. The flag is parsed and ignored.
  _ownerSession: withDefault(flag('--owner-session'), false),
  // `--poll-once` is a test/CI smoke flag, undocumented in usage.
  pollOnce: withDefault(flag('--poll-once'), false),
});

function parseArgs(args: string[]): LoginArgs | null {
  const r = parse(loginParser, args);
  if (!r.success) {
    process.stderr.write(`${formatMessage(r.error, { colors: false })}\n`);
    return null;
  }
  if (!r.value.bridge) {
    usage();
    return null;
  }
  return { bridge: r.value.bridge, json: r.value.json, pollOnce: r.value.pollOnce };
}

async function fetchDeviceCode(args: LoginArgs): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ intent: 'owner_session' });
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
  | { kind: 'success'; body: OwnerSessionSuccess }
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
    return { kind: 'success', body: JSON.parse(text) as OwnerSessionSuccess };
  }
  let parsed: OAuthError | null = null;
  try {
    parsed = JSON.parse(text) as OAuthError;
  } catch {
    // not JSON
  }
  const code = parsed?.error;
  if (code === 'authorization_pending') return { kind: 'pending' };
  if (code === 'slow_down') return { kind: 'slow_down' };
  if (code === 'expired_token') return { kind: 'expired' };
  return { kind: 'error', message: parsed?.error_description ?? parsed?.error ?? text };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveOwnerSessionBearer(bridgeUrl: string, success: OwnerSessionSuccess): string {
  const expiresAt = new Date(Date.now() + success.expires_in * 1000).toISOString();
  const path = defaultStorePath();
  saveOwnerSession({
    bridge: bridgeUrl.replace(/\/$/, ''),
    token: success.access_token,
    principal_id: success.principal_id,
    email: success.email,
    expires_at: expiresAt,
    saved_at: new Date().toISOString(),
  }, path);
  return path;
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
      'Open the following URL in your browser to sign in:',
      `  ${device.verification_uri_complete}`,
      '',
      `If the URL is unwieldy, browse to ${device.verification_uri} and enter:`,
      `  ${device.user_code}`,
      '',
      `Waiting for approval (expires in ${Math.floor(device.expires_in / 60)} min)...`,
      '',
    ].join('\n'),
  );

  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(device.interval, 1) * 1000;

  while (Date.now() < deadline) {
    const result = await pollOnce(parsed.bridge, device.device_code);
    if (result.kind === 'success') {
      const success = result.body;
      process.stderr.write('\nApproved.\n\n');
      process.stderr.write(
        `  principal_id     ${success.principal_id}\n` +
          `  email            ${success.email ?? '(none)'}\n` +
          `  expires_in       ${success.expires_in}s\n\n`,
      );

      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(success, null, 2)}\n`);
      } else {
        const path = saveOwnerSessionBearer(parsed.bridge, success);
        process.stderr.write(
          `Saved owner-session bearer to ${path} (mode 600).\n` +
            'Run `vicoop-client setup` to create a bridge client token.\n',
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
      intervalMs += 5000;
    }
    if (parsed.pollOnce) return 0;
    await sleep(intervalMs);
  }

  process.stderr.write('\nDeadline exceeded waiting for approval.\n');
  return 1;
}
