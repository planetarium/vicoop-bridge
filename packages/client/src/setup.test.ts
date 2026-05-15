import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveOwnerSession } from './owner-session.js';
import { runSetup, type SetupArgs } from './setup.js';
import { readConfig } from './config.js';

// `runSetup` now takes the parser's discriminated-union output. Tests
// construct that shape directly via this helper, which fills in the
// usual defaults and allows partial overrides per case.
function setupArgs(
  p: { clientName: string; allowedAgentIds: readonly string[] }
    & Partial<Omit<SetupArgs, 'action' | 'clientName' | 'allowedAgentIds'>>,
): SetupArgs {
  const {
    clientName, allowedAgentIds,
    callers = [], envFile, envFileAlias, bridge, token, json = false,
  } = p;
  return {
    action: 'setup',
    clientName,
    allowedAgentIds: [...allowedAgentIds],
    callers,
    envFile,
    envFileAlias,
    bridge,
    token,
    json,
  };
}

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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    envFile,
  }));

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
  // Updated banner reflects "token is persisted, not displayed" — setup
  // writes it to config.json by default and only --json prints it.
  assert.match(stderr, /The CLIENT_TOKEN is one-time/);
  assert.match(stderr, /setup persists it to the canonical config/);
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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    callers: ['eth:0x1111111111111111111111111111111111111111'],
  }));

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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    callers: ['eth:0x1111111111111111111111111111111111111111'],
    envFile,
  }));

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

  assert.equal(await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    bridge: 'https://other-bridge.test',
  })), 1);
  assert.match(stderr, /Pass --bridge and --token together/);

  stderr = '';
  assert.equal(await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    token: 'vbc_owner_other',
  })), 1);
  assert.match(stderr, /Pass --bridge and --token together/);
});

test('setup prompts for login when no owner-session is available', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-no-auth-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  // Pin `resolveConfigDir()` to a known empty tmpdir via VICOOP_HOME so the
  // "no owner-session on disk" path is exercised even on CI hosts that have
  // an exported `XDG_CONFIG_HOME` (Linux runners). Without this, the resolver
  // would route loadOwnerSession() at a populated XDG dir and skip the
  // login-prompt branch we're asserting on; the test would then fall through
  // to a real device-flow `fetch`, fail the network call, and surface
  // "fetch failed" on stderr instead of the prompt.
  const previousHome = process.env.HOME;
  const previousVicoop = process.env.VICOOP_HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousToken = process.env.VICOOP_OWNER_TOKEN;
  const previousBridge = process.env.VICOOP_BRIDGE;
  process.env.HOME = tmpHome;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.VICOOP_OWNER_TOKEN;
  delete process.env.VICOOP_BRIDGE;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousVicoop === undefined) delete process.env.VICOOP_HOME;
    else process.env.VICOOP_HOME = previousVicoop;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
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

  const code = await runSetup(setupArgs({ clientName: 'test client', allowedAgentIds: ['agent-1'] }));

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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
  }));

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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    json: true,
  }));

  assert.equal(code, 0);
  // No config.json on disk.
  assert.equal(readConfig(join(process.env.VICOOP_HOME, 'config.json')), null);
  // Token surfaced through stdout JSON.
  const parsed = JSON.parse(stdout) as { client_token?: string };
  assert.equal(parsed.client_token, 'json-token');
});

test('setup refuses to overwrite agent_id with empty when bridge returns no allowed_agent_ids', async (t) => {
  // Defense-in-depth: the server contract guarantees a non-empty allowed_agent_ids
  // (the operator passed --agent-ids and the mutation echoes them back), but if
  // a buggy/tampered response ever returns [], we'd otherwise wipe a populated
  // agent_id in config.json with "" and break the daemon on next start.
  // Fail loud + leave the prior config intact.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-empty-agent-'));
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

  // Pre-existing config that must NOT be overwritten with an empty agent_id.
  const { writeConfig } = await import('./config.js');
  const configPath = join(process.env.VICOOP_HOME, 'config.json');
  writeConfig(configPath, {
    server_url: 'wss://old',
    server_token: 'old-token',
    agent_id: 'still-valid-agent',
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
            // Empty allowed_agent_ids — the misbehaviour we're guarding against.
            allowedAgentIds: [],
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

  // The empty allowed_agent_ids array passes the upstream `!response.allowedAgentIds`
  // truthy check, so it reaches `writeConfigForSetup`'s guard. That's the
  // defense-in-depth point — fail loud instead of writing an empty agent_id.
  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['still-valid-agent'],
  }));
  assert.equal(code, 1);
  assert.match(
    stderr,
    /registerClient returned no allowed_agent_ids/,
    'expected writeConfigForSetup guard message',
  );

  const after = await import('./config.js').then((m) => m.readConfig(configPath));
  assert.deepEqual(after, {
    server_url: 'wss://old',
    server_token: 'old-token',
    agent_id: 'still-valid-agent',
  });
});

