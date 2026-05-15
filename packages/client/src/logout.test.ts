import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogoutArgs } from './logout.js';
import { runLogout } from './logout.js';

function logoutArgs(p: Partial<Omit<LogoutArgs, 'action'>> = {}): LogoutArgs {
  return { action: 'logout', localOnly: false, keepLocal: false, ...p };
}

// Pins $VICOOP_HOME so loadOwnerSession / defaultStorePath route into the
// per-test tmp dir regardless of the developer's host env. Returns the
// owner-session.json path and a writer that creates a plausible session
// file at it. Cleanup is registered on the test context.
function pinVicoopHome(t: { after: (fn: () => void) => void }): {
  sessionPath: string;
  writeSession: (overrides?: Record<string, unknown>) => void;
} {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-logout-home-'));
  const vicoopDir = join(tmpHome, '.vicoop');
  mkdirSync(vicoopDir, { recursive: true });

  const previousHome = process.env.HOME;
  const previousVicoop = process.env.VICOOP_HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousEnvToken = process.env.VICOOP_OWNER_TOKEN;
  const previousEnvBridge = process.env.VICOOP_BRIDGE;
  process.env.HOME = tmpHome;
  process.env.VICOOP_HOME = vicoopDir;
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
    if (previousEnvToken === undefined) delete process.env.VICOOP_OWNER_TOKEN;
    else process.env.VICOOP_OWNER_TOKEN = previousEnvToken;
    if (previousEnvBridge === undefined) delete process.env.VICOOP_BRIDGE;
    else process.env.VICOOP_BRIDGE = previousEnvBridge;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const sessionPath = join(vicoopDir, 'owner-session.json');
  return {
    sessionPath,
    writeSession: (overrides = {}) => {
      writeFileSync(
        sessionPath,
        JSON.stringify({
          bridge: 'https://bridge.test',
          token: 'vbc_owner_test',
          principal_id: 'google:123',
          email: 'owner@example.com',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          saved_at: new Date().toISOString(),
          ...overrides,
        }),
      );
    },
  };
}

function mockFetch(
  t: { after: (fn: () => void) => void },
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return handler(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

test('logout with no session file is a no-op success', async (t) => {
  const { sessionPath } = pinVicoopHome(t);
  const calls = mockFetch(t, () => new Response('unreachable'));

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runLogout(logoutArgs());
  assert.equal(code, 0);
  assert.equal(calls.length, 0, 'should not hit the network when no session exists');
  assert.match(stderr, /No owner-session file/);
  assert.equal(existsSync(sessionPath), false);
});

test('logout calls /oauth/revoke and deletes the local file', async (t) => {
  const { sessionPath, writeSession } = pinVicoopHome(t);
  writeSession();

  const calls = mockFetch(t, () => new Response(null, { status: 200 }));
  t.mock.method(process.stderr, 'write', () => true);

  const code = await runLogout(logoutArgs());
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://bridge.test/oauth/revoke');
  assert.match(calls[0].body, /token=vbc_owner_test/);
  assert.match(calls[0].body, /token_type_hint=access_token/);
  assert.equal(existsSync(sessionPath), false);
});

test('logout still deletes the local file when the server returns non-200', async (t) => {
  const { sessionPath, writeSession } = pinVicoopHome(t);
  writeSession();

  mockFetch(t, () => new Response('boom', { status: 500 }));

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runLogout(logoutArgs());
  assert.equal(code, 0);
  assert.match(stderr, /server-side revoke failed/);
  assert.equal(existsSync(sessionPath), false);
});

test('logout still deletes the local file when the network throws', async (t) => {
  const { sessionPath, writeSession } = pinVicoopHome(t);
  writeSession();

  mockFetch(t, () => {
    throw new Error('econnrefused');
  });

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runLogout(logoutArgs());
  assert.equal(code, 0);
  assert.match(stderr, /server-side revoke failed.*econnrefused/);
  assert.equal(existsSync(sessionPath), false);
});

test('logout --local-only skips the network and only deletes the file', async (t) => {
  const { sessionPath, writeSession } = pinVicoopHome(t);
  writeSession();

  const calls = mockFetch(t, () => new Response(null, { status: 200 }));
  t.mock.method(process.stderr, 'write', () => true);

  const code = await runLogout(logoutArgs({ localOnly: true }));
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(sessionPath), false);
});

test('logout --keep-local revokes server-side but leaves the file in place', async (t) => {
  const { sessionPath, writeSession } = pinVicoopHome(t);
  writeSession();

  const calls = mockFetch(t, () => new Response(null, { status: 200 }));

  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const code = await runLogout(logoutArgs({ keepLocal: true }));
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(stderr, /--keep-local/);
  assert.equal(existsSync(sessionPath), true);
});
