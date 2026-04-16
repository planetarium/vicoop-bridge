#!/usr/bin/env node
import { startServer } from './index.js';
import { createDb, ensureSchema } from './db.js';
import { startPostGraphile } from './postgraphile.js';

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
const dbSetupUrl = process.env.DB_SETUP_URL;
const publicUrl = process.env.PUBLIC_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL env var required');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

async function main() {
  // Schema setup uses superuser connection (creates roles, RLS policies)
  const setupDb = createDb(dbSetupUrl ?? databaseUrl!);
  await ensureSchema(setupDb);
  await setupDb.end();
  console.log('[server] schema ensured');

  // Runtime DB connection (used for client token lookup)
  const db = createDb(databaseUrl!);

  await startPostGraphile(databaseUrl!);
  await startServer({ port, publicUrl, db });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
