import type { Sql } from './db.js';
import { wrappingTag } from './registration-signing-control.js';

// Offline disaster recovery deliberately discards the restored signing material.
// The operator reconciles an external inventory before releasing any registration.
export async function quarantineRestoredPublicationKeys(db: Sql, replacement?: Uint8Array) {
  const tag = replacement && wrappingTag(replacement);
  await db.begin(async tx => {
    await tx`LOCK TABLE bridge_private.publication_control IN ACCESS EXCLUSIVE MODE`;
    const [control] = await tx<{ paused: boolean }[]>`SELECT paused FROM bridge_private.publication_control WHERE singleton`;
    if (control && !control.paused) throw new Error('Pause publications before quarantining a restored database');
    if (!control && !tag) throw new Error('A database without publication control requires a new wrapping key');

    await tx`LOCK TABLE agents, bridge_private.publication_keys IN SHARE ROW EXCLUSIVE MODE`;
    await tx`UPDATE bridge_private.publication_keys SET envelope=NULL, public_x=NULL, public_mac=NULL
      WHERE envelope IS NOT NULL OR public_x IS NOT NULL OR public_mac IS NOT NULL`;
    await tx`INSERT INTO bridge_private.publication_keys (client_id, publication_revision)
      SELECT client_id, publication_revision FROM agents ON CONFLICT DO NOTHING`;
    if (tag) {
      await tx`INSERT INTO bridge_private.publication_control(singleton, paused, wrapping_tag)
        VALUES (true, true, ${tag}) ON CONFLICT(singleton) DO UPDATE
        SET paused=true, wrapping_tag=EXCLUDED.wrapping_tag`;
    }
  });
}
