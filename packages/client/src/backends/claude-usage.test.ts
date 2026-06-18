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
      json: async () => r.json,
      text: async () => r.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, state };
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

test('fetchClaudeOAuthUsage: hits the oauth/usage URL with a Bearer header', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: { five_hour: { utilization: 21 } } }));
  const res = await fetchClaudeOAuthUsage('sk-ant-oat01-X', fn);
  assert.equal(state.lastUrl, CLAUDE_OAUTH_USAGE_URL);
  const headers = state.lastInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-ant-oat01-X');
  assert.deepEqual(res, { ok: true, data: { five_hour: { utilization: 21 } } });
});

test('fetchClaudeOAuthUsage: surfaces a non-2xx as {ok:false,status}', async () => {
  const { fn } = fetchStub(() => ({ ok: false, status: 429, text: 'rate_limit_error' }));
  const res = await fetchClaudeOAuthUsage('sk-ant-oat01-X', fn);
  assert.deepEqual(res, { ok: false, status: 429, body: 'rate_limit_error' });
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

test('usage(): maps a healthy oauth payload to canonical windows + spend', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD }));
  const provider = createClaudeUsageProvider({ now: () => 1000, fetchImpl: fn, readCreds: okCreds });
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
  const provider = createClaudeUsageProvider({ now: () => 1000, fetchImpl: fn, readCreds: okCreds });
  // resetsAt 1782864000 (epoch s) → ISO.
  provider.recordRateLimitEvent({ rateLimitType: 'overage', utilization: 0.93, resetsAt: 1782864000 });
  const snap = await provider.usage();
  assert.equal(snap.accounts[0].spend?.resetsAt, new Date(1782864000 * 1000).toISOString());
});

test('usage(): caches a successful snapshot within the TTL (no second fetch)', async () => {
  let clock = 1000;
  const { fn, state } = fetchStub(() => ({ ok: true, json: OAUTH_PAYLOAD }));
  const provider = createClaudeUsageProvider({ now: () => clock, fetchImpl: fn, readCreds: okCreds, cacheTtlMs: 60_000 });
  await provider.usage();
  clock += 30_000; // still inside the window
  await provider.usage();
  assert.equal(state.calls, 1);
  clock += 60_000; // past the window
  await provider.usage();
  assert.equal(state.calls, 2);
});

test('usage(): falls back to the rate_limit_event window (0–1 → 0–100) when no token', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: {} }));
  const provider = createClaudeUsageProvider({ now: () => 1000, fetchImpl: fn, readCreds: () => null });
  provider.recordRateLimitEvent({ utilization: 0.93, rateLimitType: 'overage', resetsAt: 1782864000 });
  const snap = await provider.usage();
  assert.equal(snap.source, 'rate_limit_event');
  assert.equal(snap.accounts.length, 1);
  const w = snap.accounts[0].windows[0];
  assert.equal(w.id, 'overage');
  assert.equal(w.usedPercent, 93); // 0.93 ratio → 93%
  assert.equal(w.resetsAt, new Date(1782864000 * 1000).toISOString());
  assert.match(snap.note ?? '', /no Claude OAuth token/);
  assert.equal(state.calls, 0); // never reached the network
});

test('usage(): source "none" with empty accounts when neither token nor stream window exists', async () => {
  const provider = createClaudeUsageProvider({
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
  const provider = createClaudeUsageProvider({
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
  const provider = createClaudeUsageProvider({ now: () => clock, fetchImpl: fn, readCreds: okCreds, cacheTtlMs: 60_000 });
  const first = await provider.usage();
  assert.match(first.note ?? '', /HTTP 429/);
  clock += 30_000; // inside the throttle window
  await provider.usage();
  assert.equal(state.calls, 1, 'must not re-hit a self-429ing endpoint within TTL');
  clock += 60_000; // window elapsed
  await provider.usage();
  assert.equal(state.calls, 2);
});
