#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const cardUrl = process.argv[2] ?? process.env.A2A_AGENT_CARD_URL;
if (!cardUrl) {
  console.error(
    'usage: node scripts/a2a-v1-smoke.mjs <v1-agent-card-url>\n' +
      '   or: A2A_AGENT_CARD_URL=<url> pnpm e2e:a2a-v1',
  );
  process.exit(2);
}

const bearer = process.env.A2A_BEARER_TOKEN;
const jsonHeaders = {
  'A2A-Version': '1.0',
  'Content-Type': 'application/json',
  ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
};

async function readJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label}: expected JSON, got HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function requestJson(url, init, label) {
  return readJson(await fetch(url, init), label);
}

function collectText(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
  } else if (value && typeof value === 'object') {
    if (typeof value.text === 'string') output.push(value.text);
    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'text') collectText(nested, output);
    }
  }
  return output;
}

function assertCompletedEcho(task, prompt, label) {
  assert.ok(task && typeof task === 'object', `${label}: expected a Task`);
  assert.equal(task.status?.state, 'TASK_STATE_COMPLETED', `${label}: task did not complete`);
  const text = collectText(task).join('\n');
  assert.match(text, new RegExp(`echo: ${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  return task.id;
}

function message(prompt) {
  return {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: prompt }],
  };
}

const card = await requestJson(cardUrl, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }, 'agent card');
assert.ok(Array.isArray(card.supportedInterfaces), 'agent card: supportedInterfaces is missing');

const jsonRpcInterface = card.supportedInterfaces.find(
  (entry) => entry.protocolVersion === '1.0' && entry.protocolBinding === 'JSONRPC',
);
const httpJsonInterface = card.supportedInterfaces.find(
  (entry) => entry.protocolVersion === '1.0' && entry.protocolBinding === 'HTTP+JSON',
);
assert.ok(jsonRpcInterface, 'agent card: JSONRPC v1 interface is missing');
assert.ok(httpJsonInterface, 'agent card: HTTP+JSON v1 interface is missing');
assert.equal(
  jsonRpcInterface.url,
  httpJsonInterface.url,
  'agent card: the two v1 bindings should share one base URL',
);

const requiredExtensions = (card.capabilities?.extensions ?? [])
  .filter((extension) => extension.required)
  .map((extension) => extension.uri);
if (requiredExtensions.length > 0) {
  jsonHeaders['A2A-Extensions'] = requiredExtensions.join(',');
}

let rpcSequence = 0;
async function jsonRpc(method, params) {
  const id = `smoke-${++rpcSequence}`;
  const response = await requestJson(
    jsonRpcInterface.url,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    },
    `JSON-RPC ${method}`,
  );
  assert.equal(response.id, id, `JSON-RPC ${method}: response id mismatch`);
  assert.equal(response.jsonrpc, '2.0', `JSON-RPC ${method}: invalid envelope`);
  assert.ok(!response.error, `JSON-RPC ${method}: ${JSON.stringify(response.error)}`);
  return response.result;
}

const rpcPrompt = `v1-rpc-${randomUUID().slice(0, 8)}`;
const rpcTask = await jsonRpc('SendMessage', {
  message: message(rpcPrompt),
  configuration: { returnImmediately: false },
});
const rpcTaskId = assertCompletedEcho(rpcTask, rpcPrompt, 'JSON-RPC SendMessage');

const restTask = await requestJson(
  `${httpJsonInterface.url}/tasks/${encodeURIComponent(rpcTaskId)}`,
  { headers: jsonHeaders },
  'HTTP+JSON GetTask for JSON-RPC task',
);
assert.equal(restTask.id, rpcTaskId, 'HTTP+JSON GetTask: task id mismatch');
assertCompletedEcho(restTask, rpcPrompt, 'HTTP+JSON GetTask for JSON-RPC task');

const restPrompt = `v1-rest-${randomUUID().slice(0, 8)}`;
const restSend = await requestJson(
  `${httpJsonInterface.url}/message:send`,
  {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      message: message(restPrompt),
      configuration: { returnImmediately: false },
    }),
  },
  'HTTP+JSON SendMessage',
);
const restTaskId = assertCompletedEcho(restSend.task, restPrompt, 'HTTP+JSON SendMessage');

const rpcGet = await jsonRpc('GetTask', { id: restTaskId });
assert.equal(rpcGet.id, restTaskId, 'JSON-RPC GetTask: task id mismatch');
assertCompletedEcho(rpcGet, restPrompt, 'JSON-RPC GetTask for HTTP+JSON task');

const listed = await requestJson(
  `${httpJsonInterface.url}/tasks?pageSize=100&includeArtifacts=true`,
  { headers: jsonHeaders },
  'HTTP+JSON ListTasks',
);
const listedIds = new Set((listed.tasks ?? []).map((task) => task.id));
assert.ok(listedIds.has(rpcTaskId), 'HTTP+JSON ListTasks: JSON-RPC task is missing');
assert.ok(listedIds.has(restTaskId), 'HTTP+JSON ListTasks: HTTP+JSON task is missing');

console.log(JSON.stringify({
  ok: true,
  cardUrl,
  baseUrl: jsonRpcInterface.url,
  transports: ['JSONRPC', 'HTTP+JSON'],
  rpcTaskId,
  restTaskId,
  listedTasks: listed.tasks.length,
}, null, 2));
