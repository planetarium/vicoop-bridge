import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchClaudeModelCatalog,
  loadClaudeModelCatalog,
} from './claude-models.js';
import type { ClaudeCredEnv } from './claude-usage.js';

// Minimal fetch stub: records the URL + init we sent and returns a canned
// Response-shaped object. `throws` simulates a transport failure.
function fetchStub(handler: (url: string) => {
  ok: boolean;
  status?: number;
  json?: unknown;
  throws?: boolean;
}) {
  const state = { calls: 0, lastUrl: '', lastInit: undefined as RequestInit | undefined };
  const fn = (async (url: string, init?: RequestInit) => {
    state.calls += 1;
    state.lastUrl = url;
    state.lastInit = init;
    const r = handler(url);
    if (r.throws) throw new Error('network down');
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, state };
}

function sentHeaders(state: { lastInit?: RequestInit }): Record<string, string> {
  return (state.lastInit?.headers ?? {}) as Record<string, string>;
}

// A representative slice of the real /v1/models payload (verified live: the
// subscription OAuth token returns 200 with these fields).
const MODELS_PAYLOAD = {
  data: [
    { type: 'model', id: 'claude-sonnet-5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
    { type: 'model', id: 'claude-opus-4-5-20251101', max_input_tokens: 200_000, max_tokens: 64_000 },
  ],
  has_more: false,
};

test('fetchClaudeModelCatalog: parses id → {maxInputTokens, maxTokens}', async () => {
  const { fn } = fetchStub(() => ({ ok: true, json: MODELS_PAYLOAD }));
  const catalog = await fetchClaudeModelCatalog('sk-ant-oat01-TESTTOKEN', fn);
  assert.deepEqual(catalog.get('claude-sonnet-5'), {
    maxInputTokens: 1_000_000,
    maxTokens: 128_000,
  });
  assert.deepEqual(catalog.get('claude-opus-4-5-20251101'), {
    maxInputTokens: 200_000,
    maxTokens: 64_000,
  });
  assert.equal(catalog.size, 2);
});

test('fetchClaudeModelCatalog: sends OAuth Bearer + oauth beta header, limit=1000', async () => {
  const { fn, state } = fetchStub(() => ({ ok: true, json: MODELS_PAYLOAD }));
  await fetchClaudeModelCatalog('sk-ant-oat01-TESTTOKEN', fn, 'claude-code/9.9.9');
  assert.match(state.lastUrl, /\/v1\/models\?limit=1000$/);
  const h = sentHeaders(state);
  assert.equal(h.Authorization, 'Bearer sk-ant-oat01-TESTTOKEN');
  assert.equal(h['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['User-Agent'], 'claude-code/9.9.9');
});

test('fetchClaudeModelCatalog: skips entries with missing / non-positive / non-integer limits', async () => {
  const { fn } = fetchStub(() => ({
    ok: true,
    json: {
      data: [
        { id: 'ok', max_input_tokens: 200_000, max_tokens: 64_000 },
        { id: 'zero-window', max_input_tokens: 0, max_tokens: 64_000 }, // placeholder 0
        { id: 'no-output', max_input_tokens: 200_000 }, // missing max_tokens
        { id: 'float', max_input_tokens: 200_000.5, max_tokens: 64_000 }, // non-integer
        { id: '', max_input_tokens: 200_000, max_tokens: 64_000 }, // empty id
      ],
    },
  }));
  const catalog = await fetchClaudeModelCatalog('t', fn);
  assert.deepEqual([...catalog.keys()], ['ok']);
});

test('fetchClaudeModelCatalog: non-ok response → empty map', async () => {
  const { fn } = fetchStub(() => ({ ok: false, status: 401 }));
  const catalog = await fetchClaudeModelCatalog('t', fn);
  assert.equal(catalog.size, 0);
});

test('fetchClaudeModelCatalog: transport throw → empty map (best-effort)', async () => {
  const { fn } = fetchStub(() => ({ ok: true, throws: true }));
  const catalog = await fetchClaudeModelCatalog('t', fn);
  assert.equal(catalog.size, 0);
});

test('fetchClaudeModelCatalog: non-array data → empty map', async () => {
  const { fn } = fetchStub(() => ({ ok: true, json: { data: 'nope' } }));
  const catalog = await fetchClaudeModelCatalog('t', fn);
  assert.equal(catalog.size, 0);
});

test('loadClaudeModelCatalog: no host token → empty map, no fetch attempted', async () => {
  // Linux + no creds file → readClaudeOAuthCreds returns null before any fetch.
  const credEnv: ClaudeCredEnv = { platform: 'linux', existsSync: () => false };
  const { fn, state } = fetchStub(() => ({ ok: true, json: MODELS_PAYLOAD }));
  const catalog = await loadClaudeModelCatalog({ credEnv, fetchImpl: fn });
  assert.equal(catalog.size, 0);
  assert.equal(state.calls, 0, 'must not fetch without a token');
});
