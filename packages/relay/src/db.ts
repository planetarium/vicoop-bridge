import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export interface ConnectorRow {
  id: string;
  owner_wallet: string;
  connector_name: string;
  token_hash: string;
  allowed_agent_ids: string[];
  revoked: boolean;
  created_at: Date;
}

export type Sql = postgres.Sql;

export function createDb(databaseUrl: string): Sql {
  return postgres(databaseUrl);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function ensureSchema(sql: Sql): Promise<void> {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schemaSql);
}

/** Used by WebSocket hello auth — bypasses RLS (superuser connection). */
export async function lookupByTokenHash(sql: Sql, hash: string): Promise<ConnectorRow | null> {
  const rows = await sql<ConnectorRow[]>`
    SELECT * FROM connectors WHERE token_hash = ${hash} AND revoked = false
  `;
  return rows[0] ?? null;
}
