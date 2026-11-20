// Reference receiver. allowedOrigins comes from receiver configuration.
// loadJson must fetch the supplied HTTPS URL without redirects or stale caching.
import { createHash, createPublicKey, verify } from 'node:crypto';

const relation = 'https://mentionable.dev/ns/publication/identity';
const components = '("@method" "@target-uri" "content-type" "content-digest" "publication-address" "publication-agent-id")';
const paramsPattern = /^;created=(\d{1,12});expires=(\d{1,12});nonce="([\w-]{22,128})";keyid="([\w-]{1,128})";alg="ed25519";tag="agent-publication-v1"$/;

function check(ok) { if (!ok) throw new Error('Invalid publication'); }

export async function verifyPublication({ method, url, headers, body }, {
  endpoint, allowedOrigins, loadJson, consumeNonce, now = Math.floor(Date.now() / 1000),
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
  check(signature);
  const address = headers.get('publication-address');
  const id = headers.get('publication-agent-id');
  const account = /^acct:([^@\s]+)@([a-z0-9.-]+)$/.exec(address ?? '');
  check(account);
  const origin = 'https://' + account[2];
  check(allowedOrigins.has(origin));
  const jrdUrl = new URL('/.well-known/webfinger', origin);
  jrdUrl.searchParams.set('resource', address);
  const jrd = await loadJson(jrdUrl.href);
  check(jrd.subject === address && Array.isArray(jrd.links));
  const links = jrd.links.filter(link => link.rel === relation);
  check(links.length === 1 && links[0].href === id && links[0].type === 'application/json');
  const identityUrl = new URL(id);
  check(identityUrl.origin === origin && !identityUrl.username && !identityUrl.password &&
    !identityUrl.hash && identityUrl.href === id);
  const doc = await loadJson(id);
  check(doc.id === id && Array.isArray(doc.keys));
  const keys = doc.keys.filter(key => key.kid === kid);
  check(keys.length === 1 && keys[0].kty === 'OKP' && keys[0].crv === 'Ed25519' && !('d' in keys[0]));
  const base = [
    '"@method": POST', '"@target-uri": ' + url, '"content-type": application/json',
    '"content-digest": ' + digest, '"publication-address": ' + address, '"publication-agent-id": ' + id,
    '"@signature-params": ' + params,
  ].join('\n');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  check(verify(null, Buffer.from(base), key, Buffer.from(signature[1], 'base64')));
  check(await consumeNonce(id, nonce, Number(expires) + 5));
  return { address, id };
}
