import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Sql } from '../../db.js';
import { formatFederatedPrincipal } from '../../auth/principal.js';
import type { DidDocumentResolver, ResolvedDidDocument } from '../../identity-vc/types.js';
import {
  OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER,
  OAUTH_FEDERATION_CLAIM_METHOD,
  OAUTH_FEDERATION_CLAIM_TASK_ID,
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  OAUTH_FEDERATION_SCOPE_TASK_READ,
  OAUTH_FEDERATION_TYP_CLIENT_ASSERTION,
  OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
  OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
  OAUTH_TOKEN_TYPE_JWT,
} from '../profiles/mentionable-v0.1.js';
import { createMentionableOAuthProfile } from '../profiles/mentionable-v0.1.js';
import { mountTokenExchangeRoutes, type TokenExchangeRouteOptions } from './routes.js';
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_EXCHANGE_MAX_FORM_BYTES,
  type TokenExchangeProfile,
} from './types.js';

const publicUrl = 'https://bridge.example';
const tokenEndpoint = `${publicUrl}/oauth/token`;
const issuer = 'did:web:connector.example';
const kid = `${issuer}#key-1`;
const method = 'urn:mentionable:auth:slack-member:v0.1';
const subject = 'slack:T123/U456';
const now = () => new Date('2026-08-31T00:00:00.000Z');

function mountMentionableTokenExchangeRoutes(
  app: Hono,
  options: Omit<TokenExchangeRouteOptions, 'profiles'> & {
    resolver: DidDocumentResolver;
  },
): void {
  const { resolver, ...routeOptions } = options;
  mountTokenExchangeRoutes(app, {
    ...routeOptions,
    profiles: [createMentionableOAuthProfile({ resolver })],
  });
}

async function assertions() {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const publicKeyJwk = await exportJWK(publicKey);
  const issuedAt = Math.floor(now().getTime() / 1000);
  const base = (typ: string, sub: string, jti: string, claims: Record<string, unknown> = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ, kid })
      .setIssuer(issuer)
      .setSubject(sub)
      .setAudience(tokenEndpoint)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .setJti(jti)
      .sign(privateKey);
  const didDocument: ResolvedDidDocument = {
    id: issuer,
    verificationMethod: [{ id: kid, controller: issuer, publicKeyJwk }],
    assertionMethod: [kid],
  };
  return {
    clientAssertion: await base(OAUTH_FEDERATION_TYP_CLIENT_ASSERTION, issuer, 'client-jti'),
    subjectAssertion: await base(OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION, subject, 'subject-jti', {
      [OAUTH_FEDERATION_CLAIM_METHOD]: method,
    }),
    continuationAssertion: await base(
      OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
      subject,
      'continuation-jti',
      { [OAUTH_FEDERATION_CLAIM_TASK_ID]: 'task-1' },
    ),
    didDocument,
  };
}

function requestBody(subjectAssertion: string, clientAssertion: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
    subject_token: subjectAssertion,
    subject_token_type: OAUTH_TOKEN_TYPE_JWT,
    requested_token_type: OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
    client_id: issuer,
    client_assertion_type: OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER,
    client_assertion: clientAssertion,
    resource: `${publicUrl}/agents/agent-1`,
    scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  });
}

function sqlWithPolicy(
  allowedCallers: string[],
  inserted: string[] = [],
  tokenRows: unknown[][] = [],
  task?: { principalId: string; actorId: string; authorizationKey: string },
): Sql {
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?');
    if (statement.includes('SELECT allowed_callers FROM agents')) {
      return [{ allowed_callers: allowedCallers }];
    }
    if (statement.includes('INSERT INTO infra.oauth_token_exchange_replays')) {
      return [{ digest: values[0] }];
    }
    if (statement.includes('INSERT INTO infra.oauth_token_exchange_access_tokens')) {
      tokenRows.push(values);
      inserted.push(
        String(values.find((value) => typeof value === 'string' && value.startsWith('{'))),
      );
      return [{ id: 'token-row-1' }];
    }
    if (statement.includes('FROM infra.a2a_tasks')) {
      return task
        ? [
            {
            owner_principal: task.principalId,
            owner_actor: task.actorId,
            authorization_profile: 'https://mentionable.dev/ns/oauth-federation/v0.1',
            authorization_key: task.authorizationKey,
            },
          ]
        : [];
    }
    throw new Error(`unexpected SQL in test: ${statement}`);
  }) as unknown as Sql;
  (query as Sql & { begin: Sql['begin'] }).begin = (async (callback: (tx: Sql) => unknown) =>
    callback(query)) as unknown as Sql['begin'];
  return query;
}

