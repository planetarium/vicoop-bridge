import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { createClaudeAuthBroker, createClaudeCredentialReader, type BrokerOptions } from './claude-auth-broker.js';
import { createPinnedClaudeOAuthReader } from './backends/claude-usage.js';

async function fixture(opts: Partial<BrokerOptions> = {}) {
  const requests: { url: string | undefined; headers: Record<string, unknown>; body: unknown }[] = [];
  let status = 200;
  const upstream = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const p of req) parts.push(p);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString()) });
    res.writeHead(status, { location: 'http://unsafe.invalid', 'x-secret': 'HOST_SECRET' });
    res.end(status === 200 ? '{"usage":{"cache_read_input_tokens":123}}' : 'HOST_SECRET');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const broker = createClaudeAuthBroker({ credential: () => ({ kind: 'api-key', secret: 'HOST_SECRET' }),
    upstream: `http://127.0.0.1:${(upstream.address() as {port:number}).port}`, ...opts });
  const tcp = createTcpServer(socket => broker.attach(socket));
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const base = `http://127.0.0.1:${(tcp.address() as {port:number}).port}`;
  const request = (path = '/v1/messages', body: unknown = { model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [] }, token = broker.token) => fetch(base + path, {
    method: 'POST', headers: { 'x-api-key': token, cookie: 'do-not-forward', 'x-forwarded-host': 'evil.invalid' }, body: JSON.stringify(body),
  });
  return { broker, requests, request, status: (s: number) => { status = s; }, async close() {
    broker.revoke(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(r => tcp.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
  } };
}

test('API key substitution, endpoint policy, usage and model pass through; errors and redirects sanitized', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/v1/messages', undefined, 'forged')).status, 401);
    assert.equal((await f.request('/v1/models')).status, 403);
    assert.equal((await f.request('/v1/messages?destination=evil')).status, 403);
    assert.equal((await f.request('/v1/messages', { model: 'gpt-test', max_tokens: 1 })).status, 403);
    assert.equal(f.requests.length, 0);
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-secret'), null);
    assert.deepEqual(await response.json(), { usage: { cache_read_input_tokens: 123 } });
    assert.equal(f.requests[0].headers['x-api-key'], 'HOST_SECRET');
    assert.equal(f.requests[0].headers.authorization, undefined);
    assert.equal(f.requests[0].headers.cookie, undefined);
    assert.equal(f.requests[0].headers['x-forwarded-host'], undefined);
    assert.equal((f.requests[0].body as {model:string}).model, 'claude-sonnet-4-6');
    assert.equal((await f.request('/v1/messages/count_tokens?beta=true', { model: 'claude-opus-4-8', messages: [] })).status, 200);
    f.status(302); const redirect = await f.request();
    assert.equal(redirect.status, 502); assert.ok(!(await redirect.text()).includes('HOST_SECRET'));
    f.status(401); const denied = await f.request();
    assert.equal(denied.status, 401); assert.ok(!(await denied.text()).includes('HOST_SECRET'));
  } finally { await f.close(); }
});

test('grants are execution-bound, request-limited, expire and revoke', async () => {
  const a = await fixture({ maxRequests: 1 }); const b = await fixture();
  try {
    assert.equal((await b.request('/v1/messages', undefined, a.broker.token)).status, 401);
    assert.equal(b.requests.length, 0);
    assert.equal((await a.request()).status, 200);
    assert.equal((await a.request()).status, 429);
    a.broker.revoke(); await assert.rejects(a.request());
  } finally { await a.close(); await b.close(); }
  const expired = await fixture({ ttlMs: 20 });
  try { await new Promise(r => setTimeout(r, 30)); await assert.rejects(expired.request()); assert.equal(expired.requests.length, 0); }
  finally { await expired.close(); }
});

