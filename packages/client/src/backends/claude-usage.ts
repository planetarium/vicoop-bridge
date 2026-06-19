// Claude subscription remaining-usage support for the bridge `usage()`
// capability.
//
// The single authoritative source is the authenticated
// GET https://api.anthropic.com/api/oauth/usage — the same endpoint Claude
// Code's interactive `/usage` calls. It returns the full window breakdown
// (5-hour session, weekly all-models, weekly Sonnet, …) plus `extra_usage`, and
// requires the subscription OAuth access token the `claude` CLI stores on the
// host. When it is unavailable, we serve the last successful snapshot (stale)
// if we have one, otherwise an explicit `source: 'none'`.
//
// We also capture the `rate_limit_event` line claude emits at the head of every
// stream-json task, but ONLY to enrich `spend.resetsAt` (its monthly overage
// reset, which the oauth `extra_usage` block omits). It is NOT used as a usage
// fallback: that event reports only the single most-constrained window (e.g. a
// near-cap overage meter), so presenting it as the usage would hide the
// subscription windows the caller wants and misrepresent the quota.
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
// We mirror the official Claude Code client's `User-Agent: claude-code/<version>`
// so the OAuth endpoint sees a request shaped like the official client. The
// version is discovered from the installed CLI; this is the fallback when that
// discovery fails.
const CLAUDE_CODE_UA_FALLBACK_VERSION = '2.1.85';

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
  // Overrides the creds directory; mirrors Claude Code's $CLAUDE_CONFIG_DIR.
  // Defaults to process.env.CLAUDE_CONFIG_DIR. When set, the creds file is
  // `<configDir>/.credentials.json` instead of `~/.claude/.credentials.json`.
  configDir?: string;
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
//     credentials-file fallback for file-based setups.
//   - Linux / Windows: the credentials file.
// The file location honors $CLAUDE_CONFIG_DIR (Claude Code's config-dir
// override); otherwise ~/.claude/.credentials.json (on Windows os.homedir()
// resolves ~ to %USERPROFILE%, so the same join works).
// Returns null when no usable token is present; the caller then degrades to the
// stream-derived rate_limit snapshot.
export function readClaudeOAuthCreds(
  env: ClaudeCredEnv = {},
): ClaudeOAuthCreds | null {
  const platform = env.platform ?? process.platform;
  const exists = env.existsSync ?? existsSync;
  const readFile = env.readFileSync ?? readFileSync;
  const configDir = env.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const filePath =
    configDir && configDir.length > 0
      ? join(configDir, '.credentials.json')
      : join((env.homedir ?? homedir)(), '.claude', '.credentials.json');

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

// Discover the installed Claude Code CLI version for the User-Agent (mirrors the
// official client). Returns null on any failure; the caller substitutes the
// fallback version.
export function defaultClaudeCliVersion(command: string): string | null {
  try {
    const out = execFileSync(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).toString();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

export type FetchUsageResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; body?: string; retryAfterMs?: number };

export async function fetchClaudeOAuthUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  userAgent?: string,
): Promise<FetchUsageResult> {
  const res = await fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
    method: 'GET',
    // Header set mirrors the official Claude Code client (Authorization,
    // Content-Type, User-Agent, anthropic-beta) so the OAuth endpoint sees a
    // request shaped like the official client; `accept` is an extra correctness
    // touch for a GET.
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      accept: 'application/json',
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => undefined);
    return {
      ok: false,
      status: res.status,
      body: body?.slice(0, 300),
      retryAfterMs: parseRetryAfterMs(res.headers?.get?.('retry-after')),
    };
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

export interface ClaudeUsageProviderDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
  credEnv?: ClaudeCredEnv;
  // Successful-snapshot reuse window AND the minimum spacing between network
  // attempts. Must stay well above a few seconds because the endpoint
  // self-429s. Default 5 min. A 429 `Retry-After` overrides this per-failure.
  cacheTtlMs?: number;
  // The claude CLI command, used to discover the User-Agent version and to
  // delegate token refresh (`claude update`). Default 'claude'.
  claudeCommand?: string;
  // Test seam: override the cred reader so the keychain/file is never touched.
  readCreds?: (env?: ClaudeCredEnv) => ClaudeOAuthCreds | null;
  // Test seam: override CLI-version discovery for the User-Agent.
  cliVersionLookup?: (command: string) => string | null;
  // Best-effort token refresh on auth expiry, delegated to the Claude Code CLI
  // (it owns the OAuth flow and rewrites the creds store). Injectable for tests
  // / to disable. Default runs `claude update`. NOTE: `claude update` may also
  // update the CLI binary — operators who pin the binary should override this.
  refresh?: () => void | Promise<void>;
}

