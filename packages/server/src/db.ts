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
  // Opt-in server-side statement timeout (issue #414). Off by default — no
  // behavior change unless `VICOOP_DB_STATEMENT_TIMEOUT_MS` is set. When set, a
  // wedged query (e.g. an `updateTask` blocked on a row lock or a saturated
  // pool) self-aborts with a Postgres error instead of freezing the A2A SSE
  // stream for the router's full stall window — turning a silent ~300s stall
  // into a fast, logged failure the router can fail over on. Applies to every
  // pooled connection (statement_timeout is per-session), so keep it well above
  // normal write latency; it also bounds `ensureSchema` and retention DELETEs.
  const statementTimeoutMs = (() => {
    const raw = process.env.VICOOP_DB_STATEMENT_TIMEOUT_MS;
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  })();
  if (statementTimeoutMs === undefined) return postgres(databaseUrl);
  return postgres(databaseUrl, {
    connection: { statement_timeout: statementTimeoutMs },
  });
}

export async function ensureSchema(sql: Sql): Promise<void> {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schemaSql);
}
