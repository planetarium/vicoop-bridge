import { serve } from '@hono/node-server';
import { Registry } from './registry.js';
import { createHttpApp } from './http.js';
import { attachWsServer } from './ws.js';

export interface RelayOptions {
  port: number;
  host?: string;
  adapterToken: string;
  publicUrl?: string;
}

export async function startRelay(opts: RelayOptions) {
  const registry = new Registry();
  const app = createHttpApp({
    registry,
    publicUrl: opts.publicUrl,
  });

  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    hostname: opts.host ?? '0.0.0.0',
  });

  attachWsServer(server as unknown as import('node:http').Server, {
    adapterToken: opts.adapterToken,
    registry,
  });

  console.log(`[relay] listening on :${opts.port}`);
  return { registry, server };
}

export { Registry } from './registry.js';
