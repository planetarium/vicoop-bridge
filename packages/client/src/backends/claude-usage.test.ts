import test from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeUsage, UsageWindow } from '@vicoop-bridge/protocol';
import {
  CLAUDE_OAUTH_USAGE_URL,
  createClaudeUsageProvider,
  fetchClaudeOAuthUsage,
  readClaudeOAuthCreds,
  type ClaudeCredEnv,
} from './claude-usage.js';

const CREDS_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-TESTTOKEN',
    refreshToken: 'sk-ant-ort01-TESTTOKEN',
    expiresAt: 9_999_999_999_999,
    subscriptionType: 'team',
  },
});

// Build a minimal fetch stub. `calls` tracks invocations so cache/throttle
// behaviour is observable; `lastInit` exposes the headers we sent.
function fetchStub(handler: (url: string) => {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  retryAfter?: string;
}) {
  const state = { calls: 0, lastUrl: '', lastInit: undefined as RequestInit | undefined };
  const fn = (async (url: string, init?: RequestInit) => {
    state.calls += 1;
    state.lastUrl = url;
    state.lastInit = init;
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? r.retryAfter ?? null : null) },
      json: async () => r.json,
      text: async () => r.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, state };
}

function sentHeaders(state: { lastInit?: RequestInit }): Record<string, string> {
  return (state.lastInit?.headers ?? {}) as Record<string, string>;
}

// ── readClaudeOAuthCreds ──────────────────────────────────────────

test('readClaudeOAuthCreds: macOS reads the Keychain entry', () => {
  const env: ClaudeCredEnv = {
    platform: 'darwin',
    keychainLookup: (service) => {
      assert.equal(service, 'Claude Code-credentials');
      return CREDS_JSON;
    },
    existsSync: () => false,
  };
  const creds = readClaudeOAuthCreds(env);
  assert.equal(creds?.accessToken, 'sk-ant-oat01-TESTTOKEN');
  assert.equal(creds?.expiresAt, 9_999_999_999_999);
  assert.equal(creds?.subscriptionType, 'team');
});

test('readClaudeOAuthCreds: macOS falls back to the file when Keychain is empty', () => {
  const env: ClaudeCredEnv = {
    platform: 'darwin',
    homedir: () => '/Users/test',
    keychainLookup: () => null,
    existsSync: (p) => p === '/Users/test/.claude/.credentials.json',
    readFileSync: () => CREDS_JSON,
  };
  assert.equal(readClaudeOAuthCreds(env)?.accessToken, 'sk-ant-oat01-TESTTOKEN');
});

test('readClaudeOAuthCreds: Linux reads ~/.claude/.credentials.json', () => {
  const env: ClaudeCredEnv = {
    platform: 'linux',
    homedir: () => '/home/test',
    existsSync: (p) => p === '/home/test/.claude/.credentials.json',
    readFileSync: () => CREDS_JSON,
  };
  assert.equal(readClaudeOAuthCreds(env)?.accessToken, 'sk-ant-oat01-TESTTOKEN');
});

test('readClaudeOAuthCreds: honors $CLAUDE_CONFIG_DIR over ~/.claude', () => {
  let consulted = '';
  const env: ClaudeCredEnv = {
    platform: 'linux',
    configDir: '/custom/cfg',
    homedir: () => '/home/test',
    existsSync: (p) => {
      consulted = p;
      return p === '/custom/cfg/.credentials.json';
    },
    readFileSync: () => CREDS_JSON,
  };
  assert.equal(readClaudeOAuthCreds(env)?.accessToken, 'sk-ant-oat01-TESTTOKEN');
  assert.equal(consulted, '/custom/cfg/.credentials.json');
});

test('readClaudeOAuthCreds: Windows reads %USERPROFILE%\\.claude\\.credentials.json', () => {
  // os.homedir() resolves to %USERPROFILE% on win32; path.join uses the host
  // separator, so we only assert the file is consulted under the home dir.
  let consulted = '';
  const env: ClaudeCredEnv = {
    platform: 'win32',
    homedir: () => 'C:\\Users\\test',
    existsSync: (p) => {
      consulted = p;
      return true;
    },
    readFileSync: () => CREDS_JSON,
  };
  const creds = readClaudeOAuthCreds(env);
  assert.equal(creds?.accessToken, 'sk-ant-oat01-TESTTOKEN');
  assert.match(consulted, /\.claude.\.credentials\.json$/);
});