test('RFC 8414 discovery points token exchange at the shared /oauth/token endpoint', async () => {
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([]),
    publicUrl,
    resolver: {
      async resolve() {
        throw new Error('not reached');
      },
    },
    now,
    additionalGrantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    additionalTokenEndpointAuthMethods: ['none'],
    deviceAuthorizationEndpoint: `${publicUrl}/oauth/device/code`,
  });
  const response = await app.request('/.well-known/oauth-authorization-server');
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as {
    token_endpoint: string;
    grant_types_supported: string[];
    token_endpoint_auth_methods_supported: string[];
    token_exchange_profiles_supported: string[];
  };
  assert.equal(metadata.token_endpoint, tokenEndpoint);
  assert.deepEqual(metadata.grant_types_supported, [
    OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
    'urn:ietf:params:oauth:grant-type:device_code',
  ]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['private_key_jwt', 'none']);
  assert.equal(
    (metadata as { device_authorization_endpoint?: string }).device_authorization_endpoint,
    `${publicUrl}/oauth/device/code`,
  );
  assert.deepEqual(metadata.token_exchange_profiles_supported, [
    'https://mentionable.dev/ns/oauth-federation/v0.1',
  ]);
});

test('the RFC 8693 core issues a token for a non-Mentionable profile adapter', async () => {
  const profile: TokenExchangeProfile = {
    id: 'urn:example:oauth-profile:v1',
    replayProtection: 'required',
    clientAuthMethods: ['client_secret_basic'],
    clientAuthSigningAlgorithms: [],
    scopes: ['example:read'],
    subjectTokenTypes: ['urn:example:token-type'],
    recognizes: () => true,
    async verify() {
      return {
        ok: true,
        principalId: 'example:user-1',
        actorId: 'example:client-1',
        authorizationKey: 'example:allowed-caller',
        scopes: ['example:read'],
        replays: [
          {
            issuer: 'example:issuer',
            jti: 'example-jti',
            expiresAt: new Date(now().getTime() + 300_000),
          },
        ],
        kind: 'example',
      };
    },
  };
  const app = new Hono();
  const tokenRows: unknown[][] = [];
  mountTokenExchangeRoutes(app, {
    sql: sqlWithPolicy(['example:allowed-caller'], [], tokenRows),
    publicUrl,
    profiles: [profile],
    now,
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      resource: `${publicUrl}/agents/agent-1`,
      subject_token: 'profile-owned-format',
      scope: 'example:read',
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    access_token: string;
    scope: string;
  };
  assert.match(body.access_token, /^vbc_oauth_/);
  assert.equal(body.scope, 'example:read');
  assert.equal(tokenRows[0]?.[1], profile.id);
});

test('a replay-required profile cannot issue a token without replay evidence', async () => {
  const tokenRows: unknown[][] = [];
  const profile: TokenExchangeProfile = {
    id: 'urn:example:replay-required',
    replayProtection: 'required',
    clientAuthMethods: [],
    clientAuthSigningAlgorithms: [],
    scopes: ['example:read'],
    subjectTokenTypes: ['urn:example:token-type'],
    recognizes: () => true,
    async verify() {
      return {
        ok: true,
        principalId: 'example:user-1',
        actorId: 'example:client-1',
        authorizationKey: 'example:allowed-caller',
        scopes: ['example:read'],
        replays: [],
        kind: 'broken-example',
      };
    },
  };
  const app = new Hono();
  mountTokenExchangeRoutes(app, {
    sql: sqlWithPolicy(['example:allowed-caller'], [], tokenRows),
    publicUrl,
    profiles: [profile],
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      resource: `${publicUrl}/agents/agent-1`,
    }),
  });
  const body = (await response.json()) as { error: string; rejection_id?: string };
  assert.equal(response.status, 500);
  assert.equal(body.error, 'server_error');
  assert.match(body.rejection_id!, /^rej_/);
  assert.equal(tokenRows.length, 0);
});

