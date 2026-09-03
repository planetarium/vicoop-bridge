import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';
import { Hono } from 'hono';
import {
  createInMemoryAssertionReplayCache,
  verifyOAuthFederationAssertion,
  verifyTokenExchange,
  type IssuerDidDocument,
} from '@mentionable/connector-kit/signing';
import type { Sql } from '../../db.js';
import { formatFederatedPrincipal } from '../../auth/principal.js';
import { mountTokenExchangeRoutes } from '../token-exchange/routes.js';
import {
  createMentionableOAuthProfile,
  MENTIONABLE_OAUTH_PROFILE_ID,
  OAUTH_FEDERATION_TYP_CLIENT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
} from './mentionable-v0.1.js';

const fixtureRoot = fileURLToPath(
  new URL('../../../../../vendor/mentionable-connector-kit/fixtures/', import.meta.url),
);

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${fixtureRoot}/${path}`, 'utf8')) as Record<string, any>;
}

function paramsFromFixture(values: Record<string, string | string[]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  }
  return params;
}

test('Mentionable profile keeps the connector-kit v0.1 conformance manifest green', async () => {
  const manifest = (await json('manifest.json')) as unknown as Array<{
    file: string;
    kind: 'assertion' | 'exchange-request' | 'replay';
    expect: 'accept' | 'reject';
    reason?: string;
  }>;
  const issuerDocument = (await json('issuer/did.json')) as IssuerDidDocument;
  const trustedIssuers = new Set([issuerDocument.id]);
  const resolveIssuerDocument = (issuer: string) =>
    issuer === issuerDocument.id ? issuerDocument : undefined;

  for (const entry of manifest) {
    const fixture = await json(entry.file);
    if (entry.kind === 'assertion') {
      const fixtureIssuerDocument = (fixture.issuerDocument ?? issuerDocument) as IssuerDidDocument;
      const outcome = await verifyOAuthFederationAssertion(fixture.jwt, fixture.verification, {
        trustedIssuers: new Set([fixtureIssuerDocument.id]),
        resolveIssuerDocument: (issuer) =>
          issuer === fixtureIssuerDocument.id ? fixtureIssuerDocument : undefined,
      });
      assert.equal(outcome.ok, entry.expect === 'accept', entry.file);
      if (!outcome.ok) assert.equal(outcome.reason, entry.reason, entry.file);
      continue;
    }
    if (entry.kind === 'exchange-request') {
      const outcome = await verifyTokenExchange(paramsFromFixture(fixture.params), {
        tokenEndpoint: fixture.evaluation.tokenEndpoint,
        verifiedAt: fixture.evaluation.verifiedAt,
        expectedResource: fixture.evaluation.expectedResource,
        trustedIssuers,
        resolveIssuerDocument,
        authorizeCandidateBeforeFetch: () => true,
        replayCache: createInMemoryAssertionReplayCache(),
      });
      assert.equal(outcome.ok, entry.expect === 'accept', entry.file);
      if (!outcome.ok) assert.equal(outcome.reason, entry.reason, entry.file);
      continue;
    }

    const replayCache = createInMemoryAssertionReplayCache();
    const first = await verifyOAuthFederationAssertion(fixture.jwt, fixture.verification, {
      trustedIssuers,
      resolveIssuerDocument,
      replayCache,
    });
    const second = await verifyOAuthFederationAssertion(fixture.jwt, fixture.verification, {
      trustedIssuers,
      resolveIssuerDocument,
      replayCache,
    });
    assert.equal(first.ok, true, `${entry.file} first presentation`);
    assert.equal(second.ok, false, `${entry.file} second presentation`);
    if (!second.ok) assert.equal(second.reason, 'replayed-jti', entry.file);
    assert.deepEqual(
      { issuer: decodeJwt(fixture.jwt).iss, jti: decodeJwt(fixture.jwt).jti },
      fixture.tuple,
      entry.file,
    );
  }
});

test('bridge STS route accepts and rejects the connector-kit exchange fixtures', async () => {
  const manifest = (await json('manifest.json')) as unknown as Array<{
    file: string;
    kind: 'assertion' | 'exchange-request' | 'replay';
    expect: 'accept' | 'reject';
    reason?: string;
  }>;
  const issuerDocument = (await json('issuer/did.json')) as unknown as IssuerDidDocument;
  const issuer = issuerDocument.id;
  const subject = 'slack:T0123456/U0456789';
  const method = 'urn:mentionable:auth:slack-workspace-member:v0.1';
  const authorizationKey = formatFederatedPrincipal({
    issuer,
    subject,
    method,
  });
  assert.ok(authorizationKey);
  const publicUrl = 'https://sts.oauth-fixtures.mentionable.dev';
  const resource = `${publicUrl}/agents/fixture-agent`;
  const expectedErrors: Record<string, string> = {
    'issuer-client-mismatch': 'invalid_request',
    'undecodable-subject-token': 'invalid_request',
    'resource-substitution': 'invalid_target',
    'duplicate-parameter': 'invalid_request',
    'message-scope-requires-subject-assertion': 'invalid_request',
    'missing-scope': 'invalid_scope',
    'missing-requested-token-type': 'invalid_request',
    'unsupported-requested-token-type': 'invalid_request',
    'unknown-scope': 'invalid_scope',
  };

  for (const entry of manifest.filter((candidate) => candidate.kind === 'exchange-request')) {
    const fixture = (await json(entry.file)) as {
      params: Record<string, string | string[]>;
      evaluation: { expectedResource: string; verifiedAt: string };
    };
    const params = paramsFromFixture(fixture.params);
    const resources = params.getAll('resource');
    if (resources.length > 0) {
      params.delete('resource');
      for (const value of resources) {
        params.append('resource', value === fixture.evaluation.expectedResource ? resource : value);
      }
    }
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join('?');
      if (statement.includes('SELECT allowed_callers FROM agents')) {
        return [{ allowed_callers: [authorizationKey] }];
      }
      if (statement.includes('FROM infra.a2a_tasks')) {
        return [
          {
            owner_principal: subject,
            owner_actor: issuer,
            authorization_profile: MENTIONABLE_OAUTH_PROFILE_ID,
            authorization_key: authorizationKey,
          },
        ];
      }
      if (statement.includes('INSERT INTO infra.oauth_token_exchange_replays')) {
        return [{ digest: 'fixture-replay' }];
      }
      if (statement.includes('INSERT INTO infra.oauth_token_exchange_access_tokens')) {
        return [{ id: 'fixture-token' }];
      }
      throw new Error(`unexpected SQL in conformance route test: ${statement}`);
    }) as unknown as Sql;
    sql.begin = (async (callback: (tx: Sql) => unknown) =>
      callback(sql)) as unknown as Sql['begin'];
    sql.json = ((value: unknown) => value) as Sql['json'];
    const app = new Hono();
    mountTokenExchangeRoutes(app, {
      sql,
      publicUrl,
      profiles: [
        {
          ...createMentionableOAuthProfile({
            resolver: {
              async resolve() {
                return issuerDocument as never;
              },
            },
          }),
        },
      ],
      now: () => new Date(fixture.evaluation.verifiedAt),
    });
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    assert.equal(response.ok, entry.expect === 'accept', entry.file);
    if (!response.ok) {
      const body = (await response.json()) as {
        error: string;
        rejection_id?: string;
      };
      assert.equal(body.error, expectedErrors[entry.reason!], entry.file);
      assert.match(body.rejection_id!, /^rej_/, entry.file);
    }
  }
});

test('every assertion fixture also reaches the bridge STS route', async () => {
  const manifest = (await json('manifest.json')) as unknown as Array<{
    file: string;
    kind: 'assertion' | 'exchange-request' | 'replay';
    expect: 'accept' | 'reject';
    reason?: string;
  }>;
  const defaultIssuerDocument = (await json('issuer/did.json')) as unknown as IssuerDidDocument;
  const issuer = defaultIssuerDocument.id;
  const subject = 'slack:T0123456/U0456789';
  const method = 'urn:mentionable:auth:slack-workspace-member:v0.1';
  const authorizationKey = formatFederatedPrincipal({
    issuer,
    subject,
    method,
  });
  assert.ok(authorizationKey);
  const publicUrl = 'https://sts.oauth-fixtures.mentionable.dev';
  const resource = `${publicUrl}/agents/fixture-agent`;
  const invalidClientFixtures = new Set([
    'invalid/kid-not-issuer-fragment.json',
    'invalid/kid-invalid-fragment-syntax.json',
    'invalid/vm-controller-mismatch.json',
    'invalid/vm-wrong-type.json',
    'invalid/vm-invalid-public-jwk.json',
    'invalid/vm-private-jwk.json',
    'invalid/vm-mixed-key-material.json',
  ]);

  for (const entry of manifest.filter((candidate) => candidate.kind === 'assertion')) {
    const fixture = (await json(entry.file)) as {
      jwt: string;
      verification: { typ: string; verifiedAt: string };
      issuerDocument?: IssuerDidDocument;
    };
    const continuation =
      fixture.verification.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION;
    const base = (await json(
      continuation
        ? 'valid/exchange-request-task-scopes.json'
        : 'valid/exchange-request-delegation.json',
    )) as { params: Record<string, string | string[]> };
    const params = paramsFromFixture(base.params);
    if (fixture.verification.typ === OAUTH_FEDERATION_TYP_CLIENT_ASSERTION) {
      params.set('client_assertion', fixture.jwt);
    } else {
      params.set('subject_token', fixture.jwt);
    }
    params.set('resource', resource);

    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join('?');
      if (statement.includes('SELECT allowed_callers FROM agents')) {
        return [{ allowed_callers: [authorizationKey] }];
      }
      if (statement.includes('FROM infra.a2a_tasks')) {
        return [
          {
            owner_principal: subject,
            owner_actor: issuer,
            authorization_profile: MENTIONABLE_OAUTH_PROFILE_ID,
            authorization_key: authorizationKey,
            authorization_revoked: false,
          },
        ];
      }
      if (statement.includes('INSERT INTO infra.oauth_token_exchange_replays')) {
        return [{ digest: 'fixture-replay' }];
      }
      if (statement.includes('INSERT INTO infra.oauth_token_exchange_access_tokens')) {
        return [{ id: 'fixture-token' }];
      }
      throw new Error(`unexpected SQL in assertion conformance test: ${statement}`);
    }) as unknown as Sql;
    sql.begin = (async (callback: (tx: Sql) => unknown) =>
      callback(sql)) as unknown as Sql['begin'];
    sql.json = ((value: unknown) => value) as Sql['json'];

    const issuerDocument = fixture.issuerDocument ?? defaultIssuerDocument;
    const app = new Hono();
    const profile = createMentionableOAuthProfile({
      resolver: {
        async resolve() {
          return issuerDocument as never;
        },
      },
    });
    let profileFailureReason: string | undefined;
    mountTokenExchangeRoutes(app, {
      sql,
      publicUrl,
      profiles: [
        {
          ...profile,
          async verify(context) {
            const result = await profile.verify(context);
            if (!result.ok) profileFailureReason = result.reason;
            return result;
          },
        },
      ],
      now: () => new Date(fixture.verification.verifiedAt),
    });
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    assert.equal(response.ok, entry.expect === 'accept', entry.file);
    if (!response.ok) {
      const body = (await response.json()) as { error: string; rejection_id?: string };
      const expectedOAuthError =
        entry.file === 'invalid/wrong-typ.json'
          ? 'invalid_request'
          : invalidClientFixtures.has(entry.file)
          ? 'invalid_client'
          : 'invalid_grant';
      assert.equal(body.error, expectedOAuthError, entry.file);
      assert.match(body.rejection_id!, /^rej_/, entry.file);
      if (entry.file !== 'invalid/wrong-typ.json') {
        assert.equal(profileFailureReason, entry.reason, entry.file);
      }
    }
  }
});