export interface ClaudeUsageProvider {
  // Capture the latest rate_limit_event seen on the task stream. Used only to
  // enrich `spend.resetsAt` on a successful oauth read — NOT as a usage source.
  recordRateLimitEvent(info: unknown): void;
  // Resolve the on-demand canonical usage snapshot for the bridge usage API.
  // Never rejects — when the oauth read fails it degrades to the last
  // successful snapshot (stale) or an explicit `source: 'none'`, with a `note`.
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
  const claudeCommand = deps.claudeCommand ?? 'claude';
  const cliVersionLookup = deps.cliVersionLookup ?? defaultClaudeCliVersion;
  const refreshFn =
    deps.refresh ??
    (() => {
      execFileSync(claudeCommand, ['update'], { stdio: 'ignore', timeout: 60_000 });
    });

  let lastRateLimit: { info: unknown; at: number } | undefined;
  let lastPlan: string | undefined;
  let cachedOauth: { value: BridgeUsage; at: number } | undefined;
  // Earliest time a network attempt is allowed after a failure; a 429
  // `Retry-After` sets it precisely. -Infinity lets the first call through
  // regardless of clock origin (real Date.now() or a test clock near 0).
  let nextAttemptAt = -Infinity;
  // Retry-storm guard (spec §4): the access token that last got a 401. We don't
  // re-hit the endpoint with a known-dead token until its value actually
  // changes (via refresh below or an external rotation).
  let lastFailedToken: string | undefined;
  // Mirror the official client's User-Agent; resolved once per provider.
  let cachedUserAgent: string | undefined;

  function userAgent(): string {
    if (cachedUserAgent) return cachedUserAgent;
    let version: string | null = null;
    try {
      version = cliVersionLookup(claudeCommand);
    } catch {
      version = null;
    }
    cachedUserAgent = `claude-code/${version ?? CLAUDE_CODE_UA_FALLBACK_VERSION}`;
    return cachedUserAgent;
  }

  // Delegate refresh to the CLI, then re-read the (possibly rotated) creds.
  async function refreshCreds(): Promise<ClaudeOAuthCreds | null> {
    try {
      await refreshFn();
    } catch {
      // best-effort; re-read regardless
    }
    const rc = readCreds(deps.credEnv);
    if (rc) lastPlan = rc.subscriptionType ?? lastPlan;
    return rc;
  }

  // Best-effort monthly-overage reset, lifted from a captured overage event
  // (the oauth extra_usage block has no reset timestamp of its own).
  function overageResetsAt(): string | null {
    const rl = lastRateLimit?.info as { rateLimitType?: unknown; resetsAt?: unknown } | undefined;
    return rl && rl.rateLimitType === 'overage' ? epochSecondsToIso(rl.resetsAt) : null;
  }

  function buildOauthSnapshot(data: unknown, ts: number, plan?: string): BridgeUsage {
    const { windows, spend } = oauthToWindowsAndSpend(data, overageResetsAt());
    return {
      backend: 'claude',
      source: 'oauth',
      fetchedAt: new Date(ts).toISOString(),
      accounts: [
        { id: 'default', ...(plan ? { plan } : {}), windows, ...(spend ? { spend } : {}) },
      ],
      raw: data,
    };
  }

