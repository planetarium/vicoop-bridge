import { createHmac } from 'node:crypto';
import type { Sql, SqlExecutor } from './db.js';

// Only a verifier is stored in PostgreSQL. Keep this domain distinct from
// publication signatures, public-key authentication and JWE encryption.
export function wrappingTag(key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error('Expected a 32-byte publication wrapping key');
  return createHmac('sha256', key).update('vicoop:publication:wrapping-key-check:v1').digest('base64url');
}

export async function publicationEnabled(db: SqlExecutor, key: Uint8Array, lockForSigning = false): Promise<boolean> {
  const [control] = await db<{ wrapping_tag: string; paused: boolean }[]>`
    SELECT wrapping_tag, paused FROM bridge_private.publication_control WHERE singleton
    ${lockForSigning ? db`FOR SHARE` : db``}`;
  if (!control || control.wrapping_tag !== wrappingTag(key)) {
    throw new Error('Publication wrapping key does not match this database');
  }
  return !control.paused;
}

export async function initializePublicationControl(db: Sql, key: Uint8Array): Promise<void> {
  const tag = wrappingTag(key);
  await db.begin(async tx => {
    // Two first starts with different keys must agree on one before either
    // may provision. A missing sentinel beside existing keys requires recovery.
    await tx`SELECT pg_advisory_xact_lock(hashtext('vicoop-bridge:initialize-publication-control'))`;
    const [existing] = await tx`SELECT singleton FROM bridge_private.publication_control WHERE singleton`;
    if (!existing) {
      await tx`INSERT INTO bridge_private.publication_control (singleton, wrapping_tag)
        SELECT TRUE, ${tag} WHERE NOT EXISTS (SELECT 1 FROM bridge_private.publication_keys)
        ON CONFLICT (singleton) DO NOTHING`;
    }
    await publicationEnabled(tx, key);
  });
}
