import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWhoami } from './whoami.js';

// Capture stdout/stderr for the duration of a single runWhoami() call. The
// CLI writes via process.stdout.write directly, so we replace those at the
// fd-stream level rather than mocking console.
function captureIO<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === 'string' ? s : Buffer.from(s).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err += typeof s === 'string' ? s : Buffer.from(s).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((result) => ({ result, stdout: out, stderr: err }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}

test('whoami prints mention / acct / webfinger URL on happy path', async () => {
  const { result, stdout } = await captureIO(() =>
    runWhoami([
      '--agentId',
      '6eec0b6e-claude',
      '--server',
      'wss://vicoop-bridge-server.fly.dev/ws',
    ]),
  );
  assert.equal(result, 0);
  assert.match(stdout, /agentId:\s*6eec0b6e-claude/);
  assert.match(stdout, /host:\s*vicoop-bridge-server\.fly\.dev/);
  assert.match(stdout, /mention:\s*@6eec0b6e-claude@vicoop-bridge-server\.fly\.dev/);
  assert.match(stdout, /acct:\s*acct:6eec0b6e-claude@vicoop-bridge-server\.fly\.dev/);
  assert.match(
    stdout,
    /a2a:\s*https:\/\/vicoop-bridge-server\.fly\.dev\/agents\/6eec0b6e-claude\b/,
  );
  assert.match(
    stdout,
    /a2a card:\s*https:\/\/vicoop-bridge-server\.fly\.dev\/agents\/6eec0b6e-claude\/\.well-known\/agent-card\.json/,
  );
  assert.match(
    stdout,
    /webfinger:\s*https:\/\/vicoop-bridge-server\.fly\.dev\/\.well-known\/webfinger\?resource=acct%3A6eec0b6e-claude%40vicoop-bridge-server\.fly\.dev/,
  );
});

test('whoami --json emits a parseable record', async () => {
  const { result, stdout } = await captureIO(() =>
    runWhoami([
      '--agentId',
      'me',
      '--server',
      'wss://h.example/ws',
      '--json',
    ]),
  );
  assert.equal(result, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.agentId, 'me');
  assert.equal(parsed.host, 'h.example');
  assert.equal(parsed.mention, '@me@h.example');
  assert.equal(parsed.acct, 'acct:me@h.example');
  assert.equal(parsed.a2aEndpoint, 'https://h.example/agents/me');
  assert.equal(
    parsed.a2aCardUrl,
    'https://h.example/agents/me/.well-known/agent-card.json',
  );
});

test('whoami exits 1 with usage when agentId / server are missing', async () => {
  const prev = { agent: process.env.AGENT_ID, server: process.env.SERVER_URL };
  delete process.env.AGENT_ID;
  delete process.env.SERVER_URL;
  try {
    const { result, stderr } = await captureIO(() => runWhoami([]));
    assert.equal(result, 1);
    assert.match(stderr, /missing required/);
  } finally {
    if (prev.agent !== undefined) process.env.AGENT_ID = prev.agent;
    if (prev.server !== undefined) process.env.SERVER_URL = prev.server;
  }
});

test('whoami warns and exits 2 when agentId is not a Mentionable local', async () => {
  const { result, stderr } = await captureIO(() =>
    runWhoami([
      '--agentId',
      'bad/agent',
      '--server',
      'wss://h.example/ws',
    ]),
  );
  assert.equal(result, 2);
  assert.match(stderr, /not a valid Mentionable local-part/);
});