test('a profile can explicitly declare replay protection not applicable', async () => {
  const tokenRows: unknown[][] = [];
  const profile: TokenExchangeProfile = {
    id: 'urn:example:non-replayable-credentials',
    replayProtection: 'not-applicable',
    clientAuthMethods: [],
    clientAuthSigningAlgorithms: [],
    scopes: ['example:read'],
    subjectTokenTypes: ['urn:example:opaque-token'],
    recognizes: () => true,
    async verify() {
      return {
        ok: true,
        principalId: 'example:user-1',
        actorId: 'example:client-1',
        authorizationKey: 'example:allowed-caller',
        scopes: ['example:read'],
        replays: [],
        kind: 'non-replayable-example',
      };
    },
  };
  const app = new Hono();
  mountTokenExchangeRoutes(app, {
    sql: sqlWithPolicy(['example:allowed-caller'], [], tokenRows),
    publicUrl,
    profiles: [profile],
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      resource: `${publicUrl}/agents/agent-1`,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(tokenRows.length, 1);
});

test('the shared token route passes non-exchange grants to device flow', async () => {
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([]),
    publicUrl,
    resolver: {
      async resolve() {
        throw new Error('not reached');
      },
    },
    passThroughOtherGrants: true,
  });
  app.post('/oauth/token', (c) => c.json({ handled: 'device-flow' }));
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-code',
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { handled: 'device-flow' });
});

test('token exchange checks exact receiver policy before resolving an untrusted DID', async () => {
  const fixture = await assertions();
  let resolutions = 0;
  const resolver: DidDocumentResolver = {
    async resolve() {
      resolutions += 1;
      return fixture.didDocument;
    },
  };
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([]),
    publicUrl,
    resolver,
    now,
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestBody(fixture.subjectAssertion, fixture.clientAssertion),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, 'invalid_grant');
  assert.equal(resolutions, 0);
});

test('successful exchange stores only a normalized, non-secret attestation', async () => {
  const fixture = await assertions();
  const authorizationKey = formatFederatedPrincipal({
    issuer,
    method,
    subject,
  });
  assert.ok(authorizationKey);
  const inserted: string[] = [];
  const tokenRows: unknown[][] = [];
  const resolver: DidDocumentResolver = {
    async resolve() {
      return fixture.didDocument;
    },
  };
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([authorizationKey], inserted, tokenRows),
    publicUrl,
    resolver,
    now,
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestBody(fixture.subjectAssertion, fixture.clientAssertion),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  assert.match(body.access_token, /^vbc_oauth_/);
  assert.equal(body.expires_in, 300);
  assert.equal(inserted.length, 1);
  assert.equal(tokenRows[0]?.[3], subject, 'effective principal is the platform subject');
  assert.equal(tokenRows[0]?.[4], issuer, 'actor is the authenticated Connector DID');
  assert.equal(tokenRows[0]?.[5], authorizationKey, 'policy binding retains the exact tuple');
  const attestation = JSON.parse(inserted[0]!) as Record<string, string>;
  assert.deepEqual(
    {
      issuer: attestation.issuer,
      subject: attestation.subject,
      method: attestation.method,
    },
    { issuer, subject, method },
  );
  assert.match(attestation.credentialId!, /^urn:mentionable:oauth-assertion:/);
  assert.equal(inserted[0]!.includes(fixture.subjectAssertion), false);
  assert.equal(inserted[0]!.includes(fixture.clientAssertion), false);
});

