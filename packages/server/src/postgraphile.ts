import express from 'express';
import { postgraphile } from 'postgraphile';
import { Pool } from 'pg';
import type { IncomingMessage } from 'node:http';
import type { Sql } from './db.js';
import { CALLER_TOKEN_PREFIX, verifyCallerToken } from './auth/caller-token.js';

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
          // Opaque caller tokens are the only accepted admin GraphQL credential
          // as of #31. Wallet-based callers (eth:* principals) get RLS-gated
          // access; Google-only callers have no owner_wallet so their queries
          // fall through to anonymous.
          if (token.startsWith(CALLER_TOKEN_PREFIX)) {
            try {
              const caller = await verifyCallerToken(sql, token);
              if (caller.principalId.startsWith('eth:')) {
                const walletAddress = caller.principalId.slice('eth:'.length);
                return {
                  role: 'app_authenticated',
                  'jwt.claims.wallet_address': walletAddress,
                  'app.admin_addresses': ADMIN_WALLET_ADDRESSES,
                };
              }
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
