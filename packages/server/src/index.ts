import { serve } from '@hono/node-server';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { attachWsServer } from './ws.js';
import type { Sql } from './db.js';
import type { GoogleConfig } from './auth/google-oauth.js';

const TRANSIENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h

async function cleanupExpiredTransients(db: Sql): Promise<void> {
  try {
    await db`DELETE FROM device_sessions WHERE expires_at <= now()`;
  } catch (err) {
    console.error('[server] device_sessions cleanup failed:', err);
  }
  try {
    await db`DELETE FROM used_siwe_nonces WHERE expires_at <= now()`;
  } catch (err) {
    console.error('[server] used_siwe_nonces cleanup failed:', err);
  }
}

export interface ServerOptions {
  port: number;
  host?: string;
  publicUrl?: string;
  db: Sql;
  google?: GoogleConfig;
  deviceFlowStateSecret?: string;
}

export async function startServer(opts: ServerOptions) {
  const registry = new Registry();
  const app = createHttpApp({
    registry,
    publicUrl: opts.publicUrl,
    db: opts.db,
    google: opts.google,
    deviceFlowStateSecret: opts.deviceFlowStateSecret,
  });

  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    hostname: opts.host ?? '0.0.0.0',
  });

  attachWsServer(server as unknown as import('node:http').Server, {
    db: opts.db,
    registry,
  });

  // Cleanup expired transient rows (device_sessions, used_siwe_nonces) on
  // startup and periodically.
  void cleanupExpiredTransients(opts.db);
  const cleanupTimer = setInterval(
    () => void cleanupExpiredTransients(opts.db),
    TRANSIENT_CLEANUP_INTERVAL_MS,
  );
  cleanupTimer.unref();

  console.log(`[server] listening on :${opts.port}`);
  return { registry, server };
}

export { Registry } from './registry.js';
