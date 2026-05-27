// `vicoop-client auth login` — authenticate the operator and persist an
// owner-session bearer. Agent registration is deliberately handled by
// `vicoop-client agent register` so login has no server-side side effects.
//
// The legacy flat `vicoop-client login` parser stays exported as a
// deprecated alias; both surfaces dispatch to the same handler.

import { object } from '@optique/core/constructs';
import { optional, withDefault } from '@optique/core/modifiers';
import { command, constant, flag, option } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import type { InferValue } from '@optique/core/parser';
import { string } from '@optique/core/valueparser';
import { DEFAULT_BRIDGE_HTTPS_URL } from './cli-args.js';
import {
  defaultStorePath,
  saveOwnerSession,
} from './owner-session.js';

// Shared field shape for both the new `auth login` and the legacy `login`
// command. Defined once so the two parsers stay in lockstep — adding a
// flag in one place automatically surfaces in the other.
const loginFields = {
  server: optional(
    option('--server', string({ metavar: 'URL' }), {
      description: message`Bridge HTTPS URL (defaults to ${DEFAULT_BRIDGE_HTTPS_URL}; override only when running your own bridge).`,
    }),
  ),
  json: withDefault(
    flag('--json', {
      description: message`Print the token-endpoint response as JSON to stdout without persisting ~/.vicoop/owner-session.json.`,
    }),
    false,
  ),
  // Undocumented test/CI smoke flag — exits after the first poll cycle
  // so login.test.ts can drive a deterministic fixture without sleeping
  // through the real device-flow polling interval.
  pollOnce: withDefault(flag('--poll-once'), false),
};

// New agent-first surface: `vicoop-client auth login`. Wired into
// `authCmd` over in cli.ts (longestMatch with auth logout). The
// `action: constant('auth-login')` discriminator drives dispatch.
export const authLoginCmd = command(
  'login',
  object({
    action: constant('auth-login' as const),
    ...loginFields,
  }),
  {
    brief: message`Sign in as the agent owner and save an owner-session bearer.`,
    description: message`Drives Google OAuth device flow and issues an owner-session bearer used by \`agent register\`, \`agent list/revoke/callers\`. By default the token is saved to ~/.vicoop/owner-session.json (chmod 600) so admin subcommands pick it up automatically; pass --json to print the raw token-endpoint response to stdout instead (that mode does NOT persist the session).`,
  },
);

export type AuthLoginArgs = InferValue<typeof authLoginCmd>;

// Legacy flat `vicoop-client login`. Kept as a deprecated alias.
export const loginCmd = command(
  'login',
  object({
    action: constant('login' as const),
    ...loginFields,
  }),
  {
    brief: message`[deprecated] Use \`auth login\`.`,
    description: message`Deprecated alias for \`vicoop-client auth login\`. Will be removed in a future release.`,
    // Drops out of the top-level usage + brief listing; `vicoop-client login
    // --help` and typo suggestions still resolve so the runtime deprecation
    // warning is discoverable.
    hidden: 'help',
  },
);

export type LoginArgs = InferValue<typeof loginCmd>;

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

async function fetchDeviceCode(bridgeUrl: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ intent: 'owner_session' });
  const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/oauth/device/code`, {
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

// Common shape both LoginArgs and AuthLoginArgs satisfy — `executeLogin`
// accepts this so the handler body is written once and the two thin entry
// points only differ in whether they emit a deprecation warning.
interface LoginCommonArgs {
  server?: string;
  json: boolean;
  pollOnce: boolean;
}

export async function runAuthLogin(args: AuthLoginArgs): Promise<number> {
  return executeLogin(args);
}

export async function runLogin(args: LoginArgs): Promise<number> {
  process.stderr.write(
    '[warning] `vicoop-client login` is deprecated; ' +
      'use `vicoop-client auth login` instead. ' +
      'The deprecated form will be removed in a future release.\n',
  );
  return executeLogin(args);
}

async function executeLogin(args: LoginCommonArgs): Promise<number> {
  // No --server → public default (#189 §6). Self-hosters pass
  // `--server https://bridge.example.com`.
  const bridge = args.server ?? DEFAULT_BRIDGE_HTTPS_URL;

  let device: DeviceCodeResponse;
  try {
    device = await fetchDeviceCode(bridge);
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
    const result = await pollOnce(bridge, device.device_code);
    if (result.kind === 'success') {
      const success = result.body;
      process.stderr.write('\nApproved.\n\n');
      process.stderr.write(
        `  principal_id     ${success.principal_id}\n` +
          `  email            ${success.email ?? '(none)'}\n` +
          `  expires_in       ${success.expires_in}s\n\n`,
      );

      if (args.json) {
        process.stdout.write(`${JSON.stringify(success, null, 2)}\n`);
      } else {
        const path = saveOwnerSessionBearer(bridge, success);
        process.stderr.write(
          `Saved owner-session bearer to ${path} (mode 600).\n` +
            'Run `vicoop-client agent register` to register an agent and mint an agent token.\n',
        );
      }
      return 0;
    }
    if (result.kind === 'expired') {
      process.stderr.write('\nDevice session expired. Re-run `vicoop-client auth login`.\n');
      return 1;
    }
    if (result.kind === 'error') {
      process.stderr.write(`\nToken endpoint error: ${result.message}\n`);
      return 1;
    }
    if (result.kind === 'slow_down') {
      intervalMs += 5000;
    }
    if (args.pollOnce) return 0;
    await sleep(intervalMs);
  }

  process.stderr.write('\nDeadline exceeded waiting for approval.\n');
  return 1;
}
