// Integrated #574/#575 acceptance: actual HTTP consumer, WebSocket supplier,
// PostgreSQL durability and a local HTTP provider. No paid/model API calls.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import WebSocket from 'ws';
import {
  CALLER_CONTEXT_V2_CAPABILITY, CallerContextV2, EXECUTION_SCOPE_V1_CAPABILITY,
  PROTOCOL_VERSION, TASK_REPLAY_CAPABILITY, encodeFrame, parseDownFrame,
  type TaskAssignFrame, type UpFrame,
} from '@vicoop-bridge/protocol';
import { ensureSchema } from './db.js';
import { createHttpApp } from './http.js';
import { Registry } from './registry.js';
import { attachWsServer } from './ws.js';
import { hashToken } from './token.js';
import { issueSessionToken } from './auth/caller-token.js';
import { DeferredJobsService } from './deferred-jobs.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const referenceBytes = Buffer.from('synthetic public-domain reference fixture');
const artifactBytes = Buffer.from('generated fixture artifact; not a provider/model quality assertion');

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (accepts(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(latest)}`);
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Counts both reference upload and generation independently: neither may occur
// merely because a proposal exists, is rejected, or its decision is stale.
async function providerFixture() {
  const requests: Array<{ path: string; bytes: Buffer }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method === 'POST') requests.push({ path: req.url!, bytes: Buffer.concat(chunks) });
    if (req.url === '/reference' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha256: digest(Buffer.concat(chunks)) }));
    } else if (req.url === '/generate' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jobId: randomUUID(), result: '/artifact' }));
    } else if (req.url === '/artifact' && req.method === 'GET') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(artifactBytes);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, requests, stop: () => closeServer(server) };
}

type SupplierHandler = (assignment: TaskAssignFrame, emit: (frame: UpFrame) => void) => Promise<void>;

async function createFixture(sql: postgres.Sql) {
  const runId = randomUUID();
  const agentId = `consent-e2e-${runId}`;
  const owner = `eth:0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;
  const consumer = `apikey:consumer-${runId}`;
  const stranger = `apikey:stranger-${runId}`;
  const token = randomUUID();
  await ensureSchema(sql);
  await sql`INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
    VALUES (${agentId}, ${owner}, 'Consent continuation integration', ${hashToken(token)}, ${[consumer, stranger]})`;
  const ownerToken = (await issueSessionToken(sql, { principalId: owner, provider: 'siwe', audience: 'owner_session' })).rawToken;
  const consumerToken = (await issueSessionToken(sql, { principalId: consumer, provider: 'apikey', audience: 'caller' })).rawToken;
  const strangerToken = (await issueSessionToken(sql, { principalId: stranger, provider: 'apikey', audience: 'caller' })).rawToken;
  let server: Server | undefined;
  let socket: WebSocket | undefined;
  let baseUrl = '';
  let deferredJobs: DeferredJobsService | undefined;
  let supplier: SupplierHandler = async (assignment, emit) => {
    emit({ type: 'task.complete', taskId: assignment.taskId, executionId: assignment.executionId, seq: 0,
      status: { state: 'completed', message: { role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: 'fixture ready' }] } } });
  };
  const assignments: TaskAssignFrame[] = [];
  const errors: unknown[] = [];
  async function disconnect() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    }
    socket = undefined;
  }
  async function stop() {
    deferredJobs?.stop();
    await disconnect();
    if (server) await closeServer(server);
    server = undefined;
  }
  async function start(runWorker = false) {
    const registry = new Registry();
    deferredJobs = new DeferredJobsService({ db: sql, registry });
    const app = createHttpApp({ db: sql, registry, deferredJobs });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
    attachWsServer(server, { db: sql, registry });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
    socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/connect`);
    await once(socket, 'open');
    const hello = once(socket, 'message');
    socket.send(encodeFrame({ type: 'hello', version: PROTOCOL_VERSION, agentId, token,
      protocolCapabilities: [TASK_REPLAY_CAPABILITY, CALLER_CONTEXT_V2_CAPABILITY, EXECUTION_SCOPE_V1_CAPABILITY],
      agentCard: { name: 'Deterministic supplier fixture', version: '1', protocolVersion: '0.3.0', skills: [], capabilities: { streaming: true } } }));
    assert.equal(parseDownFrame((await hello)[0].toString()).type, 'hello.ack');
    socket.on('message', raw => {
      const frame = parseDownFrame(raw.toString());
      if (frame.type !== 'task.assign') return;
      assignments.push(frame);
      const currentSocket = socket!;
      void supplier(frame, event => currentSocket.send(encodeFrame(event))).catch(error => {
        errors.push(error);
        currentSocket.send(encodeFrame({ type: 'task.fail', taskId: frame.taskId, executionId: frame.executionId, seq: 0,
          error: { code: 'fixture_failure', message: String(error) } }));
      });
    });
    if (runWorker) deferredJobs.start(20);
  }
  async function request(path: string, bearer: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  async function rpc(method: string, params: unknown, bearer = consumerToken) {
    const response = await request(`/agents/${agentId}`, bearer, { jsonrpc: '2.0', id: randomUUID(), method, params });
    assert.equal(response.status, 200, await response.clone().text());
    const envelope = await response.json() as { result?: any; error?: unknown };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    assert.ok(envelope.result);
    return envelope.result;
  }
  return { agentId, owner, consumer, stranger, ownerToken, consumerToken, strangerToken, assignments, errors,
    start, stop, request, rpc, tick: () => deferredJobs!.tick(),
    setSupplier: (handler: SupplierHandler) => { supplier = handler; },
    async cleanup() {
      await stop();
      await sql`DELETE FROM infra.deferred_jobs WHERE agent_id = ${agentId}`;
      await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = ${agentId}`;
      await sql`DELETE FROM agents WHERE id = ${agentId}`;
      await sql`DELETE FROM callers WHERE principal_id = ANY(${[owner, consumer, stranger]})`;
    },
  };
}

