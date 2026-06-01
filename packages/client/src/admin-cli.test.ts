import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '@optique/core/parser';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAddCaller,
  runAgentCallersIssue,
  runAgentCallersAdd,
  runAgentCallersList,
  runAgentCallersRemove,
  runAgentDelete,
  runAgentList,
  runListAgents,
  runListCallers,
  runListClients,
  runRemoveCaller,
  runRevokeClient,
  agentCmd,
  type AddCallerArgs,
  type AgentCallersIssueArgs,
  type AgentCallersAddArgs,
  type AgentCallersListArgs,
  type AgentCallersRemoveArgs,
  type AgentDeleteArgs,
  type AgentListArgs,
  type ListAgentsArgs,
  type ListCallersArgs,
  type ListClientsArgs,
  type RemoveCallerArgs,
  type RevokeClientArgs,
} from './admin-cli.js';

// `runXxx` handlers now take the parser's discriminated-union output.
// Tests construct that shape directly. Shared auth/output fields default
// to undefined/false so each test only specifies what it cares about.
const SHARED = { server: undefined, token: undefined, json: false } as const;
const listAgentsArgs = (p: Partial<ListAgentsArgs> = {}): ListAgentsArgs =>
  ({ action: 'list-agents', ...SHARED, ...p });
const listClientsArgs = (p: Partial<ListClientsArgs> = {}): ListClientsArgs =>
  ({ action: 'list-clients', ...SHARED, ...p });
const listCallersArgs = (
  agentId: string,
  p: Partial<ListCallersArgs> = {},
): ListCallersArgs => ({ action: 'list-callers', agentId, ...SHARED, ...p });
const addCallerArgs = (
  agentId: string,
  principal: string,
  p: Partial<AddCallerArgs> = {},
): AddCallerArgs => ({ action: 'add-caller', agentId, principal, ...SHARED, ...p });
const removeCallerArgs = (
  agentId: string,
  principal: string,
  p: Partial<RemoveCallerArgs> = {},
): RemoveCallerArgs =>
  ({ action: 'remove-caller', agentId, principal, ...SHARED, ...p });
const revokeClientArgs = (
  target: string,
  p: Partial<RevokeClientArgs> = {},
): RevokeClientArgs => ({ action: 'revoke-client', target, ...SHARED, ...p });
const agentListArgsFn = (p: Partial<AgentListArgs> = {}): AgentListArgs =>
  ({ action: 'agent-list', ...SHARED, connected: false, ...p });
const agentDeleteArgsFn = (
  target: string,
  p: Partial<AgentDeleteArgs> = {},
): AgentDeleteArgs => ({ action: 'agent-delete', target, yes: true, ...SHARED, ...p });
const agentCallersListArgsFn = (
  agentId: string,
  p: Partial<AgentCallersListArgs> = {},
): AgentCallersListArgs => ({ action: 'agent-callers-list', agentId, ...SHARED, ...p });
const agentCallersAddArgsFn = (
  agentId: string,
  principal: string,
  p: Partial<AgentCallersAddArgs> = {},
): AgentCallersAddArgs =>
  ({ action: 'agent-callers-add', agentId, principal, ...SHARED, ...p });
const agentCallersRemoveArgsFn = (
  agentId: string,
  principal: string,
  p: Partial<AgentCallersRemoveArgs> = {},
): AgentCallersRemoveArgs =>
  ({ action: 'agent-callers-remove', agentId, principal, ...SHARED, ...p });
const agentCallersIssueArgsFn = (
  agentId: string,
  p: Partial<AgentCallersIssueArgs> = {},
): AgentCallersIssueArgs =>
  ({ action: 'agent-callers-issue', agentId, label: undefined, ttlDays: undefined, ...SHARED, ...p });

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

  const code = await runListAgents(listAgentsArgs());
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents`);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const out = stdout.read();
  // Table-form: header row + data row, padded with whitespace.
  assert.match(out, /AGENT_ID\s+AGENT_NAME/);
  assert.match(out, /^foo\s+Foo\s+cid\b/m);
});

test('list-agents --json prints raw JSON', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, { body: { agents: [] } });

  const code = await runListAgents(listAgentsArgs({ json: true }));
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

  const code = await runAddCaller(addCallerArgs('foo', principal));
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

  const code = await runRemoveCaller(removeCallerArgs('foo', principal));
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

  const code = await runListCallers(listCallersArgs('foo'));
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/callers`);
});

