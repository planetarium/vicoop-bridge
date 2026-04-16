import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function createDb(databaseUrl: string): Sql {
  return postgres(databaseUrl);
}

export async function ensureSchema(sql: Sql): Promise<void> {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schemaSql);
}
