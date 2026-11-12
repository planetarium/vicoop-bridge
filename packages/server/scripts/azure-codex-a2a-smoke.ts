// Real Azure + caller Docker + WebSocket bridge + HTTP A2A attachment retrieval.
// Creates and drops its own randomly named database. By default its PostgreSQL
// server is also a disposable Docker container. To use an existing local server,
// set VICOOP_SMOKE_DATABASE_URL to an admin connection and explicitly opt in with
// VICOOP_SMOKE_CREATE_DATABASE=1. No schema or rows are written to that admin DB.
// Requires Docker and protected host Azure env. Never point this at production.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { createHttpApp } from '../src/http.js';
import { attachWsServer } from '../src/ws.js';
import { Registry } from '../src/registry.js';
import { ensureSchema } from '../src/db.js';
import { issueSessionToken } from '../src/auth/caller-token.js';
import { Client } from '../../client/src/client.js';
import { createCallerRuntime } from '../../client/src/caller-runtime.js';
import { CallerRuntimeConfig } from '../../client/src/caller-runtime-config.js';
import { runDockerCommand } from '../../client/src/docker-command.js';
import { DockerCallerRuntimePool } from '../../client/src/caller-runtime-docker.js';

const image = process.env.VICOOP_AZURE_SMOKE_IMAGE;
assert.ok(image, 'Set VICOOP_AZURE_SMOKE_IMAGE to a pinned real Codex caller image');
assert.ok(process.env.AZURE_OPENAI_API_KEY, 'Set host-only Azure authentication');
const secret = process.env.AZURE_OPENAI_API_KEY;
const id = `azure-a2a-${randomUUID()}`;
const databaseContainer = `${id}-postgres`;
const databaseName = `vicoop_azure_smoke_${randomUUID().replaceAll('-', '')}`;
const externalDatabase = process.env.VICOOP_SMOKE_DATABASE_URL;
assert.ok(!externalDatabase || process.env.VICOOP_SMOKE_CREATE_DATABASE === '1',
  'External PostgreSQL requires VICOOP_SMOKE_CREATE_DATABASE=1 to create/drop a dedicated test database');
