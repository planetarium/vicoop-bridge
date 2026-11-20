import { decodeProtectedHeader } from 'jose';
import { publicationIdentity } from './outbound-signature.js';
import type { Sql } from './db.js';
import { publicationEnabled, wrappingTag } from './registration-signing-control.js';
import { rewrapPublicationKey } from './registration-signing.js';

type ActiveRow = {
  client_id: string;
  publication_revision: string;
  envelope: string;
  public_x: string;
  public_mac: string;
};

export async function rewrapPublications(db: Sql, oldKey: Uint8Array, newKey: Uint8Array): Promise<number> {
  const nextTag = wrappingTag(newKey);
  if (wrappingTag(oldKey) === nextTag) throw new Error('Choose a different replacement wrapping key');
  return db.begin(async tx => {
    await tx`SELECT singleton FROM bridge_private.publication_control WHERE singleton FOR UPDATE`;
    if (await publicationEnabled(tx, oldKey)) throw new Error('Pause publications before rewrapping');
    // Exclude manual rotations/revocations, including inserts for currently
    // unprovisioned registrations, until the new sentinel and every key commit.
    await tx`LOCK TABLE bridge_private.publication_keys IN SHARE ROW EXCLUSIVE MODE`;
    let last: ActiveRow | undefined;
    let updated = 0;
    for (;;) {
      const rows: ActiveRow[] = await tx<ActiveRow[]>`SELECT client_id, publication_revision::text, envelope, public_x, public_mac
        FROM bridge_private.publication_keys k WHERE envelope IS NOT NULL
        ${last ? tx`AND (k.client_id, k.publication_revision) > (${last.client_id}, ${last.publication_revision}::bigint)` : tx``}
        ORDER BY k.client_id, k.publication_revision LIMIT 100`;
      if (!rows.length) break;
      for (const row of rows) {
        // Candidate only. rewrapPublicationKey authenticates this header with
        // the old KEK and verifies the public projection before resealing it.
        const { kid } = decodeProtectedHeader(row.envelope);
        if (!kid) throw new Error('Stored publication key has no subject');
        // The path retains the original local name even after the registration
        // was renamed. Check the row binding independently of the current name.
        const url = new URL(kid);
        const local = url.pathname.split('/')[2];
        const expected = publicationIdentity(url.origin)({ ...row, id: local });
        if (expected?.id !== kid) throw new Error('Stored publication subject does not match its key row');
        const next = await rewrapPublicationKey(row, kid, oldKey, newKey);
        await tx`UPDATE bridge_private.publication_keys
          SET envelope = ${next.envelope}, public_mac = ${next.public_mac}, public_x = ${next.public_x}
          WHERE client_id = ${row.client_id} AND publication_revision = ${row.publication_revision}`;
        updated++;
      }
      last = rows[rows.length - 1];
    }
    await tx`UPDATE bridge_private.publication_control SET wrapping_tag = ${nextTag} WHERE singleton`;
    return updated;
  });
}
