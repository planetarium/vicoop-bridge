import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  consumeTokenExchangeReplays,
  issueTokenExchangeAccessToken,
  TokenExchangeReplayError,
  verifyTokenExchangeAccessToken,
} from './store.js';

const hasDb = !!process.env.DATABASE_URL;

test(
  'token-exchange attestations round-trip through Postgres as JSON objects',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const tag = `token-exchange-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentId = `${tag}-agent`;
    const allowedCaller = `${tag}-caller`;
    const attestation = {
      credentialId: `urn:${tag}:credential`,
      issuer: `did:web:${tag}.example`,
      subject: `slack:${tag}`,
      method: 'urn:mentionable:auth:test',
    };

    try {
      await sql`
        INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
        VALUES (${agentId}, ${`${tag}-owner`}, 'token-exchange-test', ${`${tag}-hash`},
                ${[allowedCaller]})
      `;

      const issued = await issueTokenExchangeAccessToken(sql, {
        profileId: 'urn:test:token-exchange',
        agentId,
        resource: `https://bridge.test/agents/${agentId}`,
        principalId: `slack:${tag}`,
        actorId: `did:web:${tag}.example`,
        allowedCaller,
        attestation,
        scopes: ['a2a:message.send'],
        expiresAt: new Date(Date.now() + 60_000),
      });

      const [stored] = await sql<{ attestation: unknown; kind: string }[]>`
        SELECT attestation, jsonb_typeof(attestation) AS kind
        FROM infra.oauth_token_exchange_access_tokens
        WHERE id = ${issued.token.tokenId}
      `;
      assert.equal(stored?.kind, 'object');
      assert.deepEqual(stored?.attestation, attestation);

      const verified = await verifyTokenExchangeAccessToken(sql, issued.rawToken, agentId);
      assert.deepEqual(verified.attestation, attestation);
    } finally {
      await sql`DELETE FROM agents WHERE id = ${agentId}`;
      await sql.end();
    }
  },
);

test(
  'Postgres replay registration is exchange-atomic and admits one concurrent winner',
  { skip: !hasDb },
  async () => {
    const sql = postgres(process.env.DATABASE_URL!);
    const tag = `token-exchange-replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + 60_000);
    const atomicProfile = `urn:test:${tag}:atomic`;
    const concurrentProfile = `urn:test:${tag}:concurrent`;

    try {
      await consumeTokenExchangeReplays(sql, atomicProfile, [
        { issuer: 'did:web:connector.example', jti: 'subject-existing', expiresAt },
      ]);
      await assert.rejects(
        consumeTokenExchangeReplays(sql, atomicProfile, [
          { issuer: 'did:web:connector.example', jti: 'client-fresh', expiresAt },
          { issuer: 'did:web:connector.example', jti: 'subject-existing', expiresAt },
        ]),
        (error: unknown) => error instanceof TokenExchangeReplayError && error.tupleIndex === 1,
      );
      const [atomicCount] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM infra.oauth_token_exchange_replays
        WHERE profile_id = ${atomicProfile}
      `;
      assert.equal(Number(atomicCount?.count), 1, 'the fresh first tuple must roll back');

      const concurrentTuples = [
        { issuer: 'did:web:connector.example', jti: 'client', expiresAt },
        { issuer: 'did:web:connector.example', jti: 'subject', expiresAt },
      ];
      const outcomes = await Promise.allSettled([
        consumeTokenExchangeReplays(sql, concurrentProfile, concurrentTuples),
        consumeTokenExchangeReplays(sql, concurrentProfile, concurrentTuples),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof TokenExchangeReplayError);
      const [concurrentCount] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM infra.oauth_token_exchange_replays
        WHERE profile_id = ${concurrentProfile}
      `;
      assert.equal(Number(concurrentCount?.count), 2);
    } finally {
      await sql`
        DELETE FROM infra.oauth_token_exchange_replays
        WHERE profile_id IN (${atomicProfile}, ${concurrentProfile})
      `;
      await sql.end();
    }
  },
);
