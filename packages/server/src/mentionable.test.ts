import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCardV03 } from '@a2x/sdk';
import {
  MENTIONABLE_PROTOCOL_VERSION,
  buildAgentDirectory,
  buildMentionableCard,
  isValidMentionableLocal,
  parseAcct,
  toMode,
} from './mentionable.js';

function baseCard(overrides: Partial<AgentCardV03> = {}): AgentCardV03 {
  return {
    name: 'Test Agent',
    description: 'an agent for tests',
    version: '1.2.3',
    protocolVersion: '0.3',
    url: 'https://bridge.example.com/agents/foo',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain', 'text/markdown'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'do-thing',
        name: 'Do the thing',
        description: 'does it',
        tags: ['demo'],
      },
    ],
    ...overrides,
  } as AgentCardV03;
}

test('isValidMentionableLocal accepts safe LDH+dot+underscore', () => {
  for (const ok of ['foo', 'foo.bar', 'foo-bar', 'foo_bar', 'A1', 'agent-7']) {
    assert.equal(isValidMentionableLocal(ok), true, ok);
  }
});

test('isValidMentionableLocal rejects unsafe chars and empty / overlong', () => {
  for (const bad of [
    '',
    '.',
    '..',
    'foo@bar',
    'foo bar',
    'foo/bar',
    'foo\nbar',
    'a'.repeat(65),
  ]) {
    assert.equal(isValidMentionableLocal(bad), false, JSON.stringify(bad));
  }
});

test('parseAcct extracts local + domain, scheme is case-insensitive', () => {
  assert.deepEqual(parseAcct('acct:foo@bar.test'), { local: 'foo', domain: 'bar.test' });
  assert.deepEqual(parseAcct('ACCT:foo@bar.test'), { local: 'foo', domain: 'bar.test' });
  assert.equal(parseAcct('foo@bar.test'), null);
  assert.equal(parseAcct('acct:no-at-symbol'), null);
});

test('toMode maps the common A2A strings to Mentionable Mode objects', () => {
  assert.deepEqual(toMode('text/plain'), { kind: 'text', mime: 'text/plain' });
  assert.deepEqual(toMode('text'), { kind: 'text', mime: 'text/plain' });
  assert.deepEqual(toMode('text/markdown'), { kind: 'text', mime: 'text/markdown' });
  assert.deepEqual(toMode('text/html'), { kind: 'text', mime: 'text/html' });
  assert.deepEqual(toMode('link'), { kind: 'link' });
  assert.deepEqual(toMode('image/png'), { kind: 'file', mime: 'image/png' });
});

test('buildMentionableCard renders @<local>@<domain> address and v0.1 shape', () => {
  const card = buildMentionableCard(baseCard(), {
    local: 'foo',
    domain: 'bridge.example.com',
    baseUrl: 'https://bridge.example.com',
    publicUrl: 'https://bridge.example.com',
    deviceFlowEnabled: false,
  });
  assert.equal(card.address, '@foo@bridge.example.com');
  assert.equal(card.protocol_version, MENTIONABLE_PROTOCOL_VERSION);
  assert.equal(card.name, 'Test Agent');
  assert.equal(card.version, '1.2.3');
  assert.equal(card.a2a.endpoint, 'https://bridge.example.com/agents/foo');
  // streaming:true → SSE transport
  assert.equal(card.a2a.transport, 'https+sse');
  assert.equal(card.a2a.capabilities.streaming, true);
  assert.equal(card.a2a.capabilities.push_notifications, false);
  assert.deepEqual(card.a2a.input_modes, [
    { kind: 'text', mime: 'text/plain' },
    { kind: 'text', mime: 'text/markdown' },
  ]);
  assert.deepEqual(card.a2a.output_modes, [{ kind: 'text', mime: 'text/plain' }]);
  assert.equal(card.a2a.skills.length, 1);
  assert.equal(card.a2a.skills[0]!.id, 'do-thing');
  assert.deepEqual(card.mentionable.supported_inbound, ['a2a']);
  assert.equal(card.mentionable.homepage, 'https://bridge.example.com');
});