test('callers list renders allowed_callers as a TYPE/PRINCIPAL table', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, {
    body: {
      agent_id: 'foo',
      owner_principal: 'eth:0xabc',
      is_public: false,
      allowed_callers: [
        'eth:0x1111111111111111111111111111111111111111',
        'google:email:alice@example.com',
      ],
    },
  });

  assert.equal(await runListCallers(listCallersArgs('foo')), 0);
  const out = stdout.read();
  assert.match(out, /^agent:\s+foo$/m);
  assert.match(out, /^is_public:\s+false$/m);
  assert.match(out, /TYPE\s+PRINCIPAL/);
  // The PRINCIPAL column keeps the full canonical form so it pastes straight
  // into `agent callers remove`.
  assert.match(out, /^eth\s+eth:0x1111111111111111111111111111111111111111$/m);
  assert.match(out, /^google:email\s+google:email:alice@example\.com$/m);
});

test('callers list shows the public sentinel when there are no allowed_callers', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, {
    body: { agent_id: 'foo', owner_principal: 'eth:0xabc', is_public: true, allowed_callers: [] },
  });

  assert.equal(await runListCallers(listCallersArgs('foo')), 0);
  const out = stdout.read();
  assert.match(out, /allowed_callers: \(none — agent is public\)/);
  assert.doesNotMatch(out, /TYPE\s+PRINCIPAL/);
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

  const code = await runListAgents(listAgentsArgs());
  assert.equal(code, 1);
  assert.match(stderr.read(), /vicoop-client auth login --server/);
});

test('subcommand surfaces network errors as a clean exit-1 instead of crashing', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stderr = captureStderr(t);

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const code = await runListAgents(listAgentsArgs());
  assert.equal(code, 1);
  assert.match(stderr.read(), /network error.*fetch failed/);
});

test('list-clients calls GET /admin-api/clients and renders rows with connected flag', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      clients: [
        {
          client_id: 'cid-1',
          client_name: 'usage-test-1',
          owner_principal: 'eth:0xabc',
          allowed_agent_ids: ['agent-a'],
          connected: false,
          created_at: '2026-05-07T00:00:00.000Z',
        },
      ],
    },
  });

  const code = await runListClients(listClientsArgs());
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/clients`);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const out = stdout.read();
  // Table-form: header row + data row.
  assert.match(out, /CLIENT_ID\s+CLIENT_NAME\s+ALLOWED_AGENT_IDS/);
  assert.match(out, /^cid-1\s+usage-test-1\s+agent-a\s+false\b/m);
});

test('list-clients --json prints raw JSON', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, { body: { clients: [] } });

  const code = await runListClients(listClientsArgs({ json: true }));
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.read()) as { clients: unknown[] };
  assert.deepEqual(parsed, { clients: [] });
});

test('revoke-client DELETEs /admin-api/clients/<target>', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      client_id: 'cid-1',
      client_name: 'usage-test-1',
      deleted: true,
      closed_connections: 0,
    },
  });

  const code = await runRevokeClient(revokeClientArgs('usage-test-1'));
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/clients/usage-test-1`);
});