test('readClaudeOAuthCreds: returns null when nothing is present', () => {
  assert.equal(
    readClaudeOAuthCreds({ platform: 'linux', homedir: () => '/home/x', existsSync: () => false }),
    null,
  );
});

test('readClaudeOAuthCreds: returns null on malformed JSON or missing token', () => {
  const base: ClaudeCredEnv = {
    platform: 'linux',
    homedir: () => '/home/x',
    existsSync: () => true,
  };
  assert.equal(readClaudeOAuthCreds({ ...base, readFileSync: () => 'not json' }), null);
  assert.equal(
    readClaudeOAuthCreds({ ...base, readFileSync: () => JSON.stringify({ claudeAiOauth: {} }) }),
    null,
  );
});

// ── fetchClaudeOAuthUsage ─────────────────────────────────────────

test('fetchClaudeOAuthUsage: sends the official-client header set', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: { five_hour: { utilization: 21 } } }));
  const res = await fetchClaudeOAuthUsage('sk-ant-oat01-X', fn, 'claude-code/9.9.9');
  assert.equal(state.lastUrl, CLAUDE_OAUTH_USAGE_URL);
  const headers = sentHeaders(state);
  assert.equal(headers.Authorization, 'Bearer sk-ant-oat01-X');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['User-Agent'], 'claude-code/9.9.9'); // mirrors official client
  assert.deepEqual(res, { ok: true, data: { five_hour: { utilization: 21 } } });
});

test('fetchClaudeOAuthUsage: omits User-Agent when none is supplied', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: {} }));
  await fetchClaudeOAuthUsage('sk-ant-oat01-X', fn);
  assert.equal(sentHeaders(state)['User-Agent'], undefined);
});

test('fetchClaudeOAuthUsage: surfaces a non-2xx with parsed Retry-After', async () => {
  const { fn } = fetchStub(() => ({ ok: false, status: 429, text: 'rate_limit_error', retryAfter: '120' }));
  const res = await fetchClaudeOAuthUsage('sk-ant-oat01-X', fn);
  assert.deepEqual(res, { ok: false, status: 429, body: 'rate_limit_error', retryAfterMs: 120_000 });
});

// ── createClaudeUsageProvider ─────────────────────────────────────

const okCreds = () => ({
  accessToken: 'sk-ant-oat01-X',
  expiresAt: 9_999_999_999_999,
  subscriptionType: 'team',
});

// A realistic /api/oauth/usage payload (windows in 0–100, plus a monetary
// extra-usage `spend` block).
const OAUTH_PAYLOAD = {
  five_hour: { utilization: 21, resets_at: '2026-06-17T09:19:59Z' },
  seven_day: { utilization: 35, resets_at: '2026-06-22T01:59:59Z' },
  seven_day_sonnet: { utilization: 12, resets_at: '2026-06-22T01:59:59Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 9290, utilization: 92.9, currency: 'SGD' },
  spend: { used: { amount_minor: 9290, currency: 'SGD' }, limit: { amount_minor: 10000, currency: 'SGD' }, percent: 93, enabled: true },
} as const;

function windowById(snap: BridgeUsage, id: string): UsageWindow | undefined {
  return snap.accounts[0]?.windows.find((w) => w.id === id);
}

// Build a provider with the subprocess-touching seams stubbed off by default
// (CLI-version discovery for the User-Agent + token refresh), so tests never
// spawn `claude`. Overrides win.
function makeProvider(overrides: Parameters<typeof createClaudeUsageProvider>[0] = {}) {
  return createClaudeUsageProvider({
    cliVersionLookup: () => '9.9.9',
    refresh: () => {},
    ...overrides,
  });
}

test('usage(): maps a healthy oauth payload to canonical windows + spend', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD }));
  const provider = makeProvider({ now: () => 1000, fetchImpl: fn, readCreds: okCreds });
  const snap = await provider.usage();

  assert.equal(snap.backend, 'claude');
  assert.equal(snap.source, 'oauth');
  assert.equal(typeof snap.fetchedAt, 'string');
  assert.equal(snap.accounts.length, 1);
  assert.equal(snap.accounts[0].plan, 'team');

  // five_hour → canonical session_5h, utilization 21 → usedPercent 21, ISO reset.
  assert.deepEqual(windowById(snap, 'session_5h'), {
    id: 'session_5h',
    label: '5-hour session',
    usedPercent: 21,
    resetsAt: '2026-06-17T09:19:59Z',
    severity: 'ok',
  });
  assert.equal(windowById(snap, 'weekly')?.usedPercent, 35);
  assert.equal(windowById(snap, 'weekly_sonnet')?.usedPercent, 12);
  // seven_day_opus was null → not emitted; extra_usage/spend are NOT windows.
  assert.equal(windowById(snap, 'weekly_opus'), undefined);
  assert.equal(snap.accounts[0].windows.length, 3);

  // Monetary overage → spend block (minor units), severity-critical percent.
  assert.deepEqual(snap.accounts[0].spend, {
    usedMinor: 9290,
    limitMinor: 10000,
    currency: 'SGD',
    usedPercent: 93,
    resetsAt: null,
  });
  // Raw payload preserved verbatim.
  assert.deepEqual(snap.raw, OAUTH_PAYLOAD);
  assert.equal(state.calls, 1);
});

