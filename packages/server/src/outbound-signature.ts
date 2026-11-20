import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OutboundRequest, OutboundHeaders } from '@vicoop-bridge/protocol';
import { isValidMentionableLocal } from './mentionable.js';

export const PUBLICATION_IDENTITY_REL = 'https://mentionable.dev/ns/rel/publication-identity';
type Registration = { id: string; client_id: string; owner_revision: string };

function verificationKey(key: KeyObject) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 publication key');
  const { crv, kty, x } = key.export({ format: 'jwk' });
  // RFC 8037 Appendix A.3: lexicographic ordering of the required public members.
  const kid = createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
  return { crv, kty, x, kid };
}

function isPublicationLocal(local: string) {
  return isValidMentionableLocal(local) && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(local);
}

export function loadOutboundSigner(path: string, publicUrl?: string, publicKeysPath?: string) {
  if (!publicUrl) throw new Error('Publication signing requires PUBLIC_URL');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.port || (publicUrl !== url.origin && publicUrl !== url.origin + '/') ||
      !url.hostname.includes('.')) throw new Error('Publication signing requires a canonical HTTPS PUBLIC_URL origin');
  const key = createPrivateKey(readFileSync(path));
  const active = verificationKey(createPublicKey(key));
  const keys = new Map([[active.kid, active]]);
  if (publicKeysPath) {
    const pems: unknown = JSON.parse(readFileSync(publicKeysPath, 'utf8'));
    if (!Array.isArray(pems)) throw new Error('Expected a JSON array of public PEM keys');
    for (const pem of pems) {
      if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Expected public PEM');
      const jwk = verificationKey(createPublicKey(pem));
      keys.set(jwk.kid, jwk);
    }
  }

  function identity(reg: Registration) {
    const address = 'acct:' + reg.id + '@' + url.hostname;
    if (!isPublicationLocal(reg.id) || address.slice(4).length > 256) return undefined;
    const epoch = createHash('sha256').update(JSON.stringify([reg.id, reg.client_id, reg.owner_revision])).digest('base64url');
    return { address,
      id: url.origin + '/publication-identities/' + reg.id + '/' + epoch };
  }

  function signRequest(request: OutboundRequest, registration: Registration): OutboundHeaders {
    const sender = identity(registration);
    if (!sender) throw new Error('Agent has no publishable account address');
    const created = Math.floor(Date.now() / 1000);
    const digest = 'sha-256=:' + request.digest + ':';
    const member = '"' + sender.id + '"';
    const components = '("@method" "@target-uri" "content-type" "content-digest" "signature-agent";key="sig1")';
    const params = components + ';created=' + created + ';expires=' + (created + 60) +
      ';nonce="' + randomUUID() + '";keyid="' + active.kid + '";alg="ed25519";tag="web-bot-auth"';
    const base = [
      '"@method": POST', '"@target-uri": ' + request.target, '"content-type": application/json',
      '"content-digest": ' + digest, '"signature-agent";key="sig1": ' + member,
      '"@signature-params": ' + params,
    ].join('\n');
    return {
      'content-type': 'application/json', 'content-digest': digest,
      'signature-agent': 'sig1=' + member, 'signature-input': 'sig1=' + params,
      signature: 'sig1=:' + sign(null, Buffer.from(base), key).toString('base64') + ':',
    };
  }
  return { signRequest, identity, keys: [...keys.values()] };
}
