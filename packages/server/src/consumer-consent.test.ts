import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import postgres from 'postgres';
import { APPROVAL_EXTENSION_URI, ConsentRegistration, type ConsentRegistration as Registration,
  type ConsentDecision, CONSUMER_CONSENT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { ensureSchema } from './db.js';
import { issueSessionToken } from './auth/caller-token.js';
import { issueTokenExchangeAccessToken } from './oauth/token-exchange/store.js';
import { formatFederatedPrincipal } from './auth/principal.js';
import { mountConsumerConsent } from './consumer-consent-http.js';
import { consentDigest, type ConsentProposal } from './consumer-consent.js';

function registration(taskId = randomUUID(), executionId = randomUUID()): Registration {
  return { operationId: randomUUID(), sourceTaskId: taskId, sourceExecutionId: executionId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approverPolicy: { kind: 'originating-consumer' }, maxAttempts: 1,
    request: { prompt: 'A cliff-hanging character pose', references: [{ id: 'reference.png', sha256: 'a'.repeat(64) }],
      provider: 'fixture', model: 'image-v1', settings: { size: '1024x1024', quality: 'medium' },
      output: { count: 1, format: 'png' }, limitations: ['Candidate; visual quality not guaranteed'],
      externalUpload: { required: true, destinations: ['https://provider.example'] },
      cost: { kind: 'estimate', amount: '0.04', currency: 'USD', terms: 'Variable token pricing; not a guaranteed maximum' } } };
}

test('consent digest binds reviewable terms and canonicalizes nested object keys', () => {
  const input = registration();
  assert.equal(consentDigest(input), consentDigest({ ...input, request: { ...input.request,
    settings: { quality: 'medium', size: '1024x1024' } } }));
  const changes: Array<(r: Registration) => void> = [
    r => { r.request.prompt += ' edit'; }, r => { r.request.references[0]!.sha256 = 'b'.repeat(64); },
    r => { r.request.model = 'image-v2'; }, r => { r.request.provider = 'other'; },
    r => { r.request.settings.quality = 'high'; }, r => { r.request.output.count = 2; },
    r => { r.request.cost = { kind: 'variable', currency: 'USD', terms: 'new terms' }; },
    r => { r.request.externalUpload.destinations = ['https://other.example']; },
    r => { r.expiresAt = new Date(Date.now() + 120_000).toISOString(); },
  ];
  for (const mutate of changes) { const next = structuredClone(input); mutate(next); assert.notEqual(consentDigest(next), consentDigest(input)); }
  assert.equal(ConsentRegistration.safeParse({ ...input, maxAttempts: 2 }).success, false);
  assert.equal(ConsentRegistration.safeParse({ ...input, approverPolicy: undefined }).success, false);
  assert.equal(ConsentRegistration.safeParse({ ...input, request: { ...input.request,
    cost: { kind: 'cap', currency: 'USD', amount: '1', terms: 'cap' } } }).success, false);
});

test('durable consumer consent HTTP contract', { skip: !process.env.DATABASE_URL }, async t => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  await ensureSchema(sql);
  const agents: string[] = [], callers: string[] = [], tasks: string[] = [];
  t.after(async () => {
    await sql`DELETE FROM infra.a2a_tasks WHERE task_id = ANY(${tasks})`;
    await sql`DELETE FROM infra.oauth_token_exchange_access_tokens WHERE agent_id = ANY(${agents})`;
    await sql`DELETE FROM agents WHERE id = ANY(${agents})`;
    await sql`DELETE FROM callers WHERE id = ANY(${callers})`;
    await sql.end();
  });
  function app() { const app = new Hono(); mountConsumerConsent(app, { db: sql }); return app; }
  async function session(principal: string, audience: 'owner_session' | 'caller') {
    const token = await issueSessionToken(sql, { principalId: principal, provider: 'siwe', audience });
    callers.push(token.callerId); return token;
  }
  async function fixture(federated = false) {
    const agentId = `consent-${randomUUID()}`, owner = `eth:0x${randomUUID().replaceAll('-', '')}00000000`;
    const principal = federated ? 'slack:T1/U1' : `eth:0x${randomUUID().replaceAll('-', '')}00000000`;
    const actor = 'did:web:connector.example', profile = 'mentionable-v0.1';
    const key = federated ? formatFederatedPrincipal({ issuer: actor, method: 'urn:mentionable:auth:slack-workspace-member:v0.1', subject: principal })! : principal;
    const ownerToken = await session(owner, 'owner_session');
    const consumerToken = federated ? await issueTokenExchangeAccessToken(sql, {
      profileId: profile, agentId, resource: `http://localhost/agents/${agentId}`, principalId: principal,
      actorId: actor, allowedCaller: key, scopes: ['a2a:task.read'], expiresAt: new Date(Date.now() + 300_000),
    }).catch(() => null) : await session(principal, 'caller');
    // Federation token issuance requires its agent row, handled below.
    agents.push(agentId);
    await sql`INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
      VALUES (${agentId}, ${owner}, 'consent', ${randomUUID()}, ${[key]})`;
    const effectiveConsumer = consumerToken ?? await issueTokenExchangeAccessToken(sql, {
      profileId: profile, agentId, resource: `http://localhost/agents/${agentId}`, principalId: principal,
      actorId: actor, allowedCaller: key, scopes: ['a2a:task.read'], expiresAt: new Date(Date.now() + 300_000),
    });
    const taskId = randomUUID(), executionId = randomUUID(), contextId = randomUUID(); tasks.push(taskId);
    await sql`INSERT INTO infra.a2a_tasks (task_id, context_id, state, task_json, owner_agent,
      owner_principal, owner_actor, authorization_profile, authorization_key)
      VALUES (${taskId}, ${contextId}, 'completed', ${sql.json({ id: taskId, contextId, status: { state: 'completed' },
        metadata: { [APPROVAL_EXTENSION_URI]: { executionId } } })}, ${agentId}, ${principal},
        ${federated ? actor : null}, ${federated ? profile : null}, ${federated ? key : null})`;
    const host = `/admin-api/agents/${agentId}/consent-proposals`;
    const consumer = `/agents/${agentId}/consent-proposals`;
    let application = app();
    async function req(path: string, token: string | undefined, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await application.request(path, { method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as any };
    }
    async function create(overrides: Partial<Registration> = {}) {
      const input = { ...registration(taskId, executionId), ...overrides };
      const response = await req(host, ownerToken.rawToken, input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return { input, proposal: response.body.proposal as ConsentProposal, response };
    }
    async function decide(p: ConsentProposal, decision: ConsentDecision['decision'] = 'approve', overrides: Partial<ConsentDecision> = {}) {
      const input: ConsentDecision = { contextId, version: 1, payloadDigest: p.payloadDigest, decisionId: randomUUID(), decision, ...overrides };
      return { input, ...(await req(`${consumer}/${p.operationId}/decision`, effectiveConsumer.rawToken, input)) };
    }
    const claim = (p: ConsentProposal, claimId = randomUUID()) => req(`${host}/${p.operationId}/claim`, ownerToken.rawToken,
      { version: 1, payloadDigest: p.payloadDigest, claimId });
    return { agentId, owner, principal, actor, key, ownerToken, consumerToken: effectiveConsumer, taskId, executionId,
      contextId, host, consumer, req, create, decide, claim, restart: () => { application = app(); } };
  }

  await t.test('pending proposal is concrete and private; chat text and wrong audience cannot decide', async () => {
    const f = await fixture(), { proposal, response } = await f.create();
    assert.equal(response.body.status.state, 'input-required');
    assert.equal(response.body.part.kind, 'data');
    assert.equal(response.body.part.data.type, CONSUMER_CONSENT_EXTENSION_URI);
    assert.deepEqual(response.body.part.data.proposal.request, proposal.request);
    const read = await f.req(`${f.consumer}/${proposal.operationId}`, f.consumerToken.rawToken);
    assert.equal(read.body.proposal.state, 'awaiting_approval');
    assert.equal(JSON.stringify(read.body).includes('ownerRevision'), false);
    assert.equal(JSON.stringify(read.body).includes('credential'), false);
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}`, undefined)).status, 401);
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}/decision`, f.ownerToken.rawToken, { text: 'approved' })).status, 401);
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}/decision`, f.consumerToken.rawToken, { text: 'approved' })).status, 400);
    assert.equal((await f.claim(proposal)).status, 409);
    assert.equal((await f.req(f.host, f.consumerToken.rawToken, registration(f.taskId, f.executionId))).status, 401);
  });
  await t.test('cross-caller, cross-context and changed payload decisions fail without execution', async () => {
    const f = await fixture(), other = await session(`eth:0x${'f'.repeat(40)}`, 'caller'), { proposal } = await f.create();
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}`, other.rawToken)).status, 404);
    assert.equal((await f.decide(proposal, 'approve', { contextId: randomUUID() })).status, 409);
    assert.equal((await f.decide(proposal, 'approve', { payloadDigest: 'b'.repeat(64) })).status, 409);
    assert.equal((await f.claim(proposal)).status, 409);
  });
  await t.test('explicit approval survives restart; concurrent duplicate claims permit only one execution', async () => {
    const f = await fixture(), { proposal } = await f.create();
    const decision = await f.decide(proposal); assert.equal(decision.status, 200);
    f.restart();
    const duplicate = await f.decide(proposal, 'approve', decision.input);
    assert.equal(duplicate.status, 200);
    const claimId = randomUUID();
    const claims = await Promise.all([f.claim(proposal, claimId), f.claim(proposal, claimId)]);
    assert.deepEqual(claims.map(x => x.status), [200, 200]);
    assert.equal(claims.filter(x => x.body.execute === true).length, 1);
    assert.equal(claims.filter(x => x.body.execute === false).length, 1);
    assert.deepEqual(claims.find(x => x.body.execute)!.body.request, proposal.request);
    assert.equal((await f.claim(proposal)).status, 409);
    f.restart(); assert.equal((await f.claim(proposal, claimId)).body.execute, false);
    const result = { version: 1, payloadDigest: proposal.payloadDigest, claimId, outcome: 'unknown' };
    assert.equal((await f.req(`${f.host}/${proposal.operationId}/result`, f.ownerToken.rawToken, result)).status, 200);
    assert.equal((await f.claim(proposal, claimId)).body.execute, false);
    const known = { ...result, outcome: 'succeeded', providerJobId: 'original-provider-job', result: { artifactSha256: 'c'.repeat(64) } };
    assert.equal((await f.req(`${f.host}/${proposal.operationId}/result`, f.ownerToken.rawToken, known)).status, 200);
    assert.equal((await f.req(`${f.host}/${proposal.operationId}/result`, f.ownerToken.rawToken, known)).status, 200);
    assert.equal((await f.req(`${f.host}/${proposal.operationId}/result`, f.ownerToken.rawToken, { ...known, outcome: 'failed' })).status, 409);
    const audit = await f.req(`${f.host}/${proposal.operationId}/audit`, f.ownerToken.rawToken);
    assert.deepEqual(audit.body.events.map((x: any) => x.event.event), ['registered', 'approve', 'claimed', 'execution_unknown', 'execution_succeeded']);
    assert.equal(JSON.stringify(audit.body.events).includes(proposal.request.prompt), false);
  });
  await t.test('rejection and explicit cancellation never permit claims', async () => {
    const f = await fixture(), rejected = await f.create(), canceled = await f.create();
    assert.equal((await f.decide(rejected.proposal, 'reject')).status, 200);
    assert.equal((await f.claim(rejected.proposal)).status, 409);
    assert.equal((await f.decide(rejected.proposal)).status, 409);
    assert.equal((await f.req(`${f.consumer}/${canceled.proposal.operationId}/cancel`, f.consumerToken.rawToken, undefined, 'POST')).status, 200);
    assert.equal((await f.decide(canceled.proposal)).status, 409);
    assert.equal((await f.claim(canceled.proposal)).status, 409);
  });
  await t.test('expiry is durable even when the attempted claim returns conflict', async () => {
    const f = await fixture(), { proposal } = await f.create();
    await f.decide(proposal);
    await sql`UPDATE infra.consumer_consent SET document = jsonb_set(document, '{expiresAt}', ${sql.json(new Date(Date.now() - 1).toISOString())})
      WHERE agent_id = ${f.agentId}`;
    assert.equal((await f.claim(proposal)).status, 409);
    f.restart();
    assert.equal((await f.req(`${f.host}/${proposal.operationId}`, f.ownerToken.rawToken)).body.proposal.state, 'expired');
  });
  await t.test('replacement has a new ID and old approval cannot authorize it; same ID cannot change inputs', async () => {
    const f = await fixture(), first = await f.create(); await f.decide(first.proposal);
    const changed = { ...first.input, request: { ...first.input.request, prompt: 'Changed pose' } };
    assert.equal((await f.req(f.host, f.ownerToken.rawToken, changed)).status, 409);
    const second = await f.create({ ...changed, operationId: randomUUID() });
    assert.equal((await f.claim(second.proposal)).status, 409);
    assert.equal((await f.decide(second.proposal, 'approve', { payloadDigest: first.proposal.payloadDigest })).status, 409);
  });
  await t.test('source execution is validated at creation and later turns do not erase immutable proposal', async () => {
    const f = await fixture();
    assert.equal((await f.req(f.host, f.ownerToken.rawToken, registration(f.taskId, randomUUID()))).status, 409);
    const { proposal } = await f.create();
    await sql`UPDATE infra.a2a_tasks SET task_json = ${sql.json({ metadata: { [APPROVAL_EXTENSION_URI]: { executionId: randomUUID() } } })}
      WHERE task_id = ${f.taskId}`;
    assert.equal((await f.decide(proposal)).status, 200);
    assert.equal((await f.claim(proposal)).body.execute, true);
  });
  await t.test('source cancellation or deletion invalidates pending approval', async () => {
    for (const remove of [false, true]) {
      const f = await fixture(), { proposal } = await f.create(); await f.decide(proposal);
      if (remove) await sql`DELETE FROM infra.a2a_tasks WHERE task_id = ${f.taskId}`;
      else await sql`UPDATE infra.a2a_tasks SET state = 'canceled' WHERE task_id = ${f.taskId}`;
      assert.equal((await f.claim(proposal)).status, 409);
      assert.equal((await f.req(`${f.host}/${proposal.operationId}`, f.ownerToken.rawToken)).body.proposal.state, 'invalidated');
    }
  });
  await t.test('grant removal and re-add cannot resurrect an approval', async () => {
    const f = await fixture(), { proposal } = await f.create(); await f.decide(proposal);
    await sql`UPDATE agents SET allowed_callers = '{}' WHERE id = ${f.agentId}`;
    await sql`UPDATE agents SET allowed_callers = ${[f.principal]} WHERE id = ${f.agentId}`;
    assert.equal((await f.claim(proposal)).status, 409);
  });
  await t.test('token revocation is immediate despite existing verifier cache', async () => {
    const f = await fixture(), { proposal } = await f.create(); await f.decide(proposal);
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}`, f.consumerToken.rawToken)).status, 200);
    await sql`UPDATE callers SET revoked = true WHERE token_hash = encode(digest(${f.consumerToken.rawToken}, 'sha256'), 'hex')`;
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}`, f.consumerToken.rawToken)).status, 401);
    assert.equal((await f.claim(proposal)).status, 409);
  });
  await t.test('owner transfer away and back cannot recover executable consent', async () => {
    const f = await fixture(), { proposal } = await f.create(); await f.decide(proposal);
    await sql`UPDATE agents SET owner_principal = 'eth:0x0000000000000000000000000000000000000000' WHERE id = ${f.agentId}`;
    await sql`UPDATE agents SET owner_principal = ${f.owner} WHERE id = ${f.agentId}`;
    assert.equal((await f.claim(proposal)).status, 404);
  });
  await t.test('federated consumers require exact actor, grant, profile and task scope', async () => {
    const f = await fixture(true), { proposal } = await f.create();
    const wrong = await issueTokenExchangeAccessToken(sql, { profileId: 'other-profile', agentId: f.agentId,
      resource: `http://localhost/agents/${f.agentId}`, principalId: f.principal, actorId: f.actor,
      allowedCaller: f.key, scopes: ['a2a:task.read'], expiresAt: new Date(Date.now() + 300_000) });
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}`, wrong.rawToken)).status, 404);
    const scoped = await issueTokenExchangeAccessToken(sql, { profileId: 'mentionable-v0.1', agentId: f.agentId,
      resource: `http://localhost/agents/${f.agentId}`, principalId: f.principal, actorId: f.actor,
      allowedCaller: f.key, taskId: randomUUID(), scopes: ['a2a:task.read'], expiresAt: new Date(Date.now() + 300_000) });
    assert.equal((await f.req(`${f.consumer}/${proposal.operationId}`, scoped.rawToken)).status, 404);
    assert.equal((await f.decide(proposal)).status, 200);
    assert.equal((await f.claim(proposal)).body.execute, true);
  });
});