test('revoke-client URL-encodes the target (so names with /, : survive)', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const target = 'weird/name:with-colon';
  const { calls } = installFetch(t, {
    body: { client_id: 'cid', client_name: target, deleted: true, closed_connections: 0 },
  });
  const code = await runRevokeClient(revokeClientArgs(target));
  assert.equal(code, 0);
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/clients/${encodeURIComponent(target)}`);
});

test('revoke-client surfaces 409 ambiguous-name error as exit 1', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stderr = captureStderr(t);
  installFetch(t, {
    status: 409,
    body: { error: 'Ambiguous client name "dup" matches multiple clients (a, b). Specify client_id instead.' },
  });

  const code = await runRevokeClient(revokeClientArgs('dup'));
  assert.equal(code, 1);
  assert.match(stderr.read(), /409.*Ambiguous client name/);
});

// Positional-arity checks moved out of these handler tests — `command()`
// declares `target` as a required argument, so optique itself enforces it
// at the top-level parser layer. The handler signature now guarantees a
// non-undefined `target` arrived. Exercising the optique-side rejection
// lives in the top-level CLI integration tests against the cli `or(…)`
// parser (not in this per-subcommand handler suite).

test('subcommand surfaces server error on non-2xx response', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stderr = captureStderr(t);
  installFetch(t, { status: 403, body: { error: 'Not authorized to modify this agent policy.' } });

  const code = await runAddCaller(addCallerArgs('foo', 'eth:0xabc'));
  assert.equal(code, 1);
  assert.match(stderr.read(), /403.*Not authorized/);
});

// ---- New `agent <sub>` command group (#218) --------------------------------

// `agent list` calls the same /admin-api/clients endpoint as the legacy
// list-clients (the server-side unified persistence in #219 makes them
// equivalent), but renders rows agent-id-first to match the operator-facing
// model.
test('agent list calls GET /admin-api/clients and renders agent-centric rows', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      clients: [
        {
          client_id: 'cid-1',
          agent_id: 'agent-a',
          client_name: 'codex on Mac',
          owner_principal: 'eth:0xabc',
          allowed_agent_ids: ['agent-a'],
          connected: true,
          created_at: '2026-05-07T00:00:00.000Z',
        },
      ],
    },
  });

  const code = await runAgentList(agentListArgsFn());
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/clients`);
  const out = stdout.read();
  // Header row puts AGENT_ID first. The legacy client_id is intentionally
  // omitted from the human table — it remains available via --json.
  assert.match(out, /AGENT_ID\s+NAME\s+CONNECTED\s+REGISTERED_AT\s*$/m);
  assert.match(out, /^agent-a\s+codex on Mac\s+true\s+\S+\s*$/m);
  assert.doesNotMatch(out, /cid-1/);
});

// --connected filters client-side so the human view only shows live daemons
// even though the API itself returns every registration.
test('agent list --connected filters to connected rows in human + JSON output', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, {
    body: {
      clients: [
        {
          client_id: 'cid-1', agent_id: 'agent-a', client_name: 'live',
          owner_principal: 'eth:0xabc', allowed_agent_ids: ['agent-a'],
          connected: true,
          created_at: '2026-05-07T00:00:00.000Z',
        },
        {
          client_id: 'cid-2', agent_id: 'agent-b', client_name: 'stale',
          owner_principal: 'eth:0xabc', allowed_agent_ids: ['agent-b'],
          connected: false,
          created_at: '2026-05-07T00:00:00.000Z',
        },
      ],
    },
  });

  const code = await runAgentList(agentListArgsFn({ json: true, connected: true }));
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.read()) as { clients: Array<{ agent_id: string }> };
  assert.deepEqual(parsed.clients.map((c) => c.agent_id), ['agent-a']);
});

test('agent list --connected with no live agents prints the empty-state line', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, { body: { clients: [] } });

  const code = await runAgentList(agentListArgsFn({ connected: true }));
  assert.equal(code, 0);
  assert.match(stdout.read(), /no connected agents/);
});

