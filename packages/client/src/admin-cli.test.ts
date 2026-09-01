import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '@optique/core/parser';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAddCaller,
  runAgentCallersIssue,
  runAgentCallersAdd,
  runAgentCallersAddFederated,
  runAgentCallersList,
  runAgentCallersRemove,
  runAgentCallersRemoveFederated,
  runAgentDelete,
  runAgentList,
  runListAgents,
  runListCallers,
  runListClients,
  runRemoveCaller,
  runRevokeClient,
  runAgentX402Show,
  runAgentX402Set,
  runAgentX402Clear,
  agentCmd,
  type AgentX402SetArgs,
  type AddCallerArgs,
  type AgentCallersIssueArgs,
  type AgentCallersAddArgs,
  type AgentCallersAddFederatedArgs,
  type AgentCallersListArgs,
  type AgentCallersRemoveArgs,
  type AgentCallersRemoveFederatedArgs,
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
const federatedArgs = {
  issuer: 'did:web:connector.example',
  method: 'urn:mentionable:auth:slack-member:v0.1',
  subject: 'slack:T123/U456',
} as const;
const agentCallersAddFederatedArgsFn = (
  agentId: string,
  p: Partial<AgentCallersAddFederatedArgs> = {},
): AgentCallersAddFederatedArgs =>
  ({ action: 'agent-callers-add-federated', agentId, ...federatedArgs, ...SHARED, ...p });
const agentCallersRemoveFederatedArgsFn = (
  agentId: string,
  p: Partial<AgentCallersRemoveFederatedArgs> = {},
): AgentCallersRemoveFederatedArgs =>
  ({ action: 'agent-callers-remove-federated', agentId, ...federatedArgs, ...SHARED, ...p });
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

// Captures stdout for assertions while still forwarding to the real stream.
//
// Forwarding is not cosmetic. `node --test` pipes its reporter into this same
// `process.stdout`, emitting each test's result line as that test completes —
// which usually lands while the *next* test has stdout patched. Swallowing
// writes therefore eats the runner's own output: the results vanish and the
// final counts shrink to whatever happened to be emitted outside a capture
// window. That silently dropped 32 of this file's tests once, with a green
// "0 failed" summary, so the noise of echoing the CLI's own output is the
// cheaper trade. Assertions are unaffected — they read `captured`.
function captureStdout(t: { after: (fn: () => void) => void }): { read: () => string } {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
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
  // Pure TYPE/PRINCIPAL table — no agent/owner/is_public header block (those
  // stay in --json). The PRINCIPAL column keeps the full canonical form so it
  // pastes straight into `agent callers remove`.
  assert.match(out, /^TYPE\s+PRINCIPAL$/m);
  assert.match(out, /^eth\s+eth:0x1111111111111111111111111111111111111111$/m);
  assert.match(out, /^google:email\s+google:email:alice@example\.com$/m);
  assert.doesNotMatch(out, /^agent:/m);
  assert.doesNotMatch(out, /^is_public:/m);
});

test('callers list shows the public empty-state when there are no allowed_callers', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, {
    body: { agent_id: 'foo', owner_principal: 'eth:0xabc', is_public: true, allowed_callers: [] },
  });

  assert.equal(await runListCallers(listCallersArgs('foo')), 0);
  const out = stdout.read();
  assert.match(out, /\(no callers — agent is public\)/);
  assert.doesNotMatch(out, /TYPE\s+PRINCIPAL/);
});

test('callers list decodes federated tuples for human inspection', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, {
    body: {
      agent_id: 'foo',
      owner_principal: 'eth:0xabc',
      is_public: false,
      allowed_callers: ['federated:v1:opaque-canonical-value'],
      federated_callers: [{
        principal: 'federated:v1:opaque-canonical-value',
        ...federatedArgs,
      }],
    },
  });

  assert.equal(await runAgentCallersList(agentCallersListArgsFn('foo')), 0);
  const out = stdout.read();
  assert.match(out, /FEDERATED CALLERS/);
  assert.match(out, /did:web:connector\.example/);
  assert.match(out, /urn:mentionable:auth:slack-member:v0\.1/);
  assert.match(out, /slack:T123\/U456/);
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