test('credential failure is sanitized and does not make upstream calls', async () => {
  const f = await fixture({ credential: () => { throw new Error('HOST_SECRET'); } });
  try { const r = await f.request(); assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('HOST_SECRET')); assert.equal(f.requests.length, 0); }
  finally { await f.close(); }
});

test('credential source is pinned; keychain removal cannot fall back to credentials file', () => {
  let keychain: string | null = JSON.stringify({ claudeAiOauth: { accessToken: 'initial' } });
  const reader = createPinnedClaudeOAuthReader({ platform: 'darwin', configDir: '', keychainLookup: () => keychain,
    readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: 'other-account' } }) });
  assert.equal(reader()?.accessToken, 'initial');
  keychain = JSON.stringify({ claudeAiOauth: { accessToken: 'rotated' } });
  assert.equal(reader()?.accessToken, 'rotated');
  keychain = null; assert.equal(reader(), null);
  const env = { ANTHROPIC_API_KEY: 'initial' }; const api = createClaudeCredentialReader(env);
  assert.deepEqual(api(), { kind: 'api-key', secret: 'initial' });
  env.ANTHROPIC_API_KEY = ''; assert.throws(api, /unavailable/);
  assert.throws(() => createClaudeCredentialReader({ ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b' }), /only one/);
  assert.throws(() => createClaudeCredentialReader({ CLAUDE_CODE_USE_BEDROCK: '1' }), /unsupported/);
});

test('in-flight admission is bounded before credentials or upstream I/O', async () => {
  let release!: () => void; let admitted!: () => void;
  const entered = new Promise<void>(r => admitted = r);
  const held = new Promise<void>(r => release = r);
  const f = await fixture({ maxConcurrent:1, credential:async () => { admitted(); await held; return {kind:'oauth',secret:'HOST_SECRET'}; } });
  try {
    const first = f.request(); await entered;
    assert.equal((await f.request()).status,429);
    assert.equal(f.requests.length,0);
    release(); assert.equal((await first).status,200);
  } finally { release(); await f.close(); }
});

test('body resources and explicit model grants are enforced', async () => {
  const f = await fixture({models:['claude-haiku-4-5']});
  try {
    assert.equal((await f.request()).status,403);
    assert.equal((await f.request('/v1/messages',{model:'claude-haiku-4-5',max_tokens:128001})).status,403);
    assert.equal((await f.request('/v1/messages',{model:'claude-haiku-4-5',max_tokens:32,messages:['x'.repeat(16*1024*1024)]})).status,413);
    assert.equal(f.requests.length,0);
  } finally { await f.close(); }
});

test('expired host login fails closed and rotation in its selected file recovers', async () => {
  const {mkdtempSync,writeFileSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(),'claude-login-test-'));
  try {
    const path = join(dir,'.credentials.json');
    writeFileSync(path,JSON.stringify({claudeAiOauth:{accessToken:'expired',expiresAt:Date.now()-1}}));
    const reader = createClaudeCredentialReader({CLAUDE_CONFIG_DIR:dir});
    assert.throws(reader,/expired/);
    writeFileSync(path,JSON.stringify({claudeAiOauth:{accessToken:'rotated',expiresAt:Date.now()+60000}}));
    assert.deepEqual(reader(),{kind:'oauth',secret:'rotated'});
    rmSync(path); assert.throws(reader,/missing/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('provider secrets/helpers in agent settings are rejected without echoing values', async () => {
  const {assertClaudeBrokerSettings} = await import('./claude-auth-broker.js');
  for (const settings of [{apiKeyHelper:'print SECRET'}, {env:{ANTHROPIC_API_KEY:'SECRET'}}, {env:{ANTHROPIC_BASE_URL:'http://other'}}]) {
    assert.throws(()=>assertClaudeBrokerSettings(settings), e=>e instanceof Error && !e.message.includes('SECRET'));
  }
  assert.doesNotThrow(()=>assertClaudeBrokerSettings({env:{ENABLE_PROMPT_CACHING_1H:'1'}}));
});
