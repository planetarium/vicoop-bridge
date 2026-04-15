#!/usr/bin/env node
import { startRelay } from './index.js';

const port = Number(process.env.PORT ?? 8787);
const connectorToken = process.env.CONNECTOR_TOKEN ?? process.env.ADAPTER_TOKEN;
if (!connectorToken) {
  console.error('CONNECTOR_TOKEN env var required');
  process.exit(1);
}
const publicUrl = process.env.PUBLIC_URL;

startRelay({ port, connectorToken, publicUrl }).catch((err) => {
  console.error(err);
  process.exit(1);
});
