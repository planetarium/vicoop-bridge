import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAddCaller,
  runListAgents,
  runListCallers,
  runRemoveCaller,
} from './admin-cli.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function installFetch(t: { after: (fn: () => void) => void }, response: {
  status?: number;
  body?: unknown;
}): { calls: Captured[] } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    // Lowercase all header keys so assertions don't depend on the casing
    // each call site happens to use.
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = v as string;
        }
      }
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const status = response.status ?? 200;
    const body = response.body ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

function withEnv(
  t: { after: (fn: () => void) => void },
  env: Record<string, string | undefined>,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function captureStdout(t: { after: (fn: () => void) => void }): { read: () => string } {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = original;
  });
  return { read: () => captured };
}

function captureStderr(t: { after: (fn: () => void) => void }): { read: () => string } {
  let captured = '';
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
  return { read: () => captured };
}

const TOKEN = 'vbc_owner_testtokenxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const BRIDGE = 'https://bridge.test';

test('list-agents calls GET /admin-api/agents and renders human output', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      agents: [
        {
          agent_id: 'foo',
          client_id: 'cid',
          agent_name: 'Foo',
          allowed_callers: [],
          connected_at: '2026-05-07T00:00:00.000Z',
        },
      ],
    },
  });

  const code = await runListAgents([]);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents`);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.match(stdout.read(), /agent_id:\s+foo/);
});

test('list-agents --json prints raw JSON', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, { body: { agents: [] } });

  const code = await runListAgents(['--json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.read()) as { agents: unknown[] };
  assert.deepEqual(parsed, { agents: [] });
});

test('add-caller posts the principal in the body', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const principal = 'eth:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const { calls } = installFetch(t, {
    body: {
      agent_id: 'foo',
      principal,
      allowed_callers: [principal],
    },
  });

  const code = await runAddCaller(['foo', principal]);
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/callers`);
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body!), { principal });
});

test('remove-caller URL-encodes the principal in the query string', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const principal = 'google:email:owner@example.com';
  const { calls } = installFetch(t, {
    body: { agent_id: 'foo', principal, allowed_callers: [] },
  });

  const code = await runRemoveCaller(['foo', principal]);
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(
    calls[0].url,
    `${BRIDGE}/admin-api/agents/foo/callers?principal=${encodeURIComponent(principal)}`,
  );
});

test('list-callers GETs the agent endpoint', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      agent_id: 'foo',
      owner_principal: 'eth:0xabc',
      allowed_callers: [],
      is_public: true,
    },
  });

  const code = await runListCallers(['foo']);
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/callers`);
});

test('subcommand exits 1 with hint when no token is available', async (t) => {
  // Hermetic missing-auth: redirect HOME (and USERPROFILE on Windows) to an
  // empty temp dir so os.homedir() resolves into a location without an
  // owner-session.json — independent of whether the developer running these
  // tests has one in their real home. With env unset and the file lookup
  // pointing at an empty dir, resolveOwnerSession returns null deterministically.
  const tmpHome = mkdtempSync(join(tmpdir(), 'vicoop-no-token-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  withEnv(t, {
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    VICOOP_OWNER_TOKEN: undefined,
    VICOOP_BRIDGE: undefined,
  });
  const stderr = captureStderr(t);

  // Fetch must not be called when auth is missing; throw if it is so the
  // assertion fails loudly rather than silently masking a regression.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('fetch should not be called when no owner-session is available');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const code = await runListAgents([]);
  assert.equal(code, 1);
  assert.match(stderr.read(), /vicoop-client login --owner-session/);
});

test('subcommand surfaces server error on non-2xx response', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stderr = captureStderr(t);
  installFetch(t, { status: 403, body: { error: 'Not authorized to modify this agent policy.' } });

  const code = await runAddCaller(['foo', 'eth:0xabc']);
  assert.equal(code, 1);
  assert.match(stderr.read(), /403.*Not authorized/);
});