test('usage(): threads the overage reset from a captured rate_limit_event into spend', async () => {
  const { fn } = fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD }));
  const provider = makeProvider({ now: () => 1000, fetchImpl: fn, readCreds: okCreds });
  // resetsAt 1782864000 (epoch s) → ISO.
  provider.recordRateLimitEvent({ rateLimitType: 'overage', utilization: 0.93, resetsAt: 1782864000 });
  const snap = await provider.usage();
  assert.equal(snap.accounts[0].spend?.resetsAt, new Date(1782864000 * 1000).toISOString());
});

test('usage(): caches a successful snapshot within the TTL (no second fetch)', async () => {
  let clock = 1000;
  const { fn, state } = fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD }));
  const provider = makeProvider({ now: () => clock, fetchImpl: fn, readCreds: okCreds, cacheTtlMs: 60_000 });
  await provider.usage();
  clock += 30_000; // still inside the window
  await provider.usage();
  assert.equal(state.calls, 1);
  clock += 60_000; // past the window
  await provider.usage();
  assert.equal(state.calls, 2);
});

test('usage(): a recorded rate_limit_event is NOT surfaced as a window; degrades to "none"', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: {} }));
  const provider = makeProvider({ now: () => 1000, fetchImpl: fn, readCreds: () => null });
  // An overage event is recorded — it must NOT be turned into a usage window
  // (it would misrepresent the subscription quota), only used for spend reset.
  provider.recordRateLimitEvent({ utilization: 0.93, rateLimitType: 'overage', resetsAt: 1782864000 });
  const snap = await provider.usage();
  assert.equal(snap.source, 'none');
  assert.deepEqual(snap.accounts, []);
  assert.match(snap.note ?? '', /no Claude OAuth token/);
  assert.equal(state.calls, 0); // never reached the network
});

test('usage(): source "none" with empty accounts when neither token nor stream window exists', async () => {
  const provider = makeProvider({
    now: () => 1000,
    fetchImpl: fetchStub(() => ({ ok: true, json: {} })).fn,
    readCreds: () => null,
  });
  const snap = await provider.usage();
  assert.equal(snap.source, 'none');
  assert.deepEqual(snap.accounts, []);
});

test('usage(): skips the network for an expired token', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD }));
  const provider = makeProvider({
    now: () => 10_000,
    fetchImpl: fn,
    readCreds: () => ({ accessToken: 'x', expiresAt: 5_000 }),
  });
  const snap = await provider.usage();
  assert.equal(state.calls, 0);
  assert.match(snap.note ?? '', /expired/);
});

test('usage(): throttles network attempts after an HTTP failure', async () => {
  let clock = 1000;
  const { fn, state } = fetchStub(() => ({ ok: false, status: 429, text: 'slow down' }));
  const provider = makeProvider({ now: () => clock, fetchImpl: fn, readCreds: okCreds, cacheTtlMs: 60_000 });
  const first = await provider.usage();
  assert.match(first.note ?? '', /429/);
  clock += 30_000; // inside the throttle window
  await provider.usage();
  assert.equal(state.calls, 1, 'must not re-hit a self-429ing endpoint within TTL');
  clock += 60_000; // window elapsed
  await provider.usage();
  assert.equal(state.calls, 2);
});

