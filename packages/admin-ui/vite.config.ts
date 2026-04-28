import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// @a2x/sdk imports `x402/*` at module top level for its payment helpers.
// Admin UI never opts into the x402 flow, so alias all x402 entry points
// to a noop stub. Without this, Vite's bundler fails because x402 is an
// optional peer dep we don't install.
const x402Stub = path.resolve(import.meta.dirname, 'src/lib/x402-stub.ts');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  resolve: {
    alias: [
      { find: 'x402/client', replacement: x402Stub },
      { find: 'x402/shared', replacement: x402Stub },
      { find: 'x402/types', replacement: x402Stub },
      { find: /^x402$/, replacement: x402Stub },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/': {
        target: 'http://localhost:3000',
        bypass: (req) => {
          // Serve admin UI assets from Vite, proxy API calls to server
          if (req.url?.startsWith('/admin')) return req.url;
        },
      },
    },
  },
});
