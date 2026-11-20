import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CompactEncrypt, compactDecrypt } from 'jose';
import type { Sql } from './db.js';
import { publicationIdentity, signPublication, verificationKey, type PublicationAuthority, type Registration } from './outbound-signature.js';

export function loadRegistrationSigner(db: Sql, wrappingKeyPath: string, publicUrl?: string): PublicationAuthority {
  const wrappingKey = readFileSync(wrappingKeyPath);
  if (wrappingKey.length !== 32) throw new Error('Expected a 32-byte publication wrapping key');
  const identity = publicationIdentity(publicUrl);

  async function loadKey(reg: Registration) {
    const sender = identity(reg);
    if (!sender) return;
    // Lock the current registration while checking its epoch and provisioning a key.
    // Concurrent first lookups, ownership transfers and deletions serialize here.
    const envelope = await db.begin(async tx => {
      const agents = await tx`SELECT 1 FROM agents WHERE id = ${reg.id}
        AND client_id = ${reg.client_id} AND owner_revision = ${reg.owner_revision} FOR NO KEY UPDATE`;
      if (!agents.length) return null;
      const [stored] = await tx<{ envelope: string | null }[]>`SELECT envelope FROM bridge_private.publication_keys
        WHERE client_id = ${reg.client_id} AND owner_revision = ${reg.owner_revision}`;
      if (stored) return stored.envelope;

      const { privateKey } = generateKeyPairSync('ed25519');
      const der = privateKey.export({ format: 'der', type: 'pkcs8' });
      const sealed = await new CompactEncrypt(der)
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: sender.id }).encrypt(wrappingKey);
      await tx`INSERT INTO bridge_private.publication_keys (client_id, owner_revision, envelope)
        VALUES (${reg.client_id}, ${reg.owner_revision}, ${sealed})`;
      return sealed;
    });
    if (!envelope) return;
    const { protectedHeader, plaintext } = await compactDecrypt(envelope, wrappingKey, {
      keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'],
    });
    if (protectedHeader.kid !== sender.id) throw new Error('Publication key belongs to another registration');
    const key = createPrivateKey({ key: Buffer.from(plaintext), format: 'der', type: 'pkcs8' });
    return { key, jwk: verificationKey(createPublicKey(key)), subject: sender.id };
  }

  return {
    identity,
    async keysFor(reg) {
      const stored = await loadKey(reg);
      return stored ? [stored.jwk] : [];
    },
    async signRequest(request, reg) {
      const stored = await loadKey(reg);
      if (!stored) throw new Error('Registration has no active publication key');
      return signPublication(request, stored.subject, stored.key, stored.jwk.kid);
    },
  };
}
