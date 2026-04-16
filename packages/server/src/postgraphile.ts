import express from 'express';
import { postgraphile } from 'postgraphile';
import { Pool } from 'pg';
import { verifySiweToken } from './siwe-token.js';
import type { IncomingMessage } from 'node:http';

const ADMIN_WALLET_ADDRESSES = (process.env.ADMIN_WALLET_ADDRESSES ?? '')
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean)
  .join(',');

export async function startPostGraphile(databaseUrl: string): Promise<void> {
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
          try {
            const address = await verifySiweToken(token);
            return {
              role: 'app_authenticated',
              'jwt.claims.wallet_address': address,
              'app.admin_addresses': ADMIN_WALLET_ADDRESSES,
            };
          } catch {
            // fall through to anonymous
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