const directory = await mkdtemp(join(tmpdir(), 'azure-a2a-'));
const config = CallerRuntimeConfig.parse({image, stateDirectory: join(directory, 'state'), maxScopes: 2,
  taskTimeoutMs: 240000, fileDelivery: { allowedRoots: ['/workspace/output'], maxBytes: 1024, maxTotalBytes: 2048, maxFiles: 2 }});
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 120000 }).trim();
let sql: ReturnType<typeof postgres> | undefined;
let adminSql: ReturnType<typeof postgres> | undefined;
let databaseCreationAttempted = false, databaseContainerAttempted = false;
const sockets = new Set<Socket>();
let report: object | undefined;
const resumeNonce = randomUUID();
let server: ReturnType<typeof serve> | undefined;
let backend: Awaited<ReturnType<typeof createCallerRuntime>> | undefined;
let client: Client | undefined;
let credentialInLogs = false;
const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
const captureLog = (...args: unknown[]) => {
  const line = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
  credentialInLogs ||= line.includes(secret!);
};
// Suppress repetitive HTTP polling logs; scan every line before discarding it.
console.log = captureLog; console.warn = captureLog; console.error = captureLog;
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 30000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
try {
  let databaseUrl = externalDatabase;
  if (!databaseUrl) {
    databaseContainerAttempted = true;
    docker(['run','-d','--name',databaseContainer,'-e','POSTGRES_PASSWORD=smoke-only', '-p','127.0.0.1::5432','postgres:16']);
    const port = docker(['port',databaseContainer,'5432/tcp']).split(':').at(-1);
    databaseUrl = `postgres://postgres:smoke-only@127.0.0.1:${port}/postgres`;
  }
  const dbOptions = {connect_timeout: 5, max: 2, onnotice() {}, connection: {statement_timeout: 10000}};
  adminSql = postgres(databaseUrl, dbOptions);
  await waitFor(async () => { try { await adminSql!`SELECT 1`; return true; } catch { return false; } }, 'PostgreSQL server');
  databaseCreationAttempted = true;
  await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = '/' + databaseName;
  sql = postgres(isolatedUrl.toString(), dbOptions);
  await ensureSchema(sql);
  const principal = `eth:0x${randomUUID().replaceAll('-','')}00000000`;
  const token = randomUUID();
  const hash = createHash('sha256').update(token).digest('hex');
  await sql`WITH registered AS (
    INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
    VALUES (${id}, ${principal}, ${id}, ${hash}, ${[principal]})
    RETURNING client_id, owner_principal, name, token_hash
  ) INSERT INTO clients (id, owner_principal, client_name, token_hash, allowed_agent_ids)
    SELECT client_id, owner_principal, name, token_hash, ${[id]} FROM registered`;
  const caller = await issueSessionToken(sql, {principalId: principal, provider: 'siwe', audience: 'caller'});
  const registry = new Registry();
  const app = createHttpApp({ registry, db: sql, publicUrl: 'http://127.0.0.1' });
  server = serve({fetch: app.fetch, port: 0, hostname: '127.0.0.1'});
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  attachWsServer(server as any, {db: sql, registry});
  await waitFor(() => !!server!.address(), 'HTTP server');
  const address = server.address() as {port: number};
  const base = `http://127.0.0.1:${address.port}`;
  backend = await createCallerRuntime({kind:'codex', agentId:id, config,
    codex:{approvalDecision:'accept', initializeTimeoutMs:30000}});
  client = new Client({serverUrl:base.replace('http:','ws:'), token, agentId:id, backendKind:'codex', backend,
    agentCard:{name:id, description:'Azure attachment smoke',version:'1',protocolVersion:'0.3.0',capabilities:{streaming:true}},
    logSink: {log: captureLog, warn: captureLog, error: captureLog}});
  client.start();
  await waitFor(() => !!registry.getAgent(id), 'client registration');
  async function rpc(method: string, params: unknown) {
    const response = await fetch(`${base}/agents/${id}`, {method:'POST', signal:AbortSignal.timeout(30000),
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${caller.rawToken}`},
      body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
    const body = await response.json() as any;
    assert.ok(!JSON.stringify(body).includes(secret!), 'provider credential exposed in A2A response');
    assert.ok(response.ok && !body.error, `A2A ${method} failed (details withheld)`);
    return body.result;
  }
  async function turn(text: string, contextId?: string) {
    const accepted = await rpc('message/send', {message:{kind:'message',role:'user',messageId:randomUUID(),
      ...(contextId ? {contextId}:{}),parts:[{kind:'text',text}]},configuration:{blocking:false}});
    let task: any;
    await waitFor(async () => {task=await rpc('tasks/get',{id:accepted.id}); return ['completed','failed','canceled','rejected'].includes(task.status.state);}, 'Azure A2A task', 240000);
    assert.equal(task.status.state,'completed','Azure A2A task did not complete');
    return task;
  }
  const bytes = Buffer.from('Azure A2A attachment probe\u0000\u0001\u00ff\n', 'utf8');
  const first = await turn(`Use a shell tool to create /workspace/output/probe.bin by decoding this base64 exactly: ${bytes.toString('base64')}. Discover and call the native send_file tool to attach that file. Do not merely print the path. Remember this nonce for our next turn: ${resumeNonce}. After attaching the file, repeat the exact nonce in your final reply.`);
  function verify(task: any) {
    const files = (task.artifacts ?? []).flatMap((a:any)=>a.parts).filter((p:any)=>p.kind==='file' && p.file?.bytes);
    assert.ok(files.some((p:any)=>Buffer.from(p.file.bytes,'base64').equals(bytes)), 'consumer attachment bytes differ');
  }
  verify(first);
  const resumed = await turn('Recall the exact nonce I asked you to remember in the previous turn. Discover the current native send_file tool and attach /workspace/output/probe.bin again without modifying the file. After attaching it, your final reply must contain only the exact full nonce verbatim. Do not read files to recover the nonce.', first.contextId);
  assert.equal(resumed.contextId,first.contextId);
  verify(resumed);
  // Streaming artifact appends preserve separate text parts; a UUID may span
  // multiple chunks, so reconstruct the consumer-visible text before matching.
  const resumedText = (resumed.artifacts ?? []).flatMap((artifact: any) => artifact.parts ?? [])
    .filter((part: any) => part.kind === 'text').map((part: any) => part.text).join('');
  assert.ok(resumedText.includes(resumeNonce), 'resumed task did not recall the random nonce');
  assert.ok(!JSON.stringify(resumed).includes('conversationReset'), 'ordinary resume unexpectedly reset the conversation');
  assert.ok(!credentialInLogs, 'provider credential exposed in captured logs');
  report = {success:true,transport:'HTTP A2A v0.3 + WebSocket',provider:'Azure OpenAI',
    attachmentBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),initialFile:true,resumedFile:true,conversationResume:true};
} finally {
  const failures: string[] = [];
  const cleanup = async (label: string, action: () => Promise<unknown>) => {
    try { await bounded(action(), label, 60000); } catch { failures.push(label); }
  };
  client?.stop();
  let callerStopped = false;
  await cleanup('caller shutdown', async () => { await backend?.close(); callerStopped = true; });
  if (callerStopped && backend) await cleanup('caller resources', async () => {
    const pool = new DockerCallerRuntimePool('codex',config,id);
    try {
      const scopes = await pool.initialize(false,true);
      const results = await Promise.allSettled(scopes.map(scope => pool.remove(scope,true)));
      assert.ok(results.every(result => result.status === 'fulfilled'));
    } finally { await pool.close(); }
  });
  await cleanup('HTTP shutdown', async () => {
    for (const socket of sockets) socket.destroy(); // Includes upgraded WebSockets.
    if (server) await new Promise<void>((resolve,reject) => server!.close(error => error ? reject(error) : resolve()));
  });
  await cleanup('test database connections', async () => { await sql?.end({timeout: 5}); });
  await cleanup('dedicated test database', async () => {
    if (databaseCreationAttempted) await adminSql!.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });
  await cleanup('admin database connection', async () => { await adminSql?.end({timeout: 5}); });
  if (databaseContainerAttempted) await cleanup('PostgreSQL container', async () => {
    const removed = await runDockerCommand(['rm','-f','-v',databaseContainer]);
    if (removed.exitCode !== 0) {
      const inspected = await runDockerCommand(['container','inspect',databaseContainer]);
      assert.ok(inspected.exitCode !== 0 && /No such (object|container)/i.test(inspected.stderr),
        'PostgreSQL container removal unconfirmed');
    }
  });
  console.log = originalLog; console.warn = originalWarn; console.error = originalError;
  if (failures.length) {
    throw new Error(`Smoke cleanup failed: ${failures.join(', ')}. Recovery state retained at ${directory}`);
  }
  await rm(directory,{recursive:true,force:true});
}
assert.ok(!credentialInLogs, 'provider credential exposed in captured logs');
console.log(JSON.stringify(report));
