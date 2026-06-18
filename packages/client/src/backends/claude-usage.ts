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

import type {
  BridgeUsage,
  UsageAccount,
  UsageSpend,
  UsageWindow,
} from '@vicoop-bridge/protocol';
import {
  clampPercent,
  deriveSeverity,
  epochSecondsToIso,
  isoOrNull,
} from './usage-normalize.js';

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

// Canonical id + label for the named windows the oauth payload returns; unknown
// keys pass through with their raw name as id.
const CLAUDE_WINDOW_META: Record<string, { id: string; label: string }> = {
  five_hour: { id: 'session_5h', label: '5-hour session' },
  seven_day: { id: 'weekly', label: 'Weekly (all models)' },
  seven_day_sonnet: { id: 'weekly_sonnet', label: 'Weekly (Sonnet)' },
  seven_day_opus: { id: 'weekly_opus', label: 'Weekly (Opus)' },
};
// Keys in the oauth payload that are NOT percent windows.
const CLAUDE_NON_WINDOW_KEYS = new Set(['extra_usage', 'spend', 'limits']);

function isWindowObject(v: unknown): v is { utilization: number; resets_at?: unknown } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { utilization?: unknown }).utilization === 'number'
  );
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Map the verbatim /api/oauth/usage payload to canonical windows + spend.
// `overageResetsAt` (ISO) is threaded in from a captured `rate_limit_event`
// because the oauth `extra_usage`/`spend` block carries no reset timestamp.
function oauthToWindowsAndSpend(
  raw: unknown,
  overageResetsAt: string | null,
): { windows: UsageWindow[]; spend?: UsageSpend } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (CLAUDE_NON_WINDOW_KEYS.has(key) || !isWindowObject(value)) continue;
    const usedPercent = clampPercent(numberOr(value.utilization, 0));
    const meta = CLAUDE_WINDOW_META[key] ?? { id: key, label: key };
    windows.push({
      id: meta.id,
      label: meta.label,
      usedPercent,
      resetsAt: isoOrNull(value.resets_at),
      severity: deriveSeverity(usedPercent),
    });
  }

  // Monetary overage budget. Prefer `spend` (already in minor units); fall back
  // to `extra_usage`.
  let spend: UsageSpend | undefined;
  const spendRaw = obj.spend as
    | { used?: { amount_minor?: unknown; currency?: unknown }; limit?: { amount_minor?: unknown; currency?: unknown }; percent?: unknown; enabled?: unknown }
    | undefined;
  const extra = obj.extra_usage as
    | { is_enabled?: unknown; monthly_limit?: unknown; used_credits?: unknown; utilization?: unknown; currency?: unknown }
    | undefined;
  if (spendRaw && spendRaw.enabled !== false && typeof spendRaw.used?.amount_minor === 'number') {
    spend = {
      usedMinor: numberOr(spendRaw.used?.amount_minor, 0),
      limitMinor: numberOr(spendRaw.limit?.amount_minor, 0),
      currency: typeof spendRaw.used?.currency === 'string' ? spendRaw.used.currency : (typeof extra?.currency === 'string' ? extra.currency : 'USD'),
      usedPercent: clampPercent(numberOr(spendRaw.percent, 0)),
      resetsAt: overageResetsAt,
    };
  } else if (extra && extra.is_enabled === true && typeof extra.monthly_limit === 'number') {
    spend = {
      usedMinor: numberOr(extra.used_credits, 0),
      limitMinor: numberOr(extra.monthly_limit, 0),
      currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
      usedPercent: clampPercent(numberOr(extra.utilization, 0)),
      resetsAt: overageResetsAt,
    };
  }
  return spend ? { windows, spend } : { windows };
}

