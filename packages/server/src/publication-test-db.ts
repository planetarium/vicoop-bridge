import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createDb, ensureSchema, type Sql } from './db.js';

// Rotation and recovery tests change database-wide state. A private test
// database also permits exercising independent connection pools and locks.
export async function createPublicationTestDb(t: TestContext): Promise<Sql> {
  const url = new URL(process.env.DATABASE_URL!);
  const admin = createDb(url.href);
  const name = 'publication_test_' + randomUUID().replaceAll('-', '');
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
  } catch (error) {
    await admin.end();
    throw error;
  }
  url.pathname = '/' + name;
  const db = createDb(url.href);
  t.after(async () => {
    try {
      await db.end();
      await admin`DROP DATABASE ${admin(name)}`;
    } finally { await admin.end(); }
  });
  await ensureSchema(db);
  return db;
}