test('buildMentionableCard picks https+jsonrpc transport when streaming is off', () => {
  const card = buildMentionableCard(
    baseCard({ capabilities: { streaming: false, pushNotifications: false } }),
    {
      local: 'foo',
      domain: 'bridge.example.com',
      baseUrl: 'https://bridge.example.com',
      publicUrl: 'https://bridge.example.com',
      deviceFlowEnabled: false,
    },
  );
  assert.equal(card.a2a.transport, 'https+jsonrpc');
  assert.equal(card.a2a.capabilities.streaming, false);
});

test('buildMentionableCard surfaces device-flow oauth2 auth when configured', () => {
  // Mirrors the AgentCardV03 the bridge generates for a callable agent when
  // Google device-flow is mounted: an oauth2 scheme with a `deviceCode` flow.
  const card = buildMentionableCard(
    baseCard({
      securitySchemes: {
        bridge: {
          type: 'oauth2',
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: 'https://bridge.example.com/oauth/device/code',
              tokenUrl: 'https://bridge.example.com/oauth/token',
              scopes: {},
            },
          },
        },
      } as unknown as AgentCardV03['securitySchemes'],
    }),
    {
      local: 'foo',
      domain: 'bridge.example.com',
      baseUrl: 'https://bridge.example.com',
      publicUrl: 'https://bridge.example.com',
      deviceFlowEnabled: true,
    },
  );
  assert.deepEqual(card.a2a.auth, {
    scheme: 'oauth2',
    issuer: 'https://bridge.example.com',
    authorization_endpoint: 'https://bridge.example.com/oauth/device/code',
    token_endpoint: 'https://bridge.example.com/oauth/token',
    scopes: [],
  });
});

test('buildMentionableCard falls back to scheme:none when device flow is not enabled', () => {
  const card = buildMentionableCard(
    baseCard({
      // Even if the wire card carries an oauth2 scheme, deviceFlowEnabled=false
      // means this deployment does not actually mount the token endpoints —
      // advertising oauth2 would point clients at non-existent URLs.
      securitySchemes: {
        bridge: {
          type: 'oauth2',
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: 'https://bridge.example.com/oauth/device/code',
              tokenUrl: 'https://bridge.example.com/oauth/token',
              scopes: {},
            },
          },
        },
      } as unknown as AgentCardV03['securitySchemes'],
    }),
    {
      local: 'foo',
      domain: 'bridge.example.com',
      baseUrl: 'https://bridge.example.com',
      publicUrl: 'https://bridge.example.com',
      deviceFlowEnabled: false,
    },
  );
  assert.deepEqual(card.a2a.auth, { scheme: 'none' });
});

test('buildAgentDirectory emits Schema.org Organization with one ContactPoint per entry', () => {
  const dir = buildAgentDirectory({
    baseUrl: 'https://bridge.example.com',
    domain: 'bridge.example.com',
    organizationName: 'Vicoop Bridge',
    entries: [
      { local: 'foo', name: 'Foo Agent', description: 'foo desc' },
      { local: 'bar', name: 'Bar Agent' },
    ],
  });
  assert.equal(dir['@context'], 'https://schema.org');
  assert.equal(dir['@type'], 'Organization');
  assert.equal(dir.name, 'Vicoop Bridge');
  assert.equal(dir.contactPoint.length, 2);
  const [foo, bar] = dir.contactPoint;
  assert.equal(foo!.email, 'foo@bridge.example.com');
  assert.equal(foo!.url, 'https://bridge.example.com/.well-known/agent-card/foo');
  assert.equal(foo!.description, 'foo desc');
  assert.deepEqual(foo!['https://mentionable.dev/ns/v1#protocols'], ['a2a']);
  assert.equal(
    foo!['https://mentionable.dev/ns/v1#webfinger'],
    'https://bridge.example.com/.well-known/webfinger?resource=acct:foo@bridge.example.com',
  );
  // Optional `description` is omitted when not provided rather than serialized
  // as `description: undefined`.
  assert.equal('description' in bar!, false);
});
