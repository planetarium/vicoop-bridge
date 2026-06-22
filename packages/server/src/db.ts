import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

// A queryable connection: either the pooled `Sql` or a transaction-scoped
// `TransactionSql` (yielded by `sql.begin`). Use this for helpers that run
// the same queries inside or outside a transaction — `TransactionSql` is not
// assignable to `Sql` (it lacks pool-lifecycle methods like END/CLOSE), so a
// helper that must accept both needs the union.
export type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export function createDb(databaseUrl: string): Sql {
  return postgres(databaseUrl);
}

export async function ensureSchema(sql: Sql): Promise<void> {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schemaSql);
}
