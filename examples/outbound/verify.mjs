// Reference receiver for the fixed v1 profile in docs/outbound-signatures.md.
// Use the actual method, external target URI, raw body and incoming Headers.
// Supply the public keys for ONE locally configured, trusted issuer.
import { createHash, createPublicKey, verify } from 'node:crypto';

export function trustedKeys(pems) {
  return new Map(pems.map(pem => {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 public key');
    const kid = createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('base64url');
    return [kid, key];
  }));
}

const components = '("@method" "@target-uri" "content-type" "content-digest" "vicoop-recipient" "vicoop-sender")';
const paramsPattern = /^;created=(\d{1,12});expires=(\d{1,12});nonce="([0-9a-f-]{36})";keyid="([\w-]{43})";alg="ed25519";tag="vicoop-publish-v1"$/;

export async function verifyPublication({ method, url, headers, body }, { recipient, keys, consumeNonce, now = Math.floor(Date.now() / 1000) }) {
  function check(ok) { if (!ok) throw new Error('Invalid outbound publication'); }
  check(method === 'POST' && !headers.has('content-encoding') && headers.get('content-type') === 'application/json');
  check(headers.get('vicoop-recipient') === recipient);
  const digest = 'sha-256=:' + createHash('sha256').update(body).digest('base64') + ':';
  check(headers.get('content-digest') === digest);
  const input = headers.get('signature-input') ?? '';
  check(input.startsWith('sig1=' + components));
  const params = input.slice(5);
  const match = paramsPattern.exec(params.slice(components.length));
  check(match);
  const [, created, expires, nonce, kid] = match;
  check(Number(expires) === Number(created) + 60 && Number(created) <= now + 5 && now < Number(expires) + 5);
  const key = keys.get(kid);
  const sig = /^sig1=:([A-Za-z0-9+/]{86}==):$/.exec(headers.get('signature') ?? '');
  check(key && sig);
  const sender = headers.get('vicoop-sender');
  check(sender && sender.length <= 8192 && /^[A-Za-z0-9_-]+$/.test(sender));
  const base = [
    '"@method": ' + method, '"@target-uri": ' + url, '"content-type": application/json',
    '"content-digest": ' + digest, '"vicoop-recipient": ' + recipient, '"vicoop-sender": ' + sender,
    '"@signature-params": ' + params,
  ].join('\n');
  check(verify(null, Buffer.from(base), key, Buffer.from(sig[1], 'base64')));
  const identity = JSON.parse(Buffer.from(sender, 'base64url').toString('utf8'));
  check(Array.isArray(identity) && identity.length === 3 && identity.every(x => typeof x === 'string' && x.length));
  check(await consumeNonce(nonce, Number(expires) + 5));
  return { agentId: identity[0], clientId: identity[1], ownerRevision: identity[2] };
}