// ── items 3–6: Retry-After, stale-on-error, active refresh, retry-storm guard ──

test('usage(): 429 Retry-After overrides the default TTL backoff (item 3)', async () => {
  let clock = 1000;
  const { fn, state } = fetchStub(() => ({ ok: false, status: 429, retryAfter: '5' })); // 5s
  const provider = makeProvider({ now: () => clock, fetchImpl: fn, readCreds: okCreds, cacheTtlMs: 60_000 });
  await provider.usage(); // fails → next attempt allowed at 1000 + 5_000
  assert.equal(state.calls, 1);
  clock += 3_000; // still inside the 5s Retry-After window
  await provider.usage();
  assert.equal(state.calls, 1, 'must respect Retry-After');
  clock += 3_000; // now past 5s (6s elapsed) but far below the 60s TTL
  await provider.usage();
  assert.equal(state.calls, 2, 'Retry-After (5s) must win over the 60s TTL');
});

test('usage(): serves the last successful snapshot (stale) on a later failure (item 4)', async () => {
  let clock = 1000;
  let ok = true;
  const { fn } = fetchStub(() => (ok ? { ok: true, json: OAUTH_PAYLOAD } : { ok: false, status: 500 }));
  const provider = makeProvider({ now: () => clock, fetchImpl: fn, readCreds: okCreds, cacheTtlMs: 60_000 });
  const fresh = await provider.usage();
  assert.equal(fresh.source, 'oauth');
  ok = false;
  clock += 120_000; // past the cache window → re-attempts, fails 500
  const stale = await provider.usage();
  assert.equal(stale.source, 'oauth'); // still the last good snapshot, not a rate_limit fallback
  assert.equal(windowById(stale, 'session_5h')?.usedPercent, 21);
  assert.match(stale.note ?? '', /last successful snapshot/);
});

test('usage(): an expired token is refreshed via the CLI, then the retry succeeds (item 5)', async () => {
  let token = 'expired-tok';
  const provider = makeProvider({
    now: () => 10_000,
    fetchImpl: fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD })).fn,
    // expired until refresh rotates the token, then fresh.
    readCreds: () => ({
      accessToken: token,
      expiresAt: token === 'fresh-tok' ? 9_999_999_999_999 : 5_000,
      subscriptionType: 'team',
    }),
    refresh: () => {
      token = 'fresh-tok';
    },
  });
  const snap = await provider.usage();
  assert.equal(snap.source, 'oauth'); // refresh rotated the token → fetch succeeded
});

test('usage(): a 401 triggers one CLI refresh + retry (item 5)', async () => {
  let token = 'dead';
  let n = 0;
  const { fn, state } = fetchStub(() => {
    n += 1;
    return n === 1 ? { ok: false, status: 401 } : { ok: true, json: OAUTH_PAYLOAD };
  });
  const provider = makeProvider({
    now: () => 1000,
    fetchImpl: fn,
    readCreds: () => ({ accessToken: token, expiresAt: 9_999_999_999_999, subscriptionType: 'team' }),
    refresh: () => {
      token = 'fresh';
    },
  });
  const snap = await provider.usage();
  assert.equal(snap.source, 'oauth');
  assert.equal(state.calls, 2); // 401 → refresh → retry
});

test('usage(): a known-dead token is not re-sent to the endpoint (item 6)', async () => {
  let clock = 1000;
  const { fn, state } = fetchStub(() => ({ ok: false, status: 401 }));
  const provider = makeProvider({
    now: () => clock,
    fetchImpl: fn,
    readCreds: () => ({ accessToken: 'dead', expiresAt: 9_999_999_999_999 }),
    refresh: () => {}, // no-op → token stays 'dead'
    cacheTtlMs: 60_000,
  });
  await provider.usage(); // 401 → records dead token → refresh no-op → degraded
  assert.equal(state.calls, 1);
  clock += 120_000; // past the backoff window
  await provider.usage(); // guard short-circuits: refresh no-op keeps the dead token → no fetch
  assert.equal(state.calls, 1, 'must not hammer the endpoint with a known-dead token');
});