test('agent callers add-federated/remove-federated use the structured policy API', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, {
    body: { agent_id: 'foo', allowed_callers: [], federated_callers: [] },
  });

  assert.equal(await runAgentCallersAddFederated(agentCallersAddFederatedArgsFn('foo')), 0);
  assert.equal(await runAgentCallersRemoveFederated(agentCallersRemoveFederatedArgsFn('foo')), 0);
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['POST', `${BRIDGE}/admin-api/agents/foo/federated-callers`],
    ['DELETE', `${BRIDGE}/admin-api/agents/foo/federated-callers`],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body!), federatedArgs);
  assert.deepEqual(JSON.parse(calls[1].body!), federatedArgs);
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
  for (const [subcommand, action] of [
    ['add-federated', 'agent-callers-add-federated'],
    ['remove-federated', 'agent-callers-remove-federated'],
  ] as const) {
    expectOk([
      'agent', 'callers', subcommand, 'foo',
      '--issuer', federatedArgs.issuer,
      '--method', federatedArgs.method,
      '--subject', federatedArgs.subject,
    ], { action, agentId: 'foo', ...federatedArgs });
  }
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

// `agent x402 {show,clear}` are in the same tie-class as `callers {list,remove}`:
// an AGENT_ID positional competing with the all-optional top-level `list` /
// `remove`. They are registered before those siblings for the same reason, and
// this asserts the ordering holds.
test('agent x402 subcommands parse through the real parser with their AGENT_ID', () => {
  const setDefaults = {
    file: undefined,
    scheme: undefined,
    network: undefined,
    asset: undefined,
    payTo: undefined,
    amount: undefined,
    maxAmount: undefined,
    minAmount: undefined,
    rateInput: undefined,
    rateOutput: undefined,
    rateCachedInput: undefined,
    facilitator: undefined,
    description: undefined,
  };
  const expectOk = (argv: string[], expected: Record<string, unknown>) => {
    const r = parse(agentCmd, argv);
    assert.equal(r.success, true, `expected ${argv.join(' ')} to parse`);
    if (r.success) assert.deepEqual(r.value, { ...SHARED, ...expected });
  };

  expectOk(['agent', 'x402', 'show', 'foo'], { action: 'agent-x402-show', agentId: 'foo' });
  expectOk(['agent', 'x402', 'clear', 'foo'], { action: 'agent-x402-clear', agentId: 'foo' });
  expectOk(['agent', 'x402', 'set', 'foo', '--amount', '10000'], {
    action: 'agent-x402-set',
    agentId: 'foo',
    ...setDefaults,
    amount: '10000',
  });
  expectOk(['agent', 'x402', 'set', 'foo', '--file', '-'], {
    action: 'agent-x402-set',
    agentId: 'foo',
    ...setDefaults,
    file: '-',
  });
});

// ---- agent x402 (pricing) ---------------------------------------------------

const x402ShowArgs = (agentId: string) =>
  ({ action: 'agent-x402-show' as const, agentId, ...SHARED });
const x402ClearArgs = (agentId: string) =>
  ({ action: 'agent-x402-clear' as const, agentId, ...SHARED });
const x402SetArgs = (agentId: string, p: Record<string, unknown> = {}) =>
  ({
    action: 'agent-x402-set' as const,
    agentId,
    ...SHARED,
    file: undefined,
    scheme: undefined,
    network: undefined,
    asset: undefined,
    payTo: undefined,
    amount: undefined,
    maxAmount: undefined,
    minAmount: undefined,
    rateInput: undefined,
    rateOutput: undefined,
    rateCachedInput: undefined,
    facilitator: undefined,
    description: undefined,
    ...p,
  }) as unknown as AgentX402SetArgs;

const PAY_TO = '0x1111111111111111111111111111111111111111';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

