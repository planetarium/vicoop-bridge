import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { runWhoami, type WhoamiIO } from './whoami.js';

// Inject a buffered IO so the test runner's TAP output on the real
// process.stdout stays untouched. Globally overriding `process.stdout.write`
// (the previous approach) silently swallowed most test events under
// `node --test`.
function makeIO(): WhoamiIO & { readStdout: () => string; readStderr: () => string } {
  let out = '';
  let err = '';
  return {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdout: () => out,
    readStderr: () => err,
  };
}

// Spin up a real HTTP server so --verify hits a deterministic local
// endpoint instead of touching the network.
function withWebfingerServer<T>(
  handler: (req: { resource: string }, res: { json: (body: unknown, status?: number) => void }) => void,
  fn: (origin: string) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const resource = url.searchParams.get('resource') ?? '';
      const wrapped = {
        json: (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/jrd+json');
          res.end(JSON.stringify(body));
        },
      };
      handler({ resource }, wrapped);
    });
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      const origin = `http://127.0.0.1:${addr.port}`;
      try {
        const out = await fn(origin);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('whoami prints mention / acct / webfinger URL on happy path', async () => {
  const io = makeIO();
  const result = await runWhoami(
    [
      '--agentId',
      '6eec0b6e-claude',
      '--server',
      'wss://vicoop-bridge-server.fly.dev/ws',
    ],
    io,
  );
  assert.equal(result, 0);
  const stdout = io.readStdout();
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
  const io = makeIO();
  const result = await runWhoami(
    ['--agentId', 'me', '--server', 'wss://h.example/ws', '--json'],
    io,
  );
  assert.equal(result, 0);
  const parsed = JSON.parse(io.readStdout());
  assert.equal(parsed.agentId, 'me');
  assert.equal(parsed.host, 'h.example');
  assert.equal(parsed.httpOrigin, 'https://h.example');
  assert.equal(parsed.mention, '@me@h.example');
  assert.equal(parsed.acct, 'acct:me@h.example');
  assert.equal(parsed.a2aEndpoint, 'https://h.example/agents/me');
  assert.equal(
    parsed.a2aCardUrl,
    'https://h.example/agents/me/.well-known/agent-card.json',
  );
});

test('whoami preserves scheme+port for local dev (ws → http, port retained)', async () => {
  const io = makeIO();
  const result = await runWhoami(
    ['--agentId', 'me', '--server', 'ws://localhost:8787/ws', '--json'],
    io,
  );
  assert.equal(result, 0);
  const parsed = JSON.parse(io.readStdout());
  assert.equal(parsed.httpOrigin, 'http://localhost:8787');
  assert.equal(parsed.a2aEndpoint, 'http://localhost:8787/agents/me');
  assert.equal(
    parsed.webfingerUrl,
    'http://localhost:8787/.well-known/webfinger?resource=acct%3Ame%40localhost',
  );
});

test('whoami exits 1 with usage when agentId / server are missing', async () => {
  const prev = { agent: process.env.AGENT_ID, server: process.env.SERVER_URL };
  delete process.env.AGENT_ID;
  delete process.env.SERVER_URL;
  try {
    const io = makeIO();
    const result = await runWhoami([], io);
    assert.equal(result, 1);
    assert.match(io.readStderr(), /missing required/);
  } finally {
    if (prev.agent !== undefined) process.env.AGENT_ID = prev.agent;
    if (prev.server !== undefined) process.env.SERVER_URL = prev.server;
  }
});

test('whoami warns and exits 2 when agentId is not a Mentionable local', async () => {
  const io = makeIO();
  const result = await runWhoami(
    ['--agentId', 'bad/agent', '--server', 'wss://h.example/ws'],
    io,
  );
  assert.equal(result, 2);
  assert.match(io.readStderr(), /not a valid Mentionable local-part/);
  // Even with an invalid id, the printed URL must be valid (encoded).
  assert.match(io.readStdout(), /a2a:\s*https:\/\/h\.example\/agents\/bad%2Fagent/);
});

test('whoami --verify treats a matching JRD subject as success', async () => {
  await withWebfingerServer(
    ({ resource }, res) => {
      assert.equal(resource, 'acct:me@127.0.0.1');
      res.json({
        subject: 'acct:me@127.0.0.1',
        aliases: ['https://127.0.0.1/agents/me'],
      });
    },
    async (origin) => {
      const url = new URL(origin);
      const io = makeIO();
      const result = await runWhoami(
        ['--agentId', 'me', '--server', `ws://${url.host}/ws`, '--verify'],
        io,
      );
      assert.equal(result, 0);
      assert.match(io.readStdout(), /webfinger ok/);
    },
  );
});

test('whoami --verify treats subject as case-insensitive (matches server)', async () => {
  await withWebfingerServer(
    (_req, res) => {
      // Server may return mixed case for the local part — the bridge's
      // lookup is case-insensitive on scheme+local+domain.
      res.json({ subject: 'ACCT:Me@127.0.0.1', aliases: [] });
    },
    async (origin) => {
      const url = new URL(origin);
      const io = makeIO();
      const result = await runWhoami(
        ['--agentId', 'me', '--server', `ws://${url.host}/ws`, '--verify'],
        io,
      );
      assert.equal(result, 0);
      assert.match(io.readStdout(), /webfinger ok/);
    },
  );
});

test('whoami --verify exits 3 when the JRD subject does not match the requested acct', async () => {
  await withWebfingerServer(
    (_req, res) => {
      // Wrong subject — pretend the server pointed us at a different agent.
      res.json({ subject: 'acct:somebody-else@127.0.0.1', aliases: [] });
    },
    async (origin) => {
      const url = new URL(origin);
      const io = makeIO();
      const result = await runWhoami(
        ['--agentId', 'me', '--server', `ws://${url.host}/ws`, '--verify'],
        io,
      );
      assert.equal(result, 3);
      const stdout = io.readStdout();
      assert.match(stdout, /webfinger FAILED/);
      assert.match(stdout, /subject mismatch/);
    },
  );
});

test('whoami --verify exits 3 with HTTP <status> when WebFinger returns 404', async () => {
  await withWebfingerServer(
    (_req, res) => res.json({ error: 'not found' }, 404),
    async (origin) => {
      const url = new URL(origin);
      const io = makeIO();
      const result = await runWhoami(
        ['--agentId', 'me', '--server', `ws://${url.host}/ws`, '--verify'],
        io,
      );
      assert.equal(result, 3);
      assert.match(io.readStdout(), /webfinger FAILED:\s*HTTP 404/);
    },
  );
});
