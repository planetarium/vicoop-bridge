#!/usr/bin/env node
import { startRelay } from './index.js';

const port = Number(process.env.PORT ?? 8787);
const adapterToken = process.env.ADAPTER_TOKEN;
if (!adapterToken) {
  console.error('ADAPTER_TOKEN env var required');
  process.exit(1);
}
const publicUrl = process.env.PUBLIC_URL;

startRelay({ port, adapterToken, publicUrl }).catch((err) => {
  console.error(err);
  process.exit(1);
});
