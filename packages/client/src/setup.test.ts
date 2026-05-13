import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveOwnerSession } from './owner-session.js';
import { runSetup } from './setup.js';
import { readConfig } from './config.js';

test('setup registers client with saved owner-session and writes daemon env', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-home-'));
  const envFile = join(tmpHome, 'vicoop-client.env');
  const calls: Array<{ url: string; body: string; authorization?: string }> = [];
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: 'owner@example.com',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: headers?.Authorization,
    });
    return new Response(JSON.stringify({
      data: {
        registerClient: {
          clientWithToken: {
            id: 'client-1',
            token: 'client-token',
            ownerPrincipal: 'google:123',
            allowedAgentIds: ['agent-1'],
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runSetup([
    '--client-name',
    'test client',
    '--agent-ids',
    'agent-1',
    '--write-env-file',
    envFile,
  ]);

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://bridge.test/graphql');
  assert.equal(calls[0].authorization, 'Bearer vbc_owner_test');
  assert.match(calls[0].body, /registerClient/);
  const envBody = readFileSync(envFile, 'utf8');
  // `. vicoop-client.env` must propagate to the daemon (see #134) — `export`
  // — AND values are single-quoted so shell metacharacters in operator input
  // can't trigger expansion when sourced.
  assert.match(envBody, /^export SERVER_URL='wss:\/\/bridge\.test'$/m);
  assert.match(envBody, /^export SERVER_TOKEN='client-token'$/m);
  assert.match(envBody, /^export AGENT_ID='agent-1'$/m);
  assert.match(stderr, /client_id\s+client-1/);
  assert.match(stderr, /The CLIENT_TOKEN is shown only once/);
  assert.match(stderr, /Save the setup output or env file now/);
  assert.match(stderr, /WARNING: no callers configured/);
});

test('setup configures callers when requested', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-callers-'));
  const calls: Array<{ url: string; body: string; authorization?: string; method?: string }> = [];
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: 'owner@example.com',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: headers?.Authorization,
    });
    if (url.endsWith('/graphql')) {
      return new Response(JSON.stringify({
        data: {
          registerClient: {
            clientWithToken: {
              id: 'client-1',
              token: 'client-token',
              ownerPrincipal: 'google:123',
              allowedAgentIds: ['agent-1'],
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      agent_id: 'agent-1',
      principal: 'eth:0x1111111111111111111111111111111111111111',
      allowed_callers: ['eth:0x1111111111111111111111111111111111111111'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runSetup([
    '--client-name',
    'test client',
    '--agent-ids',
    'agent-1',
    '--caller',
    'eth:0x1111111111111111111111111111111111111111',
  ]);

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://bridge.test/graphql');
  assert.equal(calls[1].url, 'https://bridge.test/admin-api/agents/agent-1/callers');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].authorization, 'Bearer vbc_owner_test');
  assert.deepEqual(JSON.parse(calls[1].body), {
    principal: 'eth:0x1111111111111111111111111111111111111111',
  });
  assert.match(stderr, /Configured caller for agent-1/);
  assert.doesNotMatch(stderr, /WARNING: no callers configured/);
});

test('setup writes client token before caller configuration can fail', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-callers-fail-'));
  const envFile = join(tmpHome, 'vicoop-client.env');
  const calls: Array<{ url: string; method?: string }> = [];
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: 'owner@example.com',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method });
    if (url.endsWith('/graphql')) {
      return new Response(JSON.stringify({
        data: {
          registerClient: {
            clientWithToken: {
              id: 'client-1',
              token: 'client-token',
              ownerPrincipal: 'google:123',
              allowedAgentIds: ['agent-1'],
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not allowed' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runSetup([
    '--client-name',
    'test client',
    '--agent-ids',
    'agent-1',
    '--caller',
    'eth:0x1111111111111111111111111111111111111111',
    '--write-env-file',
    envFile,
  ]);

  assert.equal(code, 1);
  assert.equal(calls.length, 2);
  assert.match(readFileSync(envFile, 'utf8'), /^export SERVER_TOKEN='client-token'$/m);
  assert.match(stderr, /Wrote env block/);
  assert.match(stderr, /add-caller failed for agent-1 \(403\): not allowed/);
});

test('setup requires explicit bridge and token to be passed together', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-explicit-pair-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: 'owner@example.com',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('fetch should not be called for incomplete explicit credentials');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  assert.equal(await runSetup([
    '--client-name',
    'test client',
    '--agent-ids',
    'agent-1',
    '--bridge',
    'https://other-bridge.test',
  ]), 1);
  assert.match(stderr, /Pass --bridge and --token together/);

  stderr = '';
  assert.equal(await runSetup([
    '--client-name',
    'test client',
    '--agent-ids',
    'agent-1',
    '--token',
    'vbc_owner_other',
  ]), 1);
  assert.match(stderr, /Pass --bridge and --token together/);
});

test('setup prompts for login when no owner-session is available', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-no-auth-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  const previousToken = process.env.VICOOP_OWNER_TOKEN;
  const previousBridge = process.env.VICOOP_BRIDGE;
  process.env.HOME = tmpHome;
  delete process.env.VICOOP_OWNER_TOKEN;
  delete process.env.VICOOP_BRIDGE;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousToken === undefined) delete process.env.VICOOP_OWNER_TOKEN;
    else process.env.VICOOP_OWNER_TOKEN = previousToken;
    if (previousBridge === undefined) delete process.env.VICOOP_BRIDGE;
    else process.env.VICOOP_BRIDGE = previousBridge;
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runSetup(['--client-name', 'test client', '--agent-ids', 'agent-1']);

  assert.equal(code, 1);
  assert.match(stderr, /vicoop-client login --bridge/);
});

test('setup writes config.json by default and preserves operator-edited fields', async (t) => {
  // Verify the #137 consolidation: a vanilla `setup` (no --write-env-file)
  // persists server_url / server_token / agent_id into the canonical
  // config.json, AND merges into any pre-existing config the operator may
  // have edited (e.g. backends.claude.settings) instead of clobbering it.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-config-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  const previousVicoop = process.env.VICOOP_HOME;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousVicoop === undefined) delete process.env.VICOOP_HOME;
    else process.env.VICOOP_HOME = previousVicoop;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  // Pre-existing config with operator-edited backend settings — must survive
  // the setup re-run. writeConfig is used directly to seed state (we're
  // checking setup merges, not setup creates).
  const { writeConfig } = await import('./config.js');
  const configPath = join(process.env.VICOOP_HOME, 'config.json');
  writeConfig(configPath, {
    backend: 'claude',
    backends: {
      claude: { settings: { sandbox: { enabled: true } } },
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      data: {
        registerClient: {
          clientWithToken: {
            id: 'client-1',
            token: 'fresh-token',
            ownerPrincipal: 'google:123',
            allowedAgentIds: ['agent-1'],
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runSetup([
    '--client-name', 'test client',
    '--agent-ids', 'agent-1',
  ]);

  assert.equal(code, 0);
  const after = readConfig(configPath);
  assert.deepEqual(after, {
    server_url: 'wss://bridge.test',
    server_token: 'fresh-token',
    agent_id: 'agent-1',
    backend: 'claude',
    backends: {
      claude: { settings: { sandbox: { enabled: true } } },
    },
  });
  assert.match(stderr, new RegExp(`Wrote ${configPath.replace(/[/\\]/g, '[/\\\\]')}`));
});

test('setup --json suppresses config.json write for scripting', async (t) => {
  // The --json contract is "no disk side effects, raw response on stdout" so
  // scripts (CI, pipelines) can compose without leaking state.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-json-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  const previousVicoop = process.env.VICOOP_HOME;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousVicoop === undefined) delete process.env.VICOOP_HOME;
    else process.env.VICOOP_HOME = previousVicoop;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      data: {
        registerClient: {
          clientWithToken: {
            id: 'client-1',
            token: 'json-token',
            ownerPrincipal: 'google:123',
            allowedAgentIds: ['agent-1'],
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let stdout = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, 'write', () => true);

  const code = await runSetup([
    '--client-name', 'test client',
    '--agent-ids', 'agent-1',
    '--json',
  ]);

  assert.equal(code, 0);
  // No config.json on disk.
  assert.equal(readConfig(join(process.env.VICOOP_HOME, 'config.json')), null);
  // Token surfaced through stdout JSON.
  const parsed = JSON.parse(stdout) as { client_token?: string };
  assert.equal(parsed.client_token, 'json-token');
});

test('setup quotes env values so shell metacharacters cannot trigger expansion', async (t) => {
  // The bridge echoes the requested agent id back in `allowed_agent_ids`. If an
  // operator (or some compromised path between them and `setup`) feeds an id
  // containing shell metacharacters, sourcing the generated env file must not
  // run them. Use a deliberately ugly id with `$()`, backticks, and a literal
  // single quote to exercise the close-escape-reopen path.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-quote-'));
  const envFile = join(tmpHome, 'vicoop-client.env');
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  saveOwnerSession({
    bridge: 'https://bridge.test',
    token: 'vbc_owner_test',
    principal_id: 'google:123',
    email: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    saved_at: new Date().toISOString(),
  });

  const evilId = "a'b$(touch /tmp/pwned)`c";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      data: {
        registerClient: {
          clientWithToken: {
            id: 'client-1',
            token: 'tok',
            ownerPrincipal: 'google:123',
            allowedAgentIds: [evilId],
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  t.mock.method(process.stderr, 'write', () => true);

  const code = await runSetup([
    '--client-name',
    't',
    '--agent-ids',
    evilId,
    '--write-env-file',
    envFile,
  ]);
  assert.equal(code, 0);

  const body = readFileSync(envFile, 'utf8');
  // Single-quoted literal with embedded `'` escaped as `'\''`. The expansion
  // forms `$()` and backticks survive verbatim inside the single quotes;
  // they only run if a future change drops the quoting.
  assert.match(body, /^export AGENT_ID='a'\\''b\$\(touch \/tmp\/pwned\)`c'$/m);
  // The AGENT_ID line must open with a single quote immediately after `=`.
  // Anything else (a bare letter, `$`, backtick) means the value escaped the
  // quoted literal and would be evaluated on `. vicoop-client.env`.
  assert.doesNotMatch(body, /^export AGENT_ID=[^']/m);
});
