import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AgentCardV03 } from '@a2x/sdk';
import type { ClientConnection } from './registry.js';
import { mountWellKnown, type WellKnownDeps } from './well-known.js';

function fakeConn(agentId: string, card: Partial<AgentCardV03> = {}): ClientConnection {
  return {
    agentId,
    clientId: `c-${agentId}`,
    ownerPrincipal: 'eth:0x0',
    agentCard: {
      name: card.name ?? `Agent ${agentId}`,
      description: card.description ?? `desc ${agentId}`,
      version: card.version ?? '0.0.1',
      protocolVersion: '0.3.0',
      capabilities: { streaming: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    },
    allowedCallers: [],
    // Registry only ever calls .close() / equality on this; the well-known
    // routes don't touch ws at all.
    ws: { close: () => undefined } as unknown as ClientConnection['ws'],
    connectedAt: 0,
  };
}

function fakeCardV03(agentId: string, overrides: Partial<AgentCardV03> = {}): AgentCardV03 {
  return {
    name: `Agent ${agentId}`,
    description: `desc ${agentId}`,
    version: '0.0.1',
    protocolVersion: '0.3',
    url: `https://bridge.example.com/agents/${agentId}`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
    ...overrides,
  } as AgentCardV03;
}

function fakeAdminCard(): AgentCardV03 {
  return {
    name: 'Vicoop Bridge Server Admin',
    description: 'Bridge admin agent',
    version: '0.1.0',
    protocolVersion: '0.3',
    url: 'https://bridge.example.com/',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 'client-management', name: 'Client Management', description: 'admin tools' },
    ],
  } as AgentCardV03;
}

function makeApp(opts: {
  agents: ClientConnection[];
  // When omitted, defaults to a typical deploy with publicUrl / domain set.
  // Pass `noPublicUrl: true` to simulate a bridge with no PUBLIC_URL config.
  noPublicUrl?: boolean;
  // Override the publicUrl/domain pair to test ineligible deployments
  // (http://, single-label hostnames). Both must be set together.
  publicUrl?: string;
  domain?: string;
  deviceFlowEnabled?: boolean;
}) {
  const app = new Hono();
  const deps: WellKnownDeps = {
    listAgents: () => opts.agents,
    getAgentCard: (conn) => fakeCardV03(conn.agentId),
    adminCard: fakeAdminCard(),
    publicUrl: opts.noPublicUrl
      ? undefined
      : (opts.publicUrl ?? 'https://bridge.example.com'),
    domain: opts.noPublicUrl
      ? undefined
      : (opts.domain ?? 'bridge.example.com'),
    deviceFlowEnabled: opts.deviceFlowEnabled ?? false,
    organizationName: 'Vicoop Bridge',
  };
  mountWellKnown(app, deps);
  return app;
}

test('webfinger: 400 when resource is missing', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request('/.well-known/webfinger');
  assert.equal(res.status, 400);
});

test('every well-known response (200, 400, 404) carries Cache-Control: no-store', async () => {
  // The data tracks live WS connections, so a 404 for an offline agent
  // must NOT be cached — when the agent reconnects, an intermediate
  // shared cache holding the old 404 would keep advertising it as
  // unreachable. Same logic for the success paths.
  const app = makeApp({ agents: [fakeConn('foo')] });
  const cases = [
    // success
    '/.well-known/webfinger?resource=acct:foo@bridge.example.com',
    '/.well-known/agent-card/foo',
    '/.well-known/mentionable-agents.json',
    // 400
    '/.well-known/webfinger',
    // 404 — unknown local-part
    '/.well-known/webfinger?resource=acct:nope@bridge.example.com',
    '/.well-known/agent-card/nope',
  ];
  for (const path of cases) {
    const res = await app.request(path);
    assert.equal(
      res.headers.get('cache-control'),
      'no-store',
      `${path} → status=${res.status} cache-control="${res.headers.get('cache-control')}"`,
    );
  }
});

test('webfinger: returns JRD with the agent-card rel for a connected agent', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:foo@bridge.example.com',
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/jrd\+json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.subject, 'acct:foo@bridge.example.com');
  const links = body.links as Array<Record<string, string>>;
  assert.ok(
    links.some(
      (l) =>
        l.rel === 'https://mentionable.dev/agent-card' &&
        l.href === 'https://bridge.example.com/.well-known/agent-card/foo',
    ),
    `agent-card rel missing: ${JSON.stringify(links)}`,
  );
  // SHOULD include a profile-page rel per Mentionable §3.
  assert.ok(
    links.some((l) => l.rel === 'http://webfinger.net/rel/profile-page'),
  );
});

