// Direct signer for an account whose domain has published this public key
// in the current agent identity document. Returns headers for the given bytes.
import { createHash, randomBytes, sign } from 'node:crypto';

export function signDirect({ address, id, endpoint, body, privateKey, kid }) {
  if (privateKey.asymmetricKeyType !== 'ed25519' || !/^[\w-]{1,128}$/.test(kid)) {
    throw new Error('Expected Ed25519 key and a publication key ID');
  }
  const digest = 'sha-256=:' + createHash('sha256').update(body).digest('base64') + ':';
  const fields = {
    '@method': 'POST', '@target-uri': endpoint, 'content-type': 'application/json',
    'content-digest': digest, 'publication-address': address, 'publication-agent-id': id,
  };
  const covered = Object.keys(fields).map(name => '"' + name + '"').join(' ');
  const created = Math.floor(Date.now() / 1000);
  const params = '(' + covered + ');created=' + created + ';expires=' + (created + 60) +
    ';nonce="' + randomBytes(18).toString('base64url') + '";keyid="' + kid +
    '";alg="ed25519";tag="agent-publication-v1"';
  const lines = Object.entries(fields).map(([name, value]) => '"' + name + '": ' + value);
  lines.push('"@signature-params": ' + params);
  const signature = sign(null, Buffer.from(lines.join('\n')), privateKey);
  return new Headers({
    'content-type': 'application/json', 'content-digest': digest, 'publication-address': address,
    'publication-agent-id': id, 'signature-input': 'sig1=' + params,
    signature: 'sig1=:' + signature.toString('base64') + ':',
  });
}
