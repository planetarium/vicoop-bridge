import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from './login.js';

test('login help flags print usage and exit successfully', async (t) => {
  let stderr = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const longCode = await runLogin(['--help']);
  assert.equal(longCode, 0);
  assert.match(stderr, /usage: vicoop-client login/);

  stderr = '';
  const shortCode = await runLogin(['-h']);
  assert.equal(shortCode, 0);
  assert.match(stderr, /usage: vicoop-client login/);
});

test('login saves owner-session bearer without registering a client', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-login-home-'));
  const calls: Array<{ url: string; body: string }> = [];
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
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

  const code = await runLogin(['--bridge', 'https://bridge.test']);

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
  assert.match(stderr, /Run `vicoop-client setup`/);
});
