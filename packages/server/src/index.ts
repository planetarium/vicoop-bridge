import { serve } from '@hono/node-server';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { attachWsServer } from './ws.js';
import { PostgresTaskStore } from './postgres-task-store.js';
import { logEvent } from './log.js';
import { sweepExpiredX402Offerings } from './x402/store.js';
import { watchX402PricingChanges } from './x402/pricing-watch.js';
import { sweepExpiredIdentityReplays } from './identity-vc/index.js';
import { sweepExpiredTokenExchangeState } from './oauth/token-exchange/store.js';
import type { Sql } from './db.js';
import type { GoogleConfig } from './auth/google-oauth.js';
import { watchCallerPolicyChanges } from './caller-policy-watch.js';

const TRANSIENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h

// Time-based retention for infra.a2a_tasks (issue #385). Contexts idle for
// longer than this are reclaimed whole; an explicit 0 (or non-positive)
// disables the job. Unset OR empty-string falls back to the 30-day default
// (Number('') is 0, so we must treat '' as unset rather than as "disable").
// Complements the count-based per-context cap in PostgresTaskStore.upsert().
const TASK_RETENTION_DAYS =
  process.env.A2A_TASK_RETENTION_DAYS
    ? Number(process.env.A2A_TASK_RETENTION_DAYS)
    : 30;

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
  try {
    const deleted = await sweepExpiredIdentityReplays(db);
    if (deleted > 0) logEvent('identity_vc_replays_swept', { deleted });
  } catch (err) {
    console.error('[server] identity_vc_replays cleanup failed:', err);
  }
  try {
    const deleted = await sweepExpiredTokenExchangeState(db);
    if (deleted.tokens > 0 || deleted.replays > 0) {
      logEvent('oauth_token_exchange_state_swept', deleted);
    }
  } catch (err) {
    console.error('[server] oauth token-exchange cleanup failed:', err);
  }
  try {
    // Lazy expiry hides a lapsed offering from `get` but never deletes it, so
    // every caller that walks away at the `input-required` turn leaves a row
    // behind. On a public paid agent that is an unauthenticated way to grow
    // the table, which is why this runs rather than relying on task teardown.
    const deleted = await sweepExpiredX402Offerings(db);
    if (deleted > 0) logEvent('x402_offerings_swept', { deleted });
  } catch (err) {
    console.error('[server] x402_offerings cleanup failed:', err);
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

  // Pricing is cached on the live connection, and an admin write only patches
  // the instance that served it. Without this, an agent repriced (or made
  // free) on one instance keeps billing at the old price from another until it
  // reconnects. Best-effort: a failed subscription degrades to that same
  // reconnect-scoped behavior rather than blocking startup.
  void watchX402PricingChanges(opts.db, registry);
  void watchCallerPolicyChanges(opts.db, registry);

  console.log(`[server] listening on :${opts.port}`);
  return { registry, server };
}

export { Registry } from './registry.js';
