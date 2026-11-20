import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OutboundRequest, OutboundHeaders } from '@vicoop-bridge/protocol';

export function loadOutboundSigner(path: string) {
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 outbound key');
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const kid = createHash('sha256').update(spki).digest('base64url');
  return (request: OutboundRequest, registration: { id: string; client_id: string; owner_revision: string }): OutboundHeaders => {
    const sender = Buffer.from(JSON.stringify([registration.id, registration.client_id, registration.owner_revision])).toString('base64url');
    if (sender.length > 8192) throw new Error('Sender exceeds profile limit');
    const created = Math.floor(Date.now() / 1000);
    const digest = 'sha-256=:' + request.digest + ':';
    const fields = [
      ['@method', 'POST'], ['@target-uri', request.target], ['content-type', 'application/json'],
      ['content-digest', digest], ['vicoop-recipient', request.recipient], ['vicoop-sender', sender],
    ];
    const covered = fields.map(([name]) => '"' + name + '"').join(' ');
    const params = '(' + covered + ');created=' + created + ';expires=' + (created + 60) +
      ';nonce="' + randomUUID() + '";keyid="' + kid + '";alg="ed25519";tag="vicoop-publish-v1"';
    const base = [...fields, ['@signature-params', params]].map(([k, v]) => '"' + k + '": ' + v).join('\n');
    return {
      'content-type': 'application/json', 'content-digest': digest, 'vicoop-sender': sender,
      'vicoop-recipient': request.recipient, 'signature-input': 'sig1=' + params,
      signature: 'sig1=:' + sign(null, Buffer.from(base), key).toString('base64') + ':',
    };
  };
}