test('consent/continuation E2E harness uses authenticated HTTP and real WebSocket ingress',
  { skip: !process.env.DATABASE_URL, timeout: 30_000 }, async t => {
    const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
    const fixture = await createFixture(sql);
    t.after(async () => { await fixture.cleanup(); await sql.end(); });
    await fixture.start();
    const task = await fixture.rpc('message/send', {
      message: { messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'Find existing assets first.' }] },
      configuration: { blocking: true },
    });
    assert.equal(task.status.state, 'completed');
    assert.equal(fixture.assignments.length, 1);
    assert.deepEqual(CallerContextV2.parse(fixture.assignments[0]!.caller).principal, { id: fixture.consumer });
    assert.deepEqual(fixture.errors, []);
  });

test('A2A proposal → consumer decision → one provider job → durable continuation → received artifact',
  { skip: !process.env.DATABASE_URL, timeout: 60_000 }, async t => {
    const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
    const fixture = await createFixture(sql);
    const provider = await providerFixture();
    t.after(async () => { await provider.stop(); await fixture.cleanup(); await sql.end(); });
    const proposals = new Map<string, any>();
    const admin = `/admin-api/agents/${fixture.agentId}`;
    const consumer = `/agents/${fixture.agentId}`;
    let expectContinuation = false;
    let originatingContext: string | undefined;
    async function json(response: Response, status = 200): Promise<any> {
      const text = await response.text();
      assert.equal(response.status, status, text);
      return JSON.parse(text);
    }
    const ownerRequest = (path: string, body?: unknown) => fixture.request(`${admin}${path}`, fixture.ownerToken, body);
    const consumerRequest = (path: string, body?: unknown, token = fixture.consumerToken) =>
      fixture.request(`${consumer}${path}`, token, body);

    fixture.setSupplier(async (assignment, emit) => {
      const base = { taskId: assignment.taskId, executionId: assignment.executionId };
      if (expectContinuation) {
        assert.equal(assignment.contextId, originatingContext);
        assert.deepEqual(CallerContextV2.parse(assignment.caller).principal, { id: fixture.consumer });
        const download = await fetch(`${provider.url}/artifact`);
        assert.equal(download.status, 200);
        const downloaded = Buffer.from(await download.arrayBuffer());
        assert.equal(digest(downloaded), digest(artifactBytes));
        emit({ type: 'task.artifact', ...base, seq: 0, lastChunk: true,
          artifact: { artifactId: randomUUID(), name: 'generated-asset', parts: [
            { kind: 'file', file: { name: 'generated.bin', mimeType: 'application/octet-stream', bytes: downloaded.toString('base64') } },
            { kind: 'data', data: { sha256: digest(downloaded) } },
          ] } });
        emit({ type: 'task.complete', ...base, seq: 1, status: { state: 'completed' } });
        return;
      }
      // This fixture is the trusted supplier host adapter. The originating
      // identity is deliberately absent from the registration body.
      const operationId = randomUUID();
      const response = await ownerRequest('/consent-proposals', {
        operationId, sourceTaskId: assignment.taskId, sourceExecutionId: assignment.executionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        approverPolicy: { kind: 'originating-consumer' }, maxAttempts: 1,
        request: {
          prompt: 'Synthetic cliff-hanging pose', references: [{ id: 'synthetic-reference', sha256: digest(referenceBytes) }],
          provider: 'local-fixture', model: 'deterministic-v1', settings: { width: 64, height: 64 },
          output: { mimeType: 'application/octet-stream' }, limitations: ['Fixture does not measure image quality.'],
          externalUpload: { required: true, destinations: [provider.url] },
          cost: { kind: 'estimate', currency: 'USD', amount: '0', terms: 'Unbilled local test provider; estimate is not a cap.' },
        },
      });
      assert.ok([200, 201].includes(response.status), await response.clone().text());
      const registered = await response.json() as any;
      proposals.set(assignment.taskId, registered.proposal);
      assert.equal(registered.status.state, 'input-required');
      emit({ type: 'task.complete', ...base, seq: 0, status: registered.status });
    });
    await fixture.start();
    async function propose() {
      const task = await fixture.rpc('message/send', {
        message: { messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'Search first. Do not generate or upload until approved.' }] },
        configuration: { blocking: true },
      });
      assert.equal(task.status.state, 'input-required');
      assert.ok(task.status.message.parts.some((part: any) => part.kind === 'data'), 'consumer receives structured proposal over A2A');
      const proposal = proposals.get(task.id);
      assert.ok(proposal);
      return { task, proposal, path: `/consent-proposals/${proposal.operationId}` };
    }
    const main = await propose();
    originatingContext = main.task.contextId;
    const binding = { version: main.proposal.version, payloadDigest: main.proposal.payloadDigest };
    const pending = await json(await consumerRequest(main.path));
    assert.equal(pending.proposal.state, 'awaiting_approval');
    assert.equal(provider.requests.length, 0);

    await t.test('ordinary caller permission, prose, cross-context and changed digest do not authorize execution', async () => {
      const request = { ...binding, contextId: main.task.contextId, decisionId: randomUUID(), decision: 'approve' };
      assert.equal((await consumerRequest(`${main.path}/decision`, request, fixture.strangerToken)).status, 404);
      assert.ok([404, 409].includes((await consumerRequest(`${main.path}/decision`, { ...request, contextId: randomUUID() })).status));
      assert.equal((await consumerRequest(`${main.path}/decision`, { ...request, payloadDigest: '0'.repeat(64) })).status, 409);
      assert.equal((await consumerRequest(`${main.path}/decision`, { text: 'approved' })).status, 400);
      assert.equal((await ownerRequest(`${main.path}/claim`, { ...binding, claimId: randomUUID() })).status, 409);
      assert.equal(provider.requests.length, 0);
    });

    await t.test('rejected proposal never permits a provider request', async () => {
      const denied = await propose();
      const deniedBinding = { version: denied.proposal.version, payloadDigest: denied.proposal.payloadDigest };
      await json(await consumerRequest(`${denied.path}/decision`, { ...deniedBinding, contextId: denied.task.contextId, decisionId: randomUUID(), decision: 'reject' }));
      assert.equal((await ownerRequest(`${denied.path}/claim`, { ...deniedBinding, claimId: randomUUID() })).status, 409);
      assert.equal(provider.requests.length, 0);
    });

    await t.test('cancellation and stale approval cannot authorize a replacement', async () => {
      const canceled = await propose();
      const canceledBinding = { version: canceled.proposal.version, payloadDigest: canceled.proposal.payloadDigest };
      await json(await ownerRequest(`${canceled.path}/cancel`, {}));
      const stale = { ...canceledBinding, contextId: canceled.task.contextId, decisionId: randomUUID(), decision: 'approve' };
      assert.equal((await consumerRequest(`${canceled.path}/decision`, stale)).status, 409);
      assert.equal((await ownerRequest(`${canceled.path}/claim`, { ...canceledBinding, claimId: randomUUID() })).status, 409);
      const replacement = await propose();
      assert.notEqual(replacement.proposal.operationId, canceled.proposal.operationId);
      assert.equal((await consumerRequest(`${replacement.path}/decision`, { ...stale, contextId: replacement.task.contextId })).status, 409);
      assert.equal(provider.requests.length, 0);
    });

    const approval = { ...binding, contextId: main.task.contextId, decisionId: randomUUID(), decision: 'approve' };
    await json(await consumerRequest(`${main.path}/decision`, approval));
    await json(await consumerRequest(`${main.path}/decision`, approval));
    assert.equal(provider.requests.length, 0, 'approval itself does not upload or submit');
    const claimId = randomUUID();
    const claims = await Promise.all([1, 2].map(async () => json(await ownerRequest(`${main.path}/claim`, { ...binding, claimId }))));
    assert.equal(claims.filter(claim => claim.execute === true).length, 1);
    assert.equal(claims.filter(claim => claim.execute === false).length, 1);
    assert.equal((await ownerRequest(`${main.path}/claim`, { ...binding, claimId: randomUUID() })).status, 409,
      'a fresh claim ID cannot buy a replacement attempt');
    const authorized = claims.find(claim => claim.execute === true)!;
    assert.equal(authorized.request.references[0].sha256, digest(referenceBytes));
    assert.deepEqual(authorized.request, main.proposal.request, 'executor receives exact stored request');
    const registerJob = await ownerRequest('/deferred-jobs', {
      operationId: main.proposal.operationId, ...binding,
      sourceTaskId: main.task.id,
      sourceExecutionId: fixture.assignments.find(assignment => assignment.taskId === main.task.id)!.executionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.ok([200, 201].includes(registerJob.status), await registerJob.clone().text());
    const jobResponse = await registerJob.json() as any;
    const job = jobResponse.job ?? jobResponse;
    const jobPath = `/deferred-jobs/${job.jobId}`;

    await json(await fetch(`${provider.url}/reference`, { method: 'POST', body: referenceBytes }));
    const generated = await json(await fetch(`${provider.url}/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(authorized.request),
    }));
    assert.deepEqual(provider.requests.map(request => request.path), ['/reference', '/generate']);
    await json(await ownerRequest(`${main.path}/result`, { ...binding, claimId, outcome: 'succeeded', providerJobId: generated.jobId }));
    const completion = { ...binding, eventId: randomUUID(), outcome: 'succeeded', parts: [
      { kind: 'data', data: { providerJobId: generated.jobId, sha256: digest(artifactBytes), url: `${provider.url}/artifact` } },
    ] };
    await json(await ownerRequest(`${jobPath}/complete`, completion));
    await json(await ownerRequest(`${jobPath}/complete`, completion));
    assert.equal((await ownerRequest(`${jobPath}/complete`, { ...completion, payloadDigest: 'f'.repeat(64) })).status, 409);
    assert.equal((await fixture.request(`${admin}${jobPath}/complete`, fixture.consumerToken, completion)).status, 401,
      'consumer cannot impersonate the trusted completion executor');
    const sourceBefore = await fixture.rpc('tasks/get', { id: main.task.id });
    const priorAssignments = fixture.assignments.length;
    await fixture.stop();
    expectContinuation = true;
    await fixture.start(true);
    assert.equal((await json(await ownerRequest(`${main.path}/claim`, { ...binding, claimId }))).execute, false);
    const finished = await eventually(async () => {
      const view = await json(await ownerRequest(jobPath));
      return view.job ?? view;
    }, view => Boolean(view.continuationTaskId) && ['completed', 'succeeded', 'delivered'].includes(view.state), 'continuation completion');
    assert.notEqual(finished.continuationTaskId, main.task.id);
    const delivered = await fixture.rpc('tasks/get', { id: finished.continuationTaskId });
    assert.equal(delivered.status.state, 'completed');
    assert.equal(delivered.contextId, main.task.contextId);
    const file = delivered.artifacts.flatMap((artifact: any) => artifact.parts).find((part: any) => part.kind === 'file');
    assert.ok(file?.file?.bytes, 'consumer obtains actual attachment bytes via task retrieval');
    assert.equal(digest(Buffer.from(file.file.bytes, 'base64')), digest(artifactBytes));
    const inaccessible = await fixture.request(`/agents/${fixture.agentId}`, fixture.strangerToken,
      { jsonrpc: '2.0', id: randomUUID(), method: 'tasks/get', params: { id: finished.continuationTaskId } });
    assert.ok((await inaccessible.json() as { error?: unknown }).error, 'another authorized caller cannot retrieve the successor artifact');
    assert.equal(fixture.assignments.length, priorAssignments + 1);
    await json(await ownerRequest(`${jobPath}/complete`, completion));
    await fixture.tick();
    assert.equal(fixture.assignments.length, priorAssignments + 1, 'duplicate completion cannot dispatch another continuation');
    assert.equal(provider.requests.length, 2, 'restarts and completion retries cannot re-submit paid work');
    const sourceAfter = await fixture.rpc('tasks/get', { id: main.task.id });
    assert.deepEqual(sourceAfter.status, sourceBefore.status, 'source task was not resurrected');
    assert.deepEqual(fixture.errors, []);
  });
