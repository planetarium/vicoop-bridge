import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthLoginArgs, LoginArgs } from './login.js';
import { runAuthLogin, runLogin } from './login.js';

// `runLogin` now takes the parser's discriminated-union output. Tests
// construct that shape directly — argv-level parsing is owned by optique
// and exercised at the integration level in cli.test (top-level `run()`).
function loginArgs(p: Partial<Omit<LoginArgs, 'action'>> = {}): LoginArgs {
  return { action: 'login', server: undefined, json: false, pollOnce: false, ...p };
}

function authLoginArgs(p: Partial<Omit<AuthLoginArgs, 'action'>> = {}): AuthLoginArgs {
  return { action: 'auth-login', server: undefined, json: false, pollOnce: false, ...p };
}

test('login saves owner-session bearer without registering a client', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-login-home-'));
  const calls: Array<{ url: string; body: string }> = [];
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  // Pin `resolveConfigDir()` to `${tmpHome}/.vicoop` regardless of host env
  // by setting `VICOOP_HOME` directly (its precedence is "explicit override
  // wins"). Without this, a CI runner with `XDG_CONFIG_HOME` already exported
  // would route the owner-session write to `$XDG_CONFIG_HOME/vicoop/...`
  // instead of `${tmpHome}/.vicoop/...`, and the later `readFileSync`
  // assertion would `ENOENT`. Restore every touched env on teardown.
  const previousHome = process.env.HOME;
  const previousVicoop = process.env.VICOOP_HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpHome;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  delete process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousVicoop === undefined) delete process.env.VICOOP_HOME;
    else process.env.VICOOP_HOME = previousVicoop;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    call++;
    if (call === 1) {
      return new Response(JSON.stringify({
        device_code: 'device-test',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://bridge.test/oauth/device',
        verification_uri_complete: 'https://bridge.test/oauth/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      access_token: 'vbc_owner_test',
      token_type: 'Bearer',
      expires_in: 3600,
      principal_id: 'google:123',
      email: 'owner@example.com',
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

  const code = await runLogin(loginArgs({ server: 'https://bridge.test' }));

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body, /intent=owner_session/);
  assert.ok(!calls.some((c) => c.url.endsWith('/graphql')));
  const saved = JSON.parse(
    readFileSync(join(tmpHome, '.vicoop', 'owner-session.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(saved.bridge, 'https://bridge.test');
  assert.equal(saved.token, 'vbc_owner_test');
  assert.equal(saved.principal_id, 'google:123');
  assert.match(stderr, /Run `vicoop-client agent register`/);
});

test('login falls back to DEFAULT_BRIDGE_HTTPS_URL when --bridge is omitted', async (t) => {
  // Issue #189 §6 / AC#9: fresh installs against the public bridge should
  // need zero flags. `login` no longer requires `--bridge`; absence routes
  // every fetch at the baked-in default URL.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-login-default-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  const previousVicoop = process.env.VICOOP_HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tmpHome;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  delete process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousVicoop === undefined) delete process.env.VICOOP_HOME;
    else process.env.VICOOP_HOME = previousVicoop;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(typeof input === 'string' ? input : input.toString());
    call++;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          device_code: 'device-test',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://x/oauth/device',
          verification_uri_complete: 'https://x/oauth/device?u=A',
          expires_in: 600,
          interval: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        access_token: 'vbc_owner_default',
        token_type: 'Bearer',
        expires_in: 3600,
        principal_id: 'google:default',
        email: null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Quiet the stderr usage / approval prompts that runLogin writes during
  // the polling phase — they're not under test here.
  t.mock.method(process.stderr, 'write', () => true);

  const code = await runLogin(loginArgs());
  assert.equal(code, 0);
  // Both round-trips (device-code, token) hit the public bridge HTTPS URL.
  assert.ok(
    seen.every((u) => u.startsWith('https://vicoop-bridge-server.fly.dev/')),
    `expected every fetch to hit the default bridge URL; got ${JSON.stringify(seen)}`,
  );
});

// ---- New `auth login` surface ----------------------------------------------

test('auth login dispatches to the same flow without emitting a deprecation warning', async (t) => {
  const previousHome = process.env.HOME;
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-auth-login-'));
  process.env.HOME = tmpHome;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.VICOOP_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return new Response(JSON.stringify({
        device_code: 'D', user_code: 'AB-CD',
        verification_uri: 'https://bridge.test/oauth/device',
        verification_uri_complete: 'https://bridge.test/oauth/device?user_code=AB-CD',
        expires_in: 600, interval: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      access_token: 'vbc_owner_x', token_type: 'Bearer', expires_in: 3600,
      principal_id: 'google:123', email: 'op@example.com',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runAuthLogin(authLoginArgs({ server: 'https://bridge.test' }));
  assert.equal(code, 0);
  // Same handler body as runLogin (verified by the post-login hint), without
  // the deprecation banner the legacy `login` entry point emits.
  assert.doesNotMatch(stderr, /deprecated/i);
  assert.match(stderr, /Saved owner-session bearer/);
  assert.match(stderr, /Run `vicoop-client agent register`/);
});

test('legacy login prints a deprecation warning pointing at auth login', async (t) => {
  const previousHome = process.env.HOME;
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-legacy-login-'));
  process.env.HOME = tmpHome;
  process.env.VICOOP_HOME = join(tmpHome, '.vicoop');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.VICOOP_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return new Response(JSON.stringify({
        device_code: 'D', user_code: 'AB-CD',
        verification_uri: 'https://bridge.test/oauth/device',
        verification_uri_complete: 'https://bridge.test/oauth/device?user_code=AB-CD',
        expires_in: 600, interval: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      access_token: 'vbc_owner_x', token_type: 'Bearer', expires_in: 3600,
      principal_id: 'google:123', email: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runLogin(loginArgs({ server: 'https://bridge.test' }));
  assert.equal(code, 0);
  assert.match(stderr, /vicoop-client login.*deprecated.*vicoop-client auth login/s);
});
