import { readFileSync } from 'node:fs';
import { createDb } from '../src/db.js';
import { rewrapPublications } from '../src/rewrap-publications.js';

const [oldPath, newPath] = process.argv.slice(2);
if (process.argv.length !== 4 || !process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL and pass the old and new wrapping key file paths');
}
const db = createDb(process.env.DATABASE_URL);
try {
  const count = await rewrapPublications(db, readFileSync(oldPath), readFileSync(newPath));
  console.log(`Rewrapped ${count} publication keys. Publications remain paused.`);
} finally {
  await db.end();
}
