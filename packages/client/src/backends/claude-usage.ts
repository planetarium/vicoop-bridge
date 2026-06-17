// Claude subscription remaining-usage support for the bridge `usage()`
// capability.
//
// Two data sources, in priority order:
//   1. Authenticated GET https://api.anthropic.com/api/oauth/usage — the same
//      endpoint Claude Code's interactive `/usage` calls. Returns the full
//      window breakdown (5-hour session, weekly all-models, weekly Sonnet, …)
//      plus `extra_usage`. Requires the subscription OAuth access token that
//      the `claude` CLI already stores on the host.
//   2. The `rate_limit_event` line claude emits at the head of every
//      stream-json task. It carries only the single *representative* window
//      (whichever is closest to its limit), so it is a fallback for when the
//      token is missing/expired or the endpoint refuses — not a full picture.
//
// The endpoint self-rate-limits (HTTP 429 + retry-after ~257s after one or two
// calls), so successful snapshots are cached and network attempts are throttled
// to once per TTL (default 5 min). The cred read and fetch are injectable so the
// whole path is unit-testable without a real keychain/file or network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_OAUTH_USAGE_URL =
  'https://api.anthropic.com/api/oauth/usage';

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ClaudeOAuthCreds {
  accessToken: string;
  // epoch ms, when the stored creds report it; used for a cheap pre-flight
  // expiry check so we don't spend a network attempt on a known-dead token.
  expiresAt?: number;
  subscriptionType?: string;
}

// Test seam mirroring container-init.ts's HostCredsEnv: production passes
// nothing and each field defaults to the real node:os / node:fs / `security`
// CLI, while tests stub them to exercise each platform branch without touching
// the real $HOME or macOS Keychain.
export interface ClaudeCredEnv {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => Buffer | string;
  // null => keychain entry absent; throw => lookup failed. Returns the raw
  // password value, which for this item is the full credentials JSON.
  keychainLookup?: (service: string) => string | null;
}

function defaultKeychainLookup(service: string): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function parseCreds(raw: string): ClaudeOAuthCreds | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = (json as { claudeAiOauth?: unknown })?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown }
    | undefined;
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || token.length === 0) return null;
  return {
    accessToken: token,
    expiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined,
    subscriptionType:
      typeof oauth?.subscriptionType === 'string'
        ? oauth.subscriptionType
        : undefined,
  };
}

// Read the Claude Code subscription OAuth credentials from the host — the same
// source the `claude` CLI itself authenticates with:
//   - macOS: Keychain generic-password "Claude Code-credentials", with a
//     ~/.claude/.credentials.json fallback for file-based setups.
//   - Linux / Windows: ~/.claude/.credentials.json (on Windows os.homedir()
//     resolves ~ to %USERPROFILE%, so the same join works).
// Returns null when no usable token is present; the caller then degrades to the
// stream-derived rate_limit snapshot.
export function readClaudeOAuthCreds(
  env: ClaudeCredEnv = {},
): ClaudeOAuthCreds | null {
  const platform = env.platform ?? process.platform;
  const exists = env.existsSync ?? existsSync;
  const readFile = env.readFileSync ?? readFileSync;
  const home = (env.homedir ?? homedir)();
  const filePath = join(home, '.claude', '.credentials.json');

  if (platform === 'darwin') {
    const lookup = env.keychainLookup ?? defaultKeychainLookup;
    let raw: string | null = null;
    try {
      raw = lookup(CLAUDE_KEYCHAIN_SERVICE);
    } catch {
      raw = null;
    }
    if (raw) {
      const creds = parseCreds(raw);
      if (creds) return creds;
    }
    // fall through to the file for file-based macOS setups
  }

  if (exists(filePath)) {
    try {
      return parseCreds(readFile(filePath).toString());
    } catch {
      return null;
    }
  }
  return null;
}

export type FetchUsageResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; body?: string };

export async function fetchClaudeOAuthUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchUsageResult> {
  const res = await fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => undefined);
    return { ok: false, status: res.status, body: body?.slice(0, 300) };
  }
  return { ok: true, data: await res.json() };
}

