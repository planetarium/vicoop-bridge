import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IdentityReplayStore, ResolvedDidDocument } from './types.js';
import { PlatformIdentityVerifier } from './verifier.js';

const root = fileURLToPath(new URL('./fixtures/mentionable-v0.2/', import.meta.url));

function bytes(path: string): Buffer {
  return readFileSync(`${root}${path}`);
}

function json<T>(path: string): T {
  return JSON.parse(bytes(path).toString('utf8')) as T;
}

const source = json<{
  commit: string;
  sha256: Record<string, string>;
}>('SOURCE.json');

const manifest = json<Array<{
  file: string;
  kind: 'valid' | 'invalid' | 'replay';
  expect: 'accept' | 'reject';
  reason?: string;
  verification: { audience: string; messageId: string; verifiedAt: string };
}>>('manifest.json');
const didDocument = json<ResolvedDidDocument>('issuer/did.json');
const mismatchDidDocument = json<ResolvedDidDocument>('issuer/mismatch-did.json');

function replayStore(): IdentityReplayStore {
  const consumed = new Set<string>();
  return {
    async consume(input) {
      const key = JSON.stringify([input.issuer, input.domain, input.challenge]);
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    },
  };
}

test('vendored Mentionable v0.2 fixtures are pinned by merge commit and SHA-256', () => {
  assert.equal(source.commit, '988a0922cfd9a77211790aa387f543f180f33e5b');
  const actualFixtureFiles = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'SOURCE.json')
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
  assert.deepEqual(actualFixtureFiles, Object.keys(source.sha256).sort());
  for (const [path, expected] of Object.entries(source.sha256)) {
    assert.equal(createHash('sha256').update(bytes(path)).digest('hex'), expected, path);
  }
});

for (const item of manifest.filter(({ kind }) => kind !== 'replay')) {
  test(`Mentionable v0.2 conformance: ${item.file}`, async () => {
    const credential = json<{ issuer: string }>(item.file);
    const verifier = new PlatformIdentityVerifier({
      trustedIssuers: [credential.issuer],
      resolver: {
        async resolve() {
          return item.reason === 'issuer-controller-mismatch'
            ? mismatchDidDocument
            : didDocument;
        },
      },
      replayStore: replayStore(),
      now: () => new Date(item.verification.verifiedAt),
    });
    const result = await verifier.verify(credential, {
      expectedDomain: item.verification.audience,
      messageId: item.verification.messageId,
    });
    assert.equal(result.ok, item.expect === 'accept');
    if (result.ok && item.file === 'valid/direct-user.json') {
      assert.deepEqual(result.identity.platform, {
        provider: 'slack',
        workspaceId: 'T0FIXTURE',
      });
      assert.deepEqual(result.identity.profile, {
        displayName: 'Fixture User',
        username: 'fixture-user',
      });
    }
  });
}

test('Mentionable v0.2 replay fixture accepts once and rejects the second presentation', async () => {
  const fixture = json<{
    credential: { issuer: string };
    tuple: { domain: string; challenge: string };
  }>('replay/replay-scenario.json');
  const verifier = new PlatformIdentityVerifier({
    trustedIssuers: [fixture.credential.issuer],
    resolver: { async resolve() { return didDocument; } },
    replayStore: replayStore(),
    now: () => new Date('2026-08-19T00:01:00Z'),
  });
  const binding = {
    expectedDomain: fixture.tuple.domain,
    messageId: fixture.tuple.challenge,
  };
  assert.equal((await verifier.verify(fixture.credential, binding)).ok, true);
  const second = await verifier.verify(fixture.credential, binding);
  assert.deepEqual(second, { ok: false, rejection: { code: 'replayed' } });
});