test('webfinger: matches case-insensitively on scheme + domain + local', async () => {
  // RFC 3986 §3.1 (scheme), RFC 1035 §2.3.3 (domain), RFC 5321 §2.4 (local
  // SHOULD be treated case-insensitively in practice).
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=ACCT:FOO@BRIDGE.EXAMPLE.COM',
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  // Subject is rendered with the live agentId (preserves its actual case)
  // and a lowercased domain.
  assert.equal(body.subject, 'acct:foo@bridge.example.com');
});

test('webfinger: 404 on unknown local-part', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:bar@bridge.example.com',
  );
  assert.equal(res.status, 404);
});

test('webfinger: 404 on foreign domain', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:foo@other.example',
  );
  assert.equal(res.status, 404);
});

test('webfinger: 404 on malformed resource (no acct: scheme)', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=foo@bridge.example.com',
  );
  assert.equal(res.status, 404);
});

test('webfinger: 404 when two registry entries differ only in case (ambiguous)', async () => {
  // Mentionable lookups are case-insensitive but the registry is
  // case-sensitive, so `Foo` and `foo` could both register concurrently.
  // The lookup MUST refuse to pick — silently routing a mention to
  // whichever connected first would be misdelivery.
  const app = makeApp({ agents: [fakeConn('Foo'), fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:foo@bridge.example.com',
  );
  assert.equal(res.status, 404);
});

test('agent-card: 404 when two registry entries differ only in case (ambiguous)', async () => {
  const app = makeApp({ agents: [fakeConn('Foo'), fakeConn('foo')] });
  const res = await app.request('/.well-known/agent-card/foo');
  assert.equal(res.status, 404);
});

test('mentionable-agents.json: drops case-insensitive collisions to match resolveLocal', async () => {
  // listDirectoryEntries must mirror resolveLocal's ambiguous-→-404 rule;
  // otherwise the directory advertises addresses that immediately fail to
  // resolve. The unambiguous `bar` survives; admin is always present.
  const app = makeApp({ agents: [fakeConn('Foo'), fakeConn('foo'), fakeConn('bar')] });
  const res = await app.request('/.well-known/mentionable-agents.json');
  const body = (await res.json()) as { contactPoint: Array<{ email: string }> };
  const emails = body.contactPoint.map((p) => p.email);
  assert.deepEqual(emails, ['admin@bridge.example.com', 'bar@bridge.example.com']);
});

test('webfinger: 404 when local-part contains unsafe chars (path separator)', async () => {
  // Defends against an attacker crafting an agentId that smuggles `..` /
  // `@` / CRLF into the JRD subject. isValidMentionableLocal rejects them
  // at the layer that builds the URL, so the well-known routes never see
  // them — and a query asking for one resolves to 404 too.
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:..%2Fevil@bridge.example.com',
  );
  assert.equal(res.status, 404);
});

test('webfinger: 404 when bridge has no PUBLIC_URL configured (no domain)', async () => {
  const app = makeApp({ agents: [fakeConn('foo')], noPublicUrl: true });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:foo@bridge.example.com',
  );
  assert.equal(res.status, 404);
});

test('agent-card: returns Mentionable v0.1 shape for a connected local', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request('/.well-known/agent-card/foo');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.address, '@foo@bridge.example.com');
  assert.equal(body.protocol_version, '0.1');
  const a2a = body.a2a as Record<string, unknown>;
  assert.equal(a2a.endpoint, 'https://bridge.example.com/agents/foo');
});

test('agent-card: matches local-part case-insensitively (parity with WebFinger)', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request('/.well-known/agent-card/FOO');
  assert.equal(res.status, 200);
});

test('agent-card: 404 for an unknown local', async () => {
  const app = makeApp({ agents: [fakeConn('foo')] });
  const res = await app.request('/.well-known/agent-card/bar');
  assert.equal(res.status, 404);
});

