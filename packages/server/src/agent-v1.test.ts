import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { AgentCard } from '@vicoop-bridge/protocol';
import { createHttpApp } from './http.js';
import { Registry, type ClientConnection } from './registry.js';
import type { Sql } from './db.js';

function fakeSql(): Sql {
  return (async () => []) as unknown as Sql;
}

function registerAgent(registry: Registry, allowedCallers: string[] = []): void {
  const agentCard: AgentCard = {
    name: 'v1-test-agent',
    description: 'A2A v1 route test',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: { streaming: true },
    skills: [],
  };
  const conn: ClientConnection = {
    agentId: 'v1-test-agent',
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    agentCard,
    allowedCallers,
    ws: { close() {} } as unknown as WebSocket,
    connectedAt: Date.now(),
  };
  assert.deepEqual(registry.registerAgent(conn), { ok: true });
}

function buildApp(allowedCallers: string[] = []) {
  const registry = new Registry();
  registerAgent(registry, allowedCallers);
  return createHttpApp({
    registry,
    db: fakeSql(),
    publicUrl: 'https://bridge.example',
  });
}

test('versioned discovery exposes a v1 dual-transport card without changing v0.3', async () => {
  const app = buildApp();

  const v1Response = await app.request(
    '/agents/v1-test-agent/v1/.well-known/agent-card.json',
  );
  assert.equal(v1Response.status, 200);
  const v1Card = await v1Response.json() as {
    protocolVersion?: string;
    supportedInterfaces: Array<{
      url: string;
      protocolBinding: string;
      protocolVersion: string;
    }>;
  };
  assert.equal(v1Card.protocolVersion, undefined);
  assert.deepEqual(v1Card.supportedInterfaces, [
    {
      url: 'https://bridge.example/agents/v1-test-agent/v1',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
    {
      url: 'https://bridge.example/agents/v1-test-agent/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    },
  ]);

  const v03Response = await app.request(
    '/agents/v1-test-agent/.well-known/agent-card.json',
  );
  assert.equal(v03Response.status, 200);
  const v03Card = await v03Response.json() as { protocolVersion: string; url: string };
  assert.equal(v03Card.protocolVersion, '0.3.0');
  assert.equal(v03Card.url, 'https://bridge.example/agents/v1-test-agent');
});

test('v1 JSON-RPC route returns protocol parse errors with an A2A-Version header', async () => {
  const response = await buildApp().request('/agents/v1-test-agent/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('A2A-Version'), '1.0');
  const body = await response.json() as { error: { code: number } };
  assert.equal(body.error.code, -32700);
});

test('v1 HTTP+JSON routes use structured errors and expose task listing', async () => {
  const app = buildApp();
  const malformed = await app.request('/agents/v1-test-agent/v1/message:send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/a2a+json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('Content-Type') ?? '', /^application\/a2a\+json/);
  const malformedBody = await malformed.json() as { error: { status: string } };
  assert.equal(malformedBody.error.status, 'INVALID_ARGUMENT');

  const missingTask = await app.request('/agents/v1-test-agent/v1/tasks/missing-task');
  assert.equal(missingTask.status, 404);
  const missingTaskBody = await missingTask.json() as { error: { status: string } };
  assert.equal(missingTaskBody.error.status, 'NOT_FOUND');

  const list = await app.request('/agents/v1-test-agent/v1/tasks?pageSize=10');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('A2A-Version'), '1.0');
  const listBody = await list.json() as {
    tasks: unknown[];
    pageSize: number;
    totalSize: number;
  };
  assert.deepEqual(listBody.tasks, []);
  assert.equal(listBody.pageSize, 10);
  assert.equal(listBody.totalSize, 0);

  const wrongVersion = await app.request(
    '/agents/v1-test-agent/v1/tasks?A2A-Version=99.0',
  );
  assert.equal(wrongVersion.status, 400);
  const wrongVersionBody = await wrongVersion.json() as { error: { message: string } };
  assert.match(wrongVersionBody.error.message, /99\.0.*not supported/);
});

test('restricted v1 HTTP+JSON routes return google.rpc.Status auth errors', async () => {
  const response = await buildApp([
    'eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]).request('/agents/v1-test-agent/v1/tasks/missing-task');

  assert.equal(response.status, 401);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/a2a\+json/);
  const body = await response.json() as {
    error: { code: number; status: string; details: Array<{ metadata: { rejectionId: string } }> };
  };
  assert.equal(body.error.code, 401);
  assert.equal(body.error.status, 'UNAUTHENTICATED');
  assert.match(body.error.details[0]!.metadata.rejectionId, /^rej_[0-9a-f]{8}$/);
});

test('CORS preflight allows the A2A-Version request header', async () => {
  const response = await buildApp().request('/agents/v1-test-agent/v1/message:send', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://client.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'A2A-Version,Content-Type',
    },
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /A2A-Version/i);
});