  // Degraded result. Prefer the last successful oauth snapshot (stale, with a
  // note); otherwise return an explicit "none". We deliberately do NOT
  // synthesise a usage window from the stream's `rate_limit_event`: that event
  // reports only the single most-constrained window (e.g. a near-cap overage
  // meter), so it would surface that one number as if it were the subscription
  // quota and hide the windows the caller actually wants. The event is still
  // captured (recordRateLimitEvent) — but only to enrich `spend.resetsAt` on a
  // successful oauth read.
  function degraded(ts: number, note: string): BridgeUsage {
    if (cachedOauth) {
      return {
        ...cachedOauth.value,
        note: `${note}; serving last successful snapshot (fetched ${cachedOauth.value.fetchedAt})`,
      };
    }
    return {
      backend: 'claude',
      source: 'none',
      fetchedAt: new Date(ts).toISOString(),
      accounts: [],
      note,
    };
  }

  // One fetch attempt with the 401-driven refresh-and-retry (spec §4). `refreshed`
  // is true when we've already rotated the token this call, to cap recursion.
  async function attempt(
    creds: ClaudeOAuthCreds,
    ts: number,
    refreshed: boolean,
  ): Promise<BridgeUsage> {
    // Known-dead token: try one refresh; if it doesn't change, back off without
    // hitting the endpoint.
    if (!refreshed && lastFailedToken !== undefined && creds.accessToken === lastFailedToken) {
      const rc = await refreshCreds();
      if (rc && rc.accessToken !== creds.accessToken) return attempt(rc, ts, true);
      nextAttemptAt = ts + ttl;
      return degraded(ts, 'Claude OAuth token expired; CLI refresh did not yield a new token');
    }

    let res: FetchUsageResult;
    try {
      res = await fetchClaudeOAuthUsage(creds.accessToken, fetchImpl, userAgent());
    } catch (err) {
      nextAttemptAt = ts + ttl;
      return degraded(ts, `api/oauth/usage request failed: ${errorMessage(err)}`);
    }

    if (res.ok) {
      lastFailedToken = undefined;
      const value = buildOauthSnapshot(res.data, ts, creds.subscriptionType ?? lastPlan);
      cachedOauth = { value, at: ts };
      nextAttemptAt = ts; // success → next attempt allowed once the cache window passes
      return value;
    }
    if (res.status === 401) {
      lastFailedToken = creds.accessToken;
      if (!refreshed) {
        const rc = await refreshCreds();
        if (rc && rc.accessToken !== creds.accessToken) return attempt(rc, ts, true);
      }
      nextAttemptAt = ts + ttl;
      return degraded(ts, 'api/oauth/usage 401 (auth expired)');
    }
    if (res.status === 429) {
      nextAttemptAt = ts + (res.retryAfterMs ?? ttl); // honor Retry-After
      return degraded(ts, 'api/oauth/usage 429 (rate limited)');
    }
    nextAttemptAt = ts + ttl;
    return degraded(ts, `api/oauth/usage returned HTTP ${res.status}`);
  }

  return {
    recordRateLimitEvent(info) {
      if (info == null) return;
      lastRateLimit = { info, at: now() };
    },

    async usage() {
      const ts = now();
      if (cachedOauth && ts - cachedOauth.at < ttl) return cachedOauth.value;
      // Failure/backoff window — never re-hit a self-429ing endpoint early.
      if (ts < nextAttemptAt) {
        return degraded(ts, 'oauth usage throttled (awaiting next attempt window)');
      }

      let creds = readCreds(deps.credEnv);
      if (!creds) return degraded(ts, 'no Claude OAuth token found on host');
      lastPlan = creds.subscriptionType ?? lastPlan;

      // Expired token: refresh first to skip a guaranteed 401 round-trip.
      if (typeof creds.expiresAt === 'number' && creds.expiresAt <= ts) {
        const rc = await refreshCreds();
        if (rc && rc.accessToken !== creds.accessToken) {
          creds = rc;
          return attempt(creds, ts, true);
        }
        nextAttemptAt = ts + ttl;
        return degraded(ts, 'Claude OAuth token expired; using last snapshot/window');
      }

      return attempt(creds, ts, false);
    },
  };
}