test('mentionable-agents.json: lists admin first, then every safe-local-part client', async () => {
  // The third agent has `bad@id` which fails isValidMentionableLocal and
  // must be silently dropped so we never render an `acct:bad@id@host` URI.
  // Admin is always advertised — it's the bridge itself.
  const app = makeApp({
    agents: [fakeConn('foo'), fakeConn('bar'), fakeConn('bad@id')],
  });
  const res = await app.request('/.well-known/mentionable-agents.json');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    '@type': string;
    contactPoint: Array<{ email: string }>;
  };
  assert.equal(body['@type'], 'Organization');
  const emails = body.contactPoint.map((p) => p.email);
  // Admin first by convention; client order follows registry insertion.
  assert.deepEqual(emails, [
    'admin@bridge.example.com',
    'foo@bridge.example.com',
    'bar@bridge.example.com',
  ]);
});

test('mentionable-agents.json: contains only admin when no clients connected', async () => {
  // The bridge itself is always addressable — directory is never empty
  // on a configured deployment.
  const app = makeApp({ agents: [] });
  const res = await app.request('/.well-known/mentionable-agents.json');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { contactPoint: Array<{ email: string }> };
  assert.equal(body.contactPoint.length, 1);
  assert.equal(body.contactPoint[0]!.email, 'admin@bridge.example.com');
});

test('webfinger: resolves admin even when no clients are connected', async () => {
  const app = makeApp({ agents: [] });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:admin@bridge.example.com',
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { subject: string; aliases: string[] };
  assert.equal(body.subject, 'acct:admin@bridge.example.com');
  // Admin lives at the bridge root, NOT under /agents/admin.
  assert.deepEqual(body.aliases, ['https://bridge.example.com/']);
});

test('agent-card: returns admin Mentionable card with admin endpoint at root', async () => {
  const app = makeApp({ agents: [] });
  const res = await app.request('/.well-known/agent-card/admin');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    address: string;
    a2a: { endpoint: string };
  };
  assert.equal(body.address, '@admin@bridge.example.com');
  assert.equal(body.a2a.endpoint, 'https://bridge.example.com/');
});

test('agent-card: matches admin local-part case-insensitively', async () => {
  const app = makeApp({ agents: [] });
  const res = await app.request('/.well-known/agent-card/ADMIN');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { address: string };
  // Canonical local-part is rendered in lowercase regardless of input case.
  assert.equal(body.address, '@admin@bridge.example.com');
});

test('mentionable-agents.json: 404 when bridge has no PUBLIC_URL configured', async () => {
  const app = makeApp({ agents: [fakeConn('foo')], noPublicUrl: true });
  const res = await app.request('/.well-known/mentionable-agents.json');
  assert.equal(res.status, 404);
});

test('all routes 404 when PUBLIC_URL is http:// (Mentionable §2 requires HTTPS)', async () => {
  // A bridge deployed at http://bridge.example.com would publish self-
  // referential http:// URLs in the JRD/agent-card/directory, which no
  // conformant resolver will accept. Refuse to serve at all rather than
  // ship spec-non-conformant payloads.
  const app = makeApp({
    agents: [fakeConn('foo')],
    publicUrl: 'http://bridge.example.com',
    domain: 'bridge.example.com',
  });
  for (const path of [
    '/.well-known/webfinger?resource=acct:foo@bridge.example.com',
    '/.well-known/agent-card/foo',
    '/.well-known/mentionable-agents.json',
  ]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
  }
});

test('all routes 404 when domain is single-label (Mentionable §1 rejects bare localhost)', async () => {
  // The spec validation ladder makes a bare `localhost` unverifiable in
  // the subject step, so a deployment at https://localhost:8787 cannot
  // serve a conformant Mentionable surface. Local dev should use a
  // reserved-TLD subdomain (https://agent.localhost / https://agent.test)
  // — those have a dot and pass.
  const app = makeApp({
    agents: [fakeConn('foo')],
    publicUrl: 'https://localhost:8787',
    domain: 'localhost',
  });
  for (const path of [
    '/.well-known/webfinger?resource=acct:foo@localhost',
    '/.well-known/agent-card/foo',
    '/.well-known/mentionable-agents.json',
  ]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
  }
});

test('all routes serve when PUBLIC_URL is https with a multi-label hostname', async () => {
  // Sanity check the positive path: agent.localhost (RFC 6761 reserved
  // TLD subdomain) is the canonical local-dev form per Mentionable §1
  // and passes the multi-label check.
  const app = makeApp({
    agents: [fakeConn('foo')],
    publicUrl: 'https://agent.localhost',
    domain: 'agent.localhost',
  });
  const res = await app.request(
    '/.well-known/webfinger?resource=acct:foo@agent.localhost',
  );
  assert.equal(res.status, 200);
});