test('setup preserves operator-added / future-version keys via raw round-trip', async (t) => {
  // normalizeConfig drops top-level keys it doesn't know about. If setup
  // round-tripped through that, an operator who added (say) a future
  // `telemetry` block in config.json would lose it on every setup re-run.
  // The merge path therefore uses `readConfigRaw` and writes the raw
  // object back; assert the unknown keys survive both top-level and
  // nested-under-backends.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-preserve-'));
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

  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const configPath = join(process.env.VICOOP_HOME, 'config.json');
  mkdirSync(process.env.VICOOP_HOME, { recursive: true, mode: 0o700 });
  // Hand-edited config with two kinds of unknown keys: a future top-level
  // section (`telemetry`) and an unknown subkey of a known backend
  // (`backends.claude.future_flag`). Both should survive the round trip.
  writeFileSync(configPath, JSON.stringify({
    server_url: 'wss://old',
    backend: 'claude',
    backends: {
      claude: {
        settings: { sandbox: { enabled: true } },
        future_flag: 'keep me',
      },
    },
    telemetry: { otel_endpoint: 'http://otel:4317' },
  }));

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

  t.mock.method(process.stderr, 'write', () => true);

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
  }));
  assert.equal(code, 0);

  const after = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(after.server_url, 'wss://bridge.test');
  assert.equal(after.server_token, 'fresh-token');
  assert.equal(after.agent_id, 'agent-1');
  assert.equal(after.backend, 'claude');
  assert.deepEqual(after.telemetry, { otel_endpoint: 'http://otel:4317' });
  assert.deepEqual(
    (after.backends as Record<string, unknown>).claude,
    { settings: { sandbox: { enabled: true } }, future_flag: 'keep me' },
  );
});

test('setup: env-file write failure does NOT trip the canonical-recovery block', async (t) => {
  // Two distinct failure surfaces deserve distinct UX:
  //   - canonical persistence failed → token was lost, dump it to stderr
  //   - env-file emission failed but canonical succeeded → token is safe in
  //     config.json, warn with manual-copy instructions instead of the
  //     "token not persisted" recovery block.
  // This test exercises the latter by pointing --write-env-file at an
  // existing directory, which makes openSync('wx') fail with EISDIR.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-envfail-'));
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

  // Make the requested env-file path collide with a directory so the
  // atomic write trips EISDIR.
  const { mkdirSync } = await import('node:fs');
  const envFile = join(tmpHome, 'a-directory.env');
  mkdirSync(envFile);

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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
    envFile,
  }));
  assert.equal(code, 1);

  // Canonical persisted — assert the token is on disk under VICOOP_HOME.
  const after = readConfig(join(process.env.VICOOP_HOME, 'config.json'));
  assert.equal(after?.server_token, 'fresh-token');
  assert.equal(after?.agent_id, 'agent-1');

  // Warning explains config is safe + how to recover without rotating the
  // token. Crucially, the "[recovery] canonical persistence failed"
  // wording is NOT printed — that's the misleading message we removed.
  assert.match(stderr, /--write-env-file .* failed/);
  assert.match(stderr, /CLIENT_TOKEN was persisted/);
  assert.match(stderr, /would mint a NEW CLIENT_TOKEN/);
  assert.doesNotMatch(stderr, /\[recovery\] canonical persistence failed/);
});

test('setup refuses to overwrite an existing-but-malformed config.json', async (t) => {
  // The merge path leans on readConfig returning the prior file's parsed
  // shape. If the file exists but is malformed (operator hand-edited it into
  // broken JSON), readConfig returns null and the prior `?? {}` fallback
  // would silently start from empty — wiping any backend defaults the
  // operator had added before the typo. Refuse + tell them what to fix.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-setup-malformed-'));
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

  // Pre-write a broken config.json (truncated JSON).
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const configPath = join(process.env.VICOOP_HOME, 'config.json');
  mkdirSync(process.env.VICOOP_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, '{not json');

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

  const code = await runSetup(setupArgs({
    clientName: 'test client',
    allowedAgentIds: ['agent-1'],
  }));
  assert.equal(code, 1);
  // Preflight refuses to mint a token before registerClient runs, so the
  // operator doesn't end up with an unrecoverable bridge registration whose
  // token they never got to see.
  assert.match(stderr, /refusing to mint a token we cannot save/);
  // Broken file left untouched so the operator can inspect it.
  assert.equal(readFileSync(configPath, 'utf8'), '{not json');
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

  const code = await runSetup(setupArgs({
    clientName: 't',
    allowedAgentIds: [evilId],
    envFile,
  }));
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
