import express from 'express';
import { postgraphile } from 'postgraphile';
import { Pool } from 'pg';
import type { IncomingMessage } from 'node:http';
import type { Sql } from './db.js';
import { OWNER_SESSION_PREFIX, verifySessionToken } from './auth/caller-token.js';

const ADMIN_WALLET_ADDRESSES = (process.env.ADMIN_WALLET_ADDRESSES ?? '')
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean)
  .join(',');

export async function startPostGraphile(databaseUrl: string, sql: Sql): Promise<void> {
  const port = Number(process.env.POSTGRAPHILE_PORT ?? 5433);

  const pool = new Pool({
    connectionString: databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 60_000,
  });

  pool.on('error', (err: Error) => {
    console.error('Unexpected error on idle PostgreSQL client:', err);
  });

  const app = express();

  app.use(
    postgraphile(pool, 'public', {
      retryOnInitFail: (error: Error, attempts: number) => attempts < 5,
      watchPg: false,
      graphiql: true,
      enhanceGraphiql: true,
      enableCors: true,
      dynamicJson: true,
      legacyRelations: 'omit',
      setofFunctionsContainNulls: false,
      ignoreRBAC: false,
      pgSettings: async (req: IncomingMessage) => {
        const auth = req.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          const token = auth.slice(7);
          // /graphql is owner-self-service: only `vbc_owner_*` tokens are
          // honored. `vbc_caller_*` tokens are for third-party agent calls
          // at /agents/:id and intentionally fall through to anonymous
          // here so a leaked caller token cannot be used to enumerate the
          // owner's GraphQL surface (issue #79 PR D).
          if (token.startsWith(OWNER_SESSION_PREFIX)) {
            try {
              const caller = await verifySessionToken(sql, token, {
                expectedAudience: 'owner_session',
              });
              return {
                role: 'app_authenticated',
                'jwt.claims.principal_id': caller.principalId,
                'app.admin_addresses': ADMIN_WALLET_ADDRESSES,
              };
            } catch {
              // fall through to anonymous
            }
          }
        }
        return { role: 'app_anonymous' };
      },
    }),
  );

  app.listen(port, () => {
    console.log(`[server] PostGraphile listening on :${port}`);
  });
}
