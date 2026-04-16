import { serve } from '@hono/node-server';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { attachWsServer } from './ws.js';
import type { Sql } from './db.js';

export interface RelayOptions {
  port: number;
  host?: string;
  publicUrl?: string;
  db: Sql;
}

export async function startRelay(opts: RelayOptions) {
  const registry = new Registry();
  const app = createHttpApp({
    registry,
    publicUrl: opts.publicUrl,
    db: opts.db,
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

  console.log(`[relay] listening on :${opts.port}`);
  return { registry, server };
}

export { Registry } from './registry.js';
