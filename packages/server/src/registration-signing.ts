import {
  createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, timingSafeEqual, type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CompactEncrypt, compactDecrypt } from 'jose';
import type { Sql } from './db.js';
import { initializePublicationControl, publicationEnabled } from './registration-signing-control.js';
import { publicationIdentity, signPublication, verificationKey, type PublicationAuthority, type Registration } from './outbound-signature.js';

type KeyRow = { envelope: string | null; public_x: string | null; public_mac: string | null };

function bindingKey(wrappingKey: Uint8Array) {
  return Buffer.from(hkdfSync('sha256', wrappingKey, Buffer.alloc(0), 'vicoop-bridge/publication-public-key/v1', 32));
}

function publicMac(subject: string, x: string, macKey: Buffer) {
  return createHmac('sha256', macKey).update(JSON.stringify([subject, 'OKP', 'Ed25519', x])).digest('base64url');
}

function checkedPublicKey(row: Pick<KeyRow, 'public_x' | 'public_mac'>, subject: string, macKey: Buffer) {
  if (!row.public_x || !/^[\w-]{42}[AEIMQUYcgkosw048]$/.test(row.public_x) || !row.public_mac)
    throw new Error('Invalid publication public key record');
  const expected = Buffer.from(publicMac(subject, row.public_x, macKey));
  const supplied = Buffer.from(row.public_mac);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error('Untrusted publication public key');
  return verificationKey(createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: row.public_x } }));
}

async function sealKey(key: KeyObject, subject: string, wrappingKey: Uint8Array, macKey: Buffer) {
  const { x } = verificationKey(createPublicKey(key));
  if (!x) throw new Error('Missing Ed25519 public key');
  const der = key.export({ format: 'der', type: 'pkcs8' });
  try {
    const envelope = await new CompactEncrypt(der)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: subject }).encrypt(wrappingKey);
    return { envelope, public_x: x, public_mac: publicMac(subject, x, macKey) };
  } finally {
    der.fill(0);
  }
}

async function openKey(row: KeyRow, subject: string, wrappingKey: Uint8Array, macKey: Buffer) {
  if (row.envelope === null) throw new Error('Registration key is revoked');
  const jwk = checkedPublicKey(row, subject, macKey);
  const { protectedHeader, plaintext } = await compactDecrypt(row.envelope, wrappingKey, {
    keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'],
  });
  try {
    if (protectedHeader.kid !== subject) throw new Error('Publication key belongs to another registration');
    const key = createPrivateKey({
      key: Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength), format: 'der', type: 'pkcs8',
    });
    if (verificationKey(createPublicKey(key)).kid !== jwk.kid) throw new Error('Publication key pair mismatch');
    return { key, kid: jwk.kid };
  } finally {
    plaintext.fill(0);
  }
}

export async function rewrapPublicationKey(row: KeyRow, subject: string, oldKey: Uint8Array, newKey: Uint8Array): Promise<KeyRow> {
  if (row.envelope === null) return { envelope: null, public_x: null, public_mac: null };
  const { key } = await openKey(row, subject, oldKey, bindingKey(oldKey));
  return sealKey(key, subject, newKey, bindingKey(newKey));
}

export async function loadRegistrationSigner(db: Sql, wrappingKeyPath: string, publicUrl?: string): Promise<PublicationAuthority> {
  const wrappingKey = readFileSync(wrappingKeyPath);
  if (wrappingKey.length !== 32) throw new Error('Expected a 32-byte publication wrapping key');
  const macKey = bindingKey(wrappingKey);
  const identity = publicationIdentity(publicUrl);
  await initializePublicationControl(db, wrappingKey);

  // Only an authenticated daemon can allocate or open a key. Signing holds the
  // registration and key locks through signature creation and commit.
  async function withRegistrationKey<T>(
    reg: Registration, tokenHash: string, use?: (key: KeyObject, kid: string, subject: string) => T,
  ) {
    const sender = identity(reg);
    if (!sender || !tokenHash) throw new Error('Invalid publication registration');
    return db.begin(async tx => {
      if (!(await publicationEnabled(tx, wrappingKey, true))) throw new Error('Publications are paused');
      const agents = await tx`SELECT 1 FROM agents WHERE id = ${reg.id} AND client_id = ${reg.client_id}
        AND publication_revision = ${reg.publication_revision} AND token_hash = ${tokenHash}
        AND token_hash IS DISTINCT FROM publication_blocked_token_hash FOR NO KEY UPDATE`;
      if (!agents.length) throw new Error('Registration cannot sign');
      const [stored] = await tx<KeyRow[]>`SELECT envelope, public_x, public_mac FROM bridge_private.publication_keys
        WHERE client_id = ${reg.client_id} AND publication_revision = ${reg.publication_revision} FOR UPDATE`;
      if (stored) {
        if (stored.envelope === null) throw new Error('Registration key is revoked');
        if (!use) { checkedPublicKey(stored, sender.id, macKey); return; }
        const { key, kid } = await openKey(stored, sender.id, wrappingKey, macKey);
        return use(key, kid, sender.id);
      }
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const sealed = await sealKey(privateKey, sender.id, wrappingKey, macKey);
      await tx`INSERT INTO bridge_private.publication_keys
        (client_id, publication_revision, envelope, public_x, public_mac)
        VALUES (${reg.client_id}, ${reg.publication_revision}, ${sealed.envelope}, ${sealed.public_x}, ${sealed.public_mac})`;
      return use?.(privateKey, verificationKey(publicKey).kid, sender.id);
    });
  }

  return {
    identity,
    async keysFor(reg) {
      const sender = identity(reg);
      if (!sender) return [];
      return db.begin('isolation level repeatable read read only', async tx => {
        if (!(await publicationEnabled(tx, wrappingKey))) return [];
        const [row] = await tx<Pick<KeyRow, 'public_x' | 'public_mac'>[]>`SELECT k.public_x, k.public_mac
          FROM bridge_private.publication_keys k JOIN agents a USING (client_id, publication_revision)
          WHERE a.id = ${reg.id} AND a.client_id = ${reg.client_id} AND a.publication_revision = ${reg.publication_revision}
            AND a.token_hash IS DISTINCT FROM a.publication_blocked_token_hash AND k.envelope IS NOT NULL`;
        return row ? [checkedPublicKey(row, sender.id, macKey)] : [];
      });
    },
    async prepareRegistration(reg, tokenHash) { await withRegistrationKey(reg, tokenHash); },
    async signRequest(request, reg, tokenHash) {
      const headers = await withRegistrationKey(reg, tokenHash, (key, kid, subject) => signPublication(request, subject, key, kid));
      if (!headers) throw new Error('Registration did not sign');
      return headers;
    },
  };
}
