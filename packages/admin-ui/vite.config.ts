import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
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
