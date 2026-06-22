import { serve } from '@hono/node-server';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { attachWsServer } from './ws.js';
import { PostgresTaskStore } from './postgres-task-store.js';
import { logEvent } from './log.js';
import type { Sql } from './db.js';
import type { GoogleConfig } from './auth/google-oauth.js';

const TRANSIENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h

// Time-based retention for infra.a2a_tasks (issue #385). Contexts idle for
// longer than this are reclaimed whole; 0 (or non-positive) disables the job.
// Complements the count-based per-context cap in PostgresTaskStore.upsert().
const TASK_RETENTION_DAYS = Number(process.env.A2A_TASK_RETENTION_DAYS ?? 30);

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

async function cleanupStaleTasks(db: Sql): Promise<void> {
  if (!Number.isFinite(TASK_RETENTION_DAYS) || TASK_RETENTION_DAYS <= 0) return;
  try {
    const deleted = await new PostgresTaskStore(db).pruneStaleContexts(TASK_RETENTION_DAYS);
    if (deleted > 0) {
      logEvent('a2a_tasks_pruned', { deleted, retentionDays: TASK_RETENTION_DAYS });
    }
  } catch (err) {
    console.error('[server] a2a_tasks retention cleanup failed:', err);
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

  // Cleanup expired transient rows (device_sessions, used_siwe_nonces) and
  // prune stale a2a_tasks contexts, on startup and periodically.
  const runCleanup = (): void => {
    void cleanupExpiredTransients(opts.db);
    void cleanupStaleTasks(opts.db);
  };
  runCleanup();
  const cleanupTimer = setInterval(runCleanup, TRANSIENT_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  console.log(`[server] listening on :${opts.port}`);
  return { registry, server };
}

export { Registry } from './registry.js';
