#!/usr/bin/env node
import { startServer } from './index.js';
import { createDb, ensureSchema } from './db.js';
import { startPostGraphile } from './postgraphile.js';

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
const dbSetupUrl = process.env.DB_SETUP_URL;
const publicUrl = process.env.PUBLIC_URL;

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const deviceFlowStateSecret = process.env.DEVICE_FLOW_STATE_SECRET;

if (!databaseUrl) {
  console.error('DATABASE_URL env var required');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

// Google OAuth device flow is optional. If any Google config is partially
// provided we fail fast to surface misconfiguration.
const googleConfigured = !!(googleClientId || googleClientSecret || deviceFlowStateSecret);
if (googleConfigured && (!googleClientId || !googleClientSecret || !deviceFlowStateSecret || !publicUrl)) {
  console.error(
    'Google OAuth device flow requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
      'DEVICE_FLOW_STATE_SECRET, and PUBLIC_URL to all be set.',
  );
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

  await startPostGraphile(databaseUrl!, db);
  await startServer({
    port,
    publicUrl,
    db,
    google: googleConfigured
      ? {
          clientId: googleClientId!,
          clientSecret: googleClientSecret!,
          redirectUri: `${publicUrl}/oauth/google/callback`,
        }
      : undefined,
    deviceFlowStateSecret,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