test('client assertion verification failures map to invalid_client', async () => {
  const fixture = await assertions();
  const authorizationKey = formatFederatedPrincipal({
    issuer,
    method,
    subject,
  });
  assert.ok(authorizationKey);
  const segments = fixture.clientAssertion.split('.');
  segments[2] = (segments[2]!.startsWith('A') ? 'B' : 'A') + segments[2]!.slice(1);
  const tamperedClient = segments.join('.');
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([authorizationKey]),
    publicUrl,
    resolver: {
      async resolve() {
        return fixture.didDocument;
      },
    },
    now,
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestBody(fixture.subjectAssertion, tamperedClient),
  });
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { error: string }).error, 'invalid_client');
});

test('task continuation exchange keeps the originating tuple and task binding', async () => {
  const fixture = await assertions();
  const authorizationKey = formatFederatedPrincipal({
    issuer,
    method,
    subject,
  });
  assert.ok(authorizationKey);
  const tokenRows: unknown[][] = [];
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([authorizationKey], [], tokenRows, {
      principalId: subject,
      actorId: issuer,
      authorizationKey,
    }),
    publicUrl,
    resolver: {
      async resolve() {
        return fixture.didDocument;
      },
    },
    now,
  });
  const body = requestBody(fixture.continuationAssertion, fixture.clientAssertion);
  body.set('scope', `${OAUTH_FEDERATION_SCOPE_TASK_READ} ${OAUTH_FEDERATION_SCOPE_TASK_CANCEL}`);
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(tokenRows[0]?.[3], subject);
  assert.equal(tokenRows[0]?.[4], issuer);
  assert.equal(tokenRows[0]?.[5], authorizationKey);
  assert.equal(tokenRows[0]?.[8], 'task-1');
});

test('chunked token requests are rejected while streaming once they cross the size limit', async () => {
  const app = new Hono();
  mountMentionableTokenExchangeRoutes(app, {
    sql: sqlWithPolicy([]),
    publicUrl,
    resolver: { async resolve() { throw new Error('not reached'); } },
  });
  const prefix = new TextEncoder().encode(`grant_type=${encodeURIComponent(TOKEN_EXCHANGE_GRANT_TYPE)}&`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      controller.enqueue(new Uint8Array(TOKEN_EXCHANGE_MAX_FORM_BYTES));
      controller.close();
    },
  });
  const request = new Request(`${publicUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assert.equal(request.headers.has('Content-Length'), false);
  const response = await app.request(request);
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, 'invalid_request');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('target lookup failures return an audited OAuth server_error response', async () => {
  const sql = (async () => { throw new Error('database unavailable'); }) as unknown as Sql;
  const profile: TokenExchangeProfile = {
    id: 'urn:example:lookup-profile',
    replayProtection: 'required',
    clientAuthMethods: [],
    clientAuthSigningAlgorithms: [],
    scopes: [],
    subjectTokenTypes: [],
    recognizes: () => true,
    async verify() { throw new Error('not reached'); },
  };
  const app = new Hono();
  mountTokenExchangeRoutes(app, {
    sql,
    publicUrl,
    profiles: [profile],
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      resource: `${publicUrl}/agents/agent-1`,
    }),
  });
  const body = (await response.json()) as { error: string; rejection_id?: string };
  assert.equal(response.status, 500);
  assert.equal(body.error, 'server_error');
  assert.match(body.rejection_id!, /^rej_/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('unexpected profile failures return an audited OAuth server_error response', async () => {
  const profile: TokenExchangeProfile = {
    id: 'urn:example:throwing-profile',
    replayProtection: 'required',
    clientAuthMethods: [],
    clientAuthSigningAlgorithms: [],
    scopes: [],
    subjectTokenTypes: [],
    recognizes: () => true,
    async verify() { throw new Error('adapter failure'); },
  };
  const app = new Hono();
  mountTokenExchangeRoutes(app, {
    sql: sqlWithPolicy(['allowed']),
    publicUrl,
    profiles: [profile],
  });
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      resource: `${publicUrl}/agents/agent-1`,
    }),
  });
  const body = (await response.json()) as { error: string; rejection_id?: string };
  assert.equal(response.status, 500);
  assert.equal(body.error, 'server_error');
  assert.match(body.rejection_id!, /^rej_/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
