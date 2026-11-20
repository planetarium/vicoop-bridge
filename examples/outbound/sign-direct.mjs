// Direct signer for an account whose domain has published this public key
// in the current agent identity document. Returns headers for the given bytes.
import { createHash, createPublicKey, randomUUID, sign } from 'node:crypto';

export function signDirect({ id, endpoint, body, privateKey }) {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Expected Ed25519 key');
  }
  const url = new URL(id);
  if (url.protocol !== 'https:' || url.href !== id || url.username || url.password ||
      id.length > 2048 || /[?#"\\]/.test(id)) throw new Error('Expected canonical HTTPS publication ID');
  const { crv, kty, x } = createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
  const digest = 'sha-256=:' + createHash('sha256').update(body).digest('base64') + ':';
  const fields = {
    '"@method"': 'POST', '"@target-uri"': endpoint, '"content-type"': 'application/json',
    '"content-digest"': digest, '"signature-agent";key="sig1"': '"' + id + '"',
  };
  const covered = Object.keys(fields).join(' ');
  const created = Math.floor(Date.now() / 1000);
  const params = '(' + covered + ');created=' + created + ';expires=' + (created + 60) +
    ';nonce="' + randomUUID() + '";keyid="' + kid +
    '";alg="ed25519";tag="web-bot-auth"';
  const lines = Object.entries(fields).map(([name, value]) => name + ': ' + value);
  lines.push('"@signature-params": ' + params);
  const signature = sign(null, Buffer.from(lines.join('\n')), privateKey);
  return new Headers({
    'content-type': 'application/json', 'content-digest': digest, 'signature-agent': 'sig1="' + id + '"', 'signature-input': 'sig1=' + params,
    signature: 'sig1=:' + signature.toString('base64') + ':',
  });
}