// `agent delete` keeps the legacy DELETE /admin-api/clients/<target> endpoint
// because the server-side resolver (admin-api.ts resolveClient) accepts an
// agent_id, the legacy client_id, or the registration name. No new endpoint
// is required.
test('agent delete --yes DELETEs /admin-api/clients/<AGENT_ID>', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, {
    body: { client_id: 'cid', client_name: 'agent-a', deleted: true, closed_connections: 1 },
  });

  // agentDeleteArgsFn defaults `yes: true` so the handler skips the Y/N
  // prompt; the prompt path is exercised in a separate test below.
  const code = await runAgentDelete(agentDeleteArgsFn('agent-a'));
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/clients/agent-a`);
});

test('agent delete without --yes aborts when stdin is not a TTY', async (t) => {
  // Confirm-or-abort is unconditional for non-TTY stdin (e.g. CI, pipes) so
  // a script that forgot --yes does not silently delete. The test harness
  // runs under node:test which is non-TTY, exercising the abort branch.
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stderr = captureStderr(t);
  const { calls } = installFetch(t, {
    body: { client_id: 'cid', client_name: 'agent-a', deleted: true, closed_connections: 0 },
  });

  const code = await runAgentDelete(agentDeleteArgsFn('agent-a', { yes: false }));
  assert.equal(code, 1);
  assert.match(stderr.read(), /aborted/);
  assert.equal(calls.length, 0, 'must not have hit the API');
});

test('agent callers list/add/remove hit the existing /admin-api/agents/:id/callers routes', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const principal = 'eth:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const { calls } = installFetch(t, {
    body: { agent_id: 'foo', owner_principal: 'eth:0xabc', allowed_callers: [], is_public: true },
  });

  assert.equal(await runAgentCallersList(agentCallersListArgsFn('foo')), 0);
  assert.equal(await runAgentCallersAdd(agentCallersAddArgsFn('foo', principal)), 0);
  assert.equal(await runAgentCallersRemove(agentCallersRemoveArgsFn('foo', principal)), 0);

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/callers`);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, `${BRIDGE}/admin-api/agents/foo/callers`);
  assert.deepEqual(JSON.parse(calls[1].body!), { principal });
  assert.equal(calls[2].method, 'DELETE');
  assert.equal(
    calls[2].url,
    `${BRIDGE}/admin-api/agents/foo/callers?principal=${encodeURIComponent(principal)}`,
  );
});

// ---- `agent callers issue-api-key` — API key minting (#308) ------------------------

test('agent callers issue-api-key POSTs to /apikeys and prints the secret once', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      agent_id: 'foo',
      key_id: 'Ab3-_xYz12',
      principal: 'apikey:Ab3-_xYz12',
      api_key: 'vbc_caller_SECRETSECRETSECRET',
      label: 'ci-deploy',
      expires_at: '2027-06-01T00:00:00.000Z',
      allowed_callers: ['apikey:Ab3-_xYz12'],
    },
  });

  const code = await runAgentCallersIssue(
    agentCallersIssueArgsFn('foo', { label: 'ci-deploy', ttlDays: 365 }),
  );
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/apikeys`);
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body!), { label: 'ci-deploy', ttlDays: 365 });
  const out = stdout.read();
  assert.match(out, /key_id:\s+Ab3-_xYz12/);
  assert.match(out, /vbc_caller_SECRETSECRETSECRET/);
});

test('agent callers issue-api-key omits unset label/ttlDays from the body', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, {
    body: {
      agent_id: 'foo', key_id: 'k', principal: 'apikey:k',
      api_key: 'vbc_caller_x', label: null, expires_at: '2027-06-01T00:00:00.000Z',
      allowed_callers: ['apikey:k'],
    },
  });

  const code = await runAgentCallersIssue(agentCallersIssueArgsFn('foo'));
  assert.equal(code, 0);
  // Empty object body — server applies its defaults.
  assert.deepEqual(JSON.parse(calls[0].body!), {});
});

// Minting lives under `callers` (issue); listing/revoking are `callers
// list`/`remove` — there is no separate `apikey` group. No deprecation warning.
test('agent callers issue-api-key does NOT emit deprecation warnings', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, {
    body: {
      agent_id: 'foo', key_id: 'k', principal: 'apikey:k',
      api_key: 'vbc_caller_x', label: null, expires_at: '2027-06-01T00:00:00.000Z',
      allowed_callers: ['apikey:k'],
    },
  });

  assert.equal(await runAgentCallersIssue(agentCallersIssueArgsFn('foo')), 0);
  assert.doesNotMatch(stderr.read(), /deprecated/i);
});

