import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';
import {
  createInMemoryAssertionReplayCache,
  verifyOAuthFederationAssertion,
  verifyTokenExchange,
  type IssuerDidDocument,
} from '@mentionable/connector-kit/signing';

const fixtureRoot = fileURLToPath(
  new URL('../../../../vendor/mentionable-connector-kit/fixtures/', import.meta.url),
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

test('connector-kit v0.1 conformance manifest stays green at the bridge verifier boundary', async () => {
  const manifest = await json('manifest.json') as unknown as Array<{
    file: string;
    kind: 'assertion' | 'exchange-request' | 'replay';
    expect: 'accept' | 'reject';
    reason?: string;
  }>;
  const issuerDocument = await json('issuer/did.json') as IssuerDidDocument;
  const trustedIssuers = new Set([issuerDocument.id]);
  const resolveIssuerDocument = (issuer: string) =>
    issuer === issuerDocument.id ? issuerDocument : undefined;

  for (const entry of manifest) {
    const fixture = await json(entry.file);
    if (entry.kind === 'assertion') {
      const outcome = await verifyOAuthFederationAssertion(
        fixture.jwt,
        fixture.verification,
        { trustedIssuers, resolveIssuerDocument },
      );
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
      });
      assert.equal(outcome.ok, entry.expect === 'accept', entry.file);
      if (!outcome.ok) assert.equal(outcome.reason, entry.reason, entry.file);
      continue;
    }

    const replayCache = createInMemoryAssertionReplayCache();
    const first = await verifyOAuthFederationAssertion(
      fixture.jwt,
      fixture.verification,
      { trustedIssuers, resolveIssuerDocument, replayCache },
    );
    const second = await verifyOAuthFederationAssertion(
      fixture.jwt,
      fixture.verification,
      { trustedIssuers, resolveIssuerDocument, replayCache },
    );
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