test('agent x402 show GETs the pricing endpoint', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, { body: { agent_id: 'foo', x402_pricing: null } });

  assert.equal(await runAgentX402Show(x402ShowArgs('foo')), 0);
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/x402`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('agent x402 show renders a free agent as free rather than as an empty table', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, { body: { agent_id: 'foo', x402_pricing: null } });

  await runAgentX402Show(x402ShowArgs('foo'));
  assert.match(stdout.read(), /free \(no x402 pricing configured\)/);
});

test('agent x402 show warns that an upto agent without a floor serves unmeterable calls free', async (t) => {
  // The one operational footgun of metered pricing: a backend that reports no
  // tokens is charged `minAmount`, which defaults to zero. Surfacing it in
  // `show` is how an operator finds out before the invoices do.
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  const stdout = captureStdout(t);
  installFetch(t, {
    body: {
      agent_id: 'foo',
      x402_pricing: {
        scheme: 'upto',
        network: 'eip155:84532',
        asset: ASSET,
        payTo: PAY_TO,
        maxAmount: '1000000',
        rates: { input: '3000000', output: '15000000' },
        facilitatorAddress: '0x3333333333333333333333333333333333333333',
      },
    },
  });

  await runAgentX402Show(x402ShowArgs('foo'));
  const out = stdout.read();
  assert.match(out, /calls the backend cannot meter are FREE/);
  // The ceiling must not read as the price.
  assert.match(out, /authorized maximum, not the charge/);
  // An omitted cache rate is "same as input", not free — say so.
  assert.match(out, /cached=same as in/);
});

test('agent x402 set PUTs the assembled pricing object', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, {
    body: { agent_id: 'foo', x402_pricing: { scheme: 'exact' } },
  });

  const code = await runAgentX402Set(
    x402SetArgs('foo', {
      network: 'eip155:84532',
      asset: ASSET,
      payTo: PAY_TO,
      amount: '10000',
    }),
  );
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/x402`);
  assert.deepEqual(JSON.parse(calls[0].body as string), {
    network: 'eip155:84532',
    asset: ASSET,
    payTo: PAY_TO,
    amount: '10000',
  });
});

test('agent x402 set nests the --rate-* flags under rates', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, { body: { agent_id: 'foo', x402_pricing: {} } });

  await runAgentX402Set(
    x402SetArgs('foo', {
      scheme: 'upto',
      network: 'eip155:84532',
      asset: ASSET,
      payTo: PAY_TO,
      maxAmount: '1000000',
      minAmount: '1000',
      rateInput: '3000000',
      rateOutput: '15000000',
      rateCachedInput: '300000',
      facilitator: '0x3333333333333333333333333333333333333333',
    }),
  );
  assert.deepEqual(JSON.parse(calls[0].body as string), {
    scheme: 'upto',
    network: 'eip155:84532',
    asset: ASSET,
    payTo: PAY_TO,
    maxAmount: '1000000',
    minAmount: '1000',
    facilitatorAddress: '0x3333333333333333333333333333333333333333',
    rates: { input: '3000000', output: '15000000', cachedInput: '300000' },
  });
});

test('agent x402 set refuses --file combined with field flags', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  const { calls } = installFetch(t, { body: {} });

  const code = await runAgentX402Set(
    x402SetArgs('foo', { file: 'pricing.json', amount: '10000' }),
  );
  assert.equal(code, 1);
  assert.equal(calls.length, 0, 'must not reach the server with an ambiguous request');
  assert.match(stderr.read(), /--file cannot be combined/);
});

test('agent x402 set with nothing to set explains itself instead of clearing pricing', async (t) => {
  // An empty PUT would otherwise be indistinguishable from `clear`, which is
  // a destructive difference for a money setting.
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  const { calls } = installFetch(t, { body: {} });

  assert.equal(await runAgentX402Set(x402SetArgs('foo')), 1);
  assert.equal(calls.length, 0);
  assert.match(stderr.read(), /Nothing to set/);
});

test('agent x402 set reads a pricing object from a file', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, { body: { agent_id: 'foo', x402_pricing: {} } });

  const dir = mkdtempSync(join(tmpdir(), 'x402-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'pricing.json');
  const pricing = { network: 'eip155:84532', asset: ASSET, payTo: PAY_TO, amount: '10000' };
  writeFileSync(path, JSON.stringify(pricing));

  assert.equal(await runAgentX402Set(x402SetArgs('foo', { file: path })), 0);
  assert.deepEqual(JSON.parse(calls[0].body as string), pricing);
});

test('agent x402 clear DELETEs the pricing endpoint', async (t) => {
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const { calls } = installFetch(t, { body: { agent_id: 'foo', x402_pricing: null } });

  assert.equal(await runAgentX402Clear(x402ClearArgs('foo')), 0);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, `${BRIDGE}/admin-api/agents/foo/x402`);
});

test('agent x402 surfaces a server rejection as a non-zero exit', async (t) => {
  // The server owns validation; the CLI must not swallow its 400.
  withEnv(t, { VICOOP_OWNER_TOKEN: TOKEN, VICOOP_BRIDGE: BRIDGE });
  captureStdout(t);
  const stderr = captureStderr(t);
  installFetch(t, { status: 400, body: { error: 'Invalid x402 pricing: bad payTo' } });

  assert.equal(await runAgentX402Set(x402SetArgs('foo', { amount: '10000' })), 1);
  assert.match(stderr.read(), /error \(400\).*Invalid x402 pricing/);
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
