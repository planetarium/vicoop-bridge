import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  issueTokenExchangeAccessToken,
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
