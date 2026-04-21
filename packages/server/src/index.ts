import { serve } from '@hono/node-server';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { attachWsServer } from './ws.js';
import type { Sql } from './db.js';
import type { GoogleConfig } from './auth/google-oauth.js';

const DEVICE_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h

async function cleanupExpiredDeviceSessions(db: Sql): Promise<void> {
  try {
    await db`DELETE FROM device_sessions WHERE expires_at <= now()`;
  } catch (err) {
    console.error('[server] device_sessions cleanup failed:', err);
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

  // Cleanup expired device_sessions on startup and periodically.
  void cleanupExpiredDeviceSessions(opts.db);
  const cleanupTimer = setInterval(
    () => void cleanupExpiredDeviceSessions(opts.db),
    DEVICE_SESSION_CLEANUP_INTERVAL_MS,
  );
  cleanupTimer.unref();

  console.log(`[server] listening on :${opts.port}`);
  return { registry, server };
}

export { Registry } from './registry.js';