// The `rate_limit_event` window uses utilization as a 0–1 ratio (unlike the
// oauth payload's 0–100). Build a single representative window from it.
function rateLimitToWindow(info: unknown): UsageWindow | null {
  if (typeof info !== 'object' || info === null) return null;
  const rl = info as { utilization?: unknown; rateLimitType?: unknown; resetsAt?: unknown };
  if (typeof rl.utilization !== 'number') return null;
  const usedPercent = clampPercent(rl.utilization <= 1 ? rl.utilization * 100 : rl.utilization);
  const type = typeof rl.rateLimitType === 'string' ? rl.rateLimitType : 'representative';
  return {
    id: type,
    label: `Representative window (${type})`,
    usedPercent,
    resetsAt: epochSecondsToIso(rl.resetsAt),
    severity: deriveSeverity(usedPercent),
  };
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
  // Resolve the on-demand canonical usage snapshot for the bridge usage API.
  // Never rejects — failures degrade to the stream-derived window (or an empty
  // account list) with a `note`.
  usage(): Promise<BridgeUsage>;
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
  let lastPlan: string | undefined;
  let cachedOauth: { value: BridgeUsage; at: number } | undefined;
  // -Infinity so the first call is never mistaken for "attempted recently"
  // (a real Date.now() minus 0 already exceeds any TTL, but the sentinel keeps
  // the throttle correct for any clock origin, including test clocks near 0).
  let lastAttemptAt = -Infinity;

  // Best-effort monthly-overage reset, lifted from a captured overage event
  // (the oauth extra_usage block has no reset timestamp of its own).
  function overageResetsAt(): string | null {
    const rl = lastRateLimit?.info as { rateLimitType?: unknown; resetsAt?: unknown } | undefined;
    return rl && rl.rateLimitType === 'overage' ? epochSecondsToIso(rl.resetsAt) : null;
  }

  // Degraded snapshot: a single account built from the latest stream window if
  // we have one, else an empty account list.
  function fallback(ts: number, note: string): BridgeUsage {
    const window = lastRateLimit ? rateLimitToWindow(lastRateLimit.info) : null;
    return {
      backend: 'claude',
      source: lastRateLimit ? 'rate_limit_event' : 'none',
      fetchedAt: new Date(ts).toISOString(),
      accounts: window
        ? [{ id: 'default', plan: lastPlan, windows: [window] }]
        : [],
      note,
      ...(lastRateLimit ? { raw: lastRateLimit.info } : {}),
    };
  }

  return {
    recordRateLimitEvent(info) {
      if (info == null) return;
      lastRateLimit = { info, at: now() };
    },

    async usage() {
      const ts = now();
      if (cachedOauth && ts - cachedOauth.at < ttl) return cachedOauth.value;
      // Throttle: at most one network attempt per TTL so we never trip the
      // endpoint's self-429. Between attempts, prefer the last good snapshot.
      if (ts - lastAttemptAt < ttl) {
        return cachedOauth
          ? cachedOauth.value
          : fallback(ts, 'oauth usage throttled (awaiting next attempt window)');
      }

      const creds = readCreds(deps.credEnv);
      if (!creds) return fallback(ts, 'no Claude OAuth token found on host');
      lastPlan = creds.subscriptionType ?? lastPlan;
      if (typeof creds.expiresAt === 'number' && creds.expiresAt <= ts) {
        return fallback(ts, 'Claude OAuth token expired; using last stream window');
      }

      lastAttemptAt = ts;
      try {
        const res = await fetchClaudeOAuthUsage(creds.accessToken, fetchImpl);
        if (!res.ok) {
          return fallback(ts, `api/oauth/usage returned HTTP ${res.status}`);
        }
        const { windows, spend } = oauthToWindowsAndSpend(res.data, overageResetsAt());
        const account: UsageAccount = {
          id: 'default',
          plan: creds.subscriptionType,
          windows,
          ...(spend ? { spend } : {}),
        };
        const value: BridgeUsage = {
          backend: 'claude',
          source: 'oauth',
          fetchedAt: new Date(ts).toISOString(),
          accounts: [account],
          raw: res.data,
        };
        cachedOauth = { value, at: ts };
        return value;
      } catch (err) {
        return fallback(ts, `api/oauth/usage request failed: ${errorMessage(err)}`);
      }
    },
  };
}
