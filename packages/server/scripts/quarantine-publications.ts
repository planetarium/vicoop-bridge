import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDb } from '../src/db.js';
import { quarantineRestoredPublicationKeys } from '../src/registration-recovery.js';

const { values } = parseArgs({ options: {
  'discard-restored-keys': { type: 'boolean' },
  'new-wrapping-key': { type: 'string' },
} });
if (!values['discard-restored-keys'] || !process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL and pass --discard-restored-keys [--new-wrapping-key FILE]');
}
const path = values['new-wrapping-key'];
const key = path && readFileSync(path);
const db = createDb(process.env.DATABASE_URL);
try {
  await quarantineRestoredPublicationKeys(db, key || undefined);
  console.log('Publication keys quarantined. The authority remains paused.');
} finally {
  if (key) key.fill(0);
  await db.end();
}
