// Validate a pinned receiver grant without publishing a message. Run on the
// daemon host with --socket to also check signing through the actual daemon.
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyPublication } from './verify.mjs';

const relation = 'https://mentionable.dev/ns/rel/publication-identity';
const endpoint = 'https://publication-check.invalid/probe';
const body = Buffer.from('{"check":"publication-signing"}');

async function getDocument(url) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, 'Public discovery request failed');
  return response.json();
}

async function requestSignature(socketPath) {
  const digest = createHash('sha256').update(body).digest('base64');
  const input = JSON.stringify({ target: endpoint, digest });
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/sign', method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(input) } }, async res => {
      try {
        assert.equal(res.statusCode, 200, 'Daemon signing failed');
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
          size += chunk.length;
          assert.ok(size <= 8192, 'Oversize signing response');
          chunks.push(chunk);
        }
        resolve(new Headers(JSON.parse(Buffer.concat(chunks).toString())));
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on('error', reject);
    req.end(input);
  });
}

export async function checkPublication(options, read = getDocument, sign = requestSignature) {
  const { address, subject, socket, absent } = options;
  const account = /^acct:([^@\s]+)@([a-z0-9.-]+)$/.exec(address);
  assert.ok(account, 'Supply the canonical acct: address');
  const origin = 'https://' + account[2];
  const id = new URL(subject);
  assert.ok(id.origin === origin && id.href === subject && !id.search && !id.hash && !id.username && !id.password,
    'Expected the previously approved canonical Bridge subject URL');
  const discovery = new URL('/.well-known/webfinger', origin);
  discovery.searchParams.set('resource', address);
  // The fixed bytes and reserved .invalid target make this safe to sign even
  // when an operator is checking a production daemon. No POST leaves the host.
  const headers = socket && !absent ? await sign(socket) : undefined;
  const jrd = await read(discovery.href);
  if (jrd) assert.equal(jrd.subject, address, 'Unexpected WebFinger account');
  const links = jrd ? jrd.links.filter(link => link.rel === relation) : [];
  if (absent) {
    assert.ok(!socket, 'Use --absent without --socket');
    assert.equal(links.length, 0, 'Publication identity is still advertised');
    assert.equal(await read(subject), null, 'Previously approved public key URL is still live');
    return;
  }
  assert.equal(links.length, 1, 'Missing or ambiguous publication identity');
  assert.equal(links[0].href, subject, 'Publication subject no longer matches the grant');
  const directory = await read(subject);
  assert.equal(directory?.keys?.length, 1, 'Expected exactly one registration key');
  const key = directory.keys[0];
  assert.ok(key.kty === 'OKP' && key.crv === 'Ed25519' && !('d' in key), 'Invalid public Ed25519 key');
  const { crv, kty, x } = createPublicKey({ key, format: 'jwk' }).export({ format: 'jwk' });
  const kid = createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
  assert.equal(key.kid, kid, 'Wrong public-key thumbprint');
  assert.ok(!options['deny-kid']?.includes(kid), 'Retired signing key is still advertised');
  if (headers) {
    await verifyPublication({ method: 'POST', url: endpoint, headers, body }, {
      endpoint, grant: { address, id: subject }, allowedOrigins: new Set([origin]), loadJson: read, consumeNonce: () => true,
    });
  }
  return kid;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    address: { type: 'string' }, subject: { type: 'string' }, socket: { type: 'string' },
    'deny-kid': { type: 'string', multiple: true }, absent: { type: 'boolean' },
  } });
  try {
    const kid = await checkPublication(values);
    console.log(kid ? `Verified ${values.address} (${kid})` : `Publication disabled for ${values.address}`);
  } catch (err) {
    console.error('Publication check failed:', err.message);
    process.exitCode = 1;
  }
}
