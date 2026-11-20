// Reference receiver. allowedOrigins comes from receiver configuration.
// loadJson must fetch the supplied HTTPS URL without redirects or stale caching.
import { createHash, createPublicKey, verify } from 'node:crypto';

const relation = 'https://mentionable.dev/ns/rel/publication-identity';
const components = '("@method" "@target-uri" "content-type" "content-digest" "signature-agent";key="sig1")';
const paramsPattern = /^;created=(0|[1-9]\d{0,11});expires=(0|[1-9]\d{0,11});nonce="([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";keyid="([\w-]{43})";alg="ed25519";tag="web-bot-auth"$/;

function check(ok) { if (!ok) throw new Error('Invalid publication'); }

export async function verifyPublication({ method, url, headers, body }, {
  endpoint, grant, allowedOrigins, loadJson, consumeNonce, now = Math.floor(Date.now() / 1000),
}) {
  check(method === 'POST' && url === endpoint && !headers.has('content-encoding') &&
    headers.get('content-type') === 'application/json');
  const digest = 'sha-256=:' + createHash('sha256').update(body).digest('base64') + ':';
  check(headers.get('content-digest') === digest);
  const input = headers.get('signature-input') ?? '';
  check(input.startsWith('sig1=' + components));
  const params = input.slice(5);
  const match = paramsPattern.exec(params.slice(components.length));
  check(match);
  const [, created, expires, nonce, kid] = match;
  check(Number(expires) === Number(created) + 60 && Number(created) <= now + 5 && now < Number(expires) + 5);
  const signature = /^sig1=:([A-Za-z0-9+/]{86}==):$/.exec(headers.get('signature') ?? '');
  check(signature && Buffer.from(signature[1], 'base64').toString('base64') === signature[1]);
  // The application looks up the destination or reply grant in its own store.
  // Only trust the address/ID from that grant, even for keys shared across agents.
  const { address, id } = grant;
  check(typeof id === 'string' && headers.get('signature-agent') === 'sig1="' + id + '"');
  const account = /^acct:([^@\s]+)@([a-z0-9._-]+)$/.exec(address);
  check(account);
  const origin = 'https://' + account[2];
  check(allowedOrigins.has(origin));
  const jrdUrl = new URL('/.well-known/webfinger', origin);
  jrdUrl.searchParams.set('resource', address);
  const jrd = await loadJson(jrdUrl.href);
  check(jrd.subject === address && Array.isArray(jrd.links));
  const links = jrd.links.filter(link => link.rel === relation);
  check(links.length === 1 && links[0].href === id);
  const identityUrl = new URL(id);
  check(identityUrl.protocol === 'https:' && allowedOrigins.has(identityUrl.origin) && id.length <= 2048 && !identityUrl.username && !identityUrl.password &&
    !/[?#"\\]/.test(id) && identityUrl.href === id);
  const doc = await loadJson(id);
  check(Array.isArray(doc.keys));
  const keys = new Map();
  for (const jwk of doc.keys) {
    check(jwk && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && !('d' in jwk) &&
      typeof jwk.x === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(jwk.x) &&
      (jwk.use === undefined || jwk.use === 'sig') &&
      (jwk.alg === undefined || ['EdDSA', 'Ed25519'].includes(jwk.alg)) &&
      (jwk.key_ops === undefined || (Array.isArray(jwk.key_ops) && jwk.key_ops.length === 1 && jwk.key_ops[0] === 'verify')));
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    const { crv, kty, x } = jwk;
    const fingerprint = createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
    check(!keys.has(fingerprint));
    keys.set(fingerprint, key);
  }
  const key = keys.get(kid);
  check(key);
  const base = [
    '"@method": POST', '"@target-uri": ' + url, '"content-type": application/json',
    '"content-digest": ' + digest, '"signature-agent";key="sig1": "' + id + '"',
    '"@signature-params": ' + params,
  ].join('\n');
  check(verify(null, Buffer.from(base), key, Buffer.from(signature[1], 'base64')));
  check(await consumeNonce(id, nonce, Number(expires) + 5));
  return { address, id };
}