export interface ClaudeUsageSnapshot {
  backend: 'claude';
  // 'oauth' = full authenticated window breakdown; 'rate_limit_event' = the
  // single stream-derived window; 'none' = neither source available yet.
  source: 'oauth' | 'rate_limit_event' | 'none';
  fetchedAt?: string;
  // The verbatim /api/oauth/usage payload, present when source === 'oauth'.
  usage?: unknown;
  // The latest stream-derived rate_limit_event window. Included whenever one
  // has been observed this session — it is the only data when source !==
  // 'oauth', and a cross-check alongside it when source === 'oauth'.
  rateLimit?: unknown;
  rateLimitCapturedAt?: string;
  // Operator-facing reason oauth data is absent (token missing/expired,
  // endpoint HTTP status, throttled, …).
  note?: string;
}

export interface ClaudeUsageProviderDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
  credEnv?: ClaudeCredEnv;
  // Successful-snapshot reuse window AND the minimum spacing between network
  // attempts. Must stay well above a few seconds because the endpoint
  // self-429s. Default 5 min.
  cacheTtlMs?: number;
  // Test seam: override the cred reader so the keychain/file is never touched.
  readCreds?: (env?: ClaudeCredEnv) => ClaudeOAuthCreds | null;
}

export interface ClaudeUsageProvider {
  // Capture the latest rate_limit_event window seen on the task stream.
  recordRateLimitEvent(info: unknown): void;
  // Resolve the on-demand usage snapshot for the bridge usage API. Never
  // rejects — failures degrade to the stream-derived window with a `note`.
  usage(): Promise<ClaudeUsageSnapshot>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createClaudeUsageProvider(
  deps: ClaudeUsageProviderDeps = {},
): ClaudeUsageProvider {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readCreds = deps.readCreds ?? readClaudeOAuthCreds;
  const ttl = deps.cacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS;

  let lastRateLimit: { info: unknown; at: number } | undefined;
  let cachedOauth: { value: ClaudeUsageSnapshot; at: number } | undefined;
  // -Infinity so the first call is never mistaken for "attempted recently"
  // (a real Date.now() minus 0 already exceeds any TTL, but the sentinel keeps
  // the throttle correct for any clock origin, including test clocks near 0).
  let lastAttemptAt = -Infinity;

  const rateLimitFields = (): Partial<ClaudeUsageSnapshot> =>
    lastRateLimit
      ? {
          rateLimit: lastRateLimit.info,
          rateLimitCapturedAt: new Date(lastRateLimit.at).toISOString(),
        }
      : {};

  function fallback(note: string): ClaudeUsageSnapshot {
    return {
      backend: 'claude',
      source: lastRateLimit ? 'rate_limit_event' : 'none',
      note,
      ...rateLimitFields(),
    };
  }

  return {
    recordRateLimitEvent(info) {
      if (info == null) return;
      lastRateLimit = { info, at: now() };
    },

    async usage() {
      const ts = now();
      // Fresh successful snapshot — serve without touching the network, but
      // re-stamp the latest stream-derived window onto it.
      if (cachedOauth && ts - cachedOauth.at < ttl) {
        return { ...cachedOauth.value, ...rateLimitFields() };
      }
      // Throttle: at most one network attempt per TTL so we never trip the
      // endpoint's self-429. Between attempts, prefer the last good snapshot,
      // otherwise the stream-derived window.
      if (ts - lastAttemptAt < ttl) {
        return cachedOauth
          ? { ...cachedOauth.value, ...rateLimitFields() }
          : fallback('oauth usage throttled (awaiting next attempt window)');
      }

      const creds = readCreds(deps.credEnv);
      if (!creds) return fallback('no Claude OAuth token found on host');
      if (typeof creds.expiresAt === 'number' && creds.expiresAt <= ts) {
        return fallback('Claude OAuth token expired; using last stream window');
      }

      lastAttemptAt = ts;
      try {
        const res = await fetchClaudeOAuthUsage(creds.accessToken, fetchImpl);
        if (!res.ok) {
          return fallback(`api/oauth/usage returned HTTP ${res.status}`);
        }
        const value: ClaudeUsageSnapshot = {
          backend: 'claude',
          source: 'oauth',
          fetchedAt: new Date(ts).toISOString(),
          usage: res.data,
        };
        cachedOauth = { value, at: ts };
        return { ...value, ...rateLimitFields() };
      } catch (err) {
        return fallback(`api/oauth/usage request failed: ${errorMessage(err)}`);
      }
    },
  };
}
