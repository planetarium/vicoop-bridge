import { createHash } from 'node:crypto';
import type { Sql } from '../db.js';
import type { IdentityReplayStore } from './types.js';

export function identityReplayDigest(issuer: string, domain: string, challenge: string): Buffer {
  // Length-prefixed tuple avoids delimiter ambiguity without retaining PII in
  // the replay table.
  return createHash('sha256')
    .update(`${Buffer.byteLength(issuer)}:${issuer}`)
    .update(`${Buffer.byteLength(domain)}:${domain}`)
    .update(`${Buffer.byteLength(challenge)}:${challenge}`)
    .digest();
}

export class PostgresIdentityReplayStore implements IdentityReplayStore {
  constructor(private readonly sql: Sql) {}

  async consume(input: {
    issuer: string;
    domain: string;
    challenge: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const digest = identityReplayDigest(input.issuer, input.domain, input.challenge);
    const rows = await this.sql<{ digest: Buffer }[]>`
      INSERT INTO identity_vc_replays (digest, expires_at)
      VALUES (${digest}, ${input.expiresAt})
      ON CONFLICT (digest) DO NOTHING
      RETURNING digest
    `;
    return rows.length === 1;
  }
}

export async function sweepExpiredIdentityReplays(sql: Sql): Promise<number> {
  const result = await sql`DELETE FROM identity_vc_replays WHERE expires_at <= now()`;
  return result.count;
}