// Regression: the sub-subcommands `agent callers list <ID>` and
// `agent callers remove <ID> <PRINCIPAL>` share the literal names `list` /
// `remove` with the top-level `agent list` / `agent remove` commands. Those
// top-level commands have all-optional bodies, so `@optique` `longestMatch`
// used to break the consumed-token tie in their favour — swallowing the
// branch and dropping the `AGENT_ID` positional, which surfaced as
// "Unexpected option or subcommand: <id>". `agentCallersSubCmd` is now ordered
// before the colliding siblings so the correct branch wins. These assertions
// go through the real optique parser (the `runXxx` tests above construct the
// parsed shape directly and would not have caught the parse-level regression).
test('agent callers {list,remove,issue-api-key} parse through the real parser with their AGENT_ID', () => {
  const expectOk = (argv: string[], expected: Record<string, unknown>) => {
    const r = parse(agentCmd, argv);
    assert.equal(r.success, true, `expected ${argv.join(' ')} to parse`);
    if (r.success) assert.deepEqual(r.value, { ...SHARED, ...expected });
  };
  const principal = 'eth:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  expectOk(['agent', 'callers', 'list', 'foo'], { action: 'agent-callers-list', agentId: 'foo' });
  expectOk(['agent', 'callers', 'ls', 'foo'], { action: 'agent-callers-list', agentId: 'foo' });
  expectOk(['agent', 'callers', 'add', 'foo', principal], {
    action: 'agent-callers-add',
    agentId: 'foo',
    principal,
  });
  expectOk(['agent', 'callers', 'remove', 'foo', principal], {
    action: 'agent-callers-remove',
    agentId: 'foo',
    principal,
  });
  expectOk(['agent', 'callers', 'rm', 'foo', principal], {
    action: 'agent-callers-remove',
    agentId: 'foo',
    principal,
  });
  // `issue` is in the same tie-class (AGENT_ID positional vs the all-optional
  // top-level `list`/`remove`) — it must keep its AGENT_ID through the parser.
  expectOk(['agent', 'callers', 'issue-api-key', 'foo'], {
    action: 'agent-callers-issue',
    agentId: 'foo',
    label: undefined,
    ttlDays: undefined,
  });
  // The top-level siblings must keep working after the reorder.
  expectOk(['agent', 'list'], { action: 'agent-list', connected: false });
  expectOk(['agent', 'remove', 'foo', '--yes'], { action: 'agent-delete', target: 'foo', yes: true });
});

// The new `agent` commands must not print a deprecation warning — that's
// reserved for the legacy flat aliases.
test('agent subcommands do NOT emit deprecation warnings', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, { body: { clients: [] } });

  assert.equal(await runAgentList(agentListArgsFn()), 0);
  assert.doesNotMatch(stderr.read(), /deprecated/i);
});

// ---- Deprecation warnings on legacy aliases --------------------------------

test('legacy list-agents prints a deprecation warning pointing at agent list --connected', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, { body: { agents: [] } });

  assert.equal(await runListAgents(listAgentsArgs()), 0);
  assert.match(stderr.read(), /list-agents.*deprecated.*agent list --connected/s);
});

test('legacy list-clients warns and points at agent list', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, { body: { clients: [] } });

  assert.equal(await runListClients(listClientsArgs()), 0);
  assert.match(stderr.read(), /list-clients.*deprecated.*agent list/s);
});

test('legacy revoke-client warns and points at agent remove', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, { body: { client_id: 'c', client_name: 'n', deleted: true, closed_connections: 0 } });

  assert.equal(await runRevokeClient(revokeClientArgs('n')), 0);
  assert.match(stderr.read(), /revoke-client.*deprecated.*agent remove/s);
});

test('legacy {add,remove,list}-caller all emit the agent-callers deprecation hint', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, {
    body: { agent_id: 'foo', owner_principal: 'eth:0xabc', allowed_callers: [], is_public: true },
  });

  const principal = 'eth:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  assert.equal(await runListCallers(listCallersArgs('foo')), 0);
  assert.equal(await runAddCaller(addCallerArgs('foo', principal)), 0);
  assert.equal(await runRemoveCaller(removeCallerArgs('foo', principal)), 0);
  const out = stderr.read();
  assert.match(out, /list-callers.*agent callers list/s);
  assert.match(out, /add-caller.*agent callers add/s);
  assert.match(out, /remove-caller.*agent callers remove/s);
});
