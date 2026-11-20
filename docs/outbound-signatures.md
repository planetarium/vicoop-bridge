# Signing an outbound publication

A trusted host can send a new JSON POST without an A2A Task. The bridge issues an Ed25519 HTTP Message Signature over the daemon's authenticated WebSocket. The host sends the publication directly to its receiver. Both direct agents and delegated bridge signers use the mentionable-publication-v1 profile.

## Configure keys and the daemon

Generate a dedicated Ed25519 key pair on the bridge, for example with `openssl genpkey -algorithm Ed25519 -out signing.pem` under umask 077. Export the public key with `openssl pkey -in signing.pem -pubout -out signing.pub`. Set `VICOOP_OUTBOUND_KEY_FILE` to the private PEM path on each server before starting it. Set PUBLIC_URL to the canonical HTTPS address-domain origin (default port). The bridge serves WebFinger and the public verification keys there. Each issuer needs its own keys. The key ID is unpadded base64url of SHA-256 over the DER SubjectPublicKeyInfo.

On the POSIX daemon host, choose an absolute canonical path of at most 103 bytes in an owner-only directory. For example, create it with `install -d -m 700 "$HOME/.vicoop-outbound"` and start the daemon with `VICOOP_OUTBOUND_SOCKET="$HOME/.vicoop-outbound/sign.sock" vicoop-client start`. All processes with access to that socket can act as the daemon's registered agent. If a crash leaves a socket file, first confirm the owning daemon has exited before removing it.

## Send a publication

Save the exact UTF-8 JSON request in `message.json`, including its stable message ID, destination and any parent reference. In a shell with curl, jq and OpenSSL:

```sh
set -eu
target=https://connector.example/api/publications
digest=$(openssl dgst -sha256 -binary message.json | openssl base64 -A)
request=$(jq -nc --arg target "$target" --arg digest "$digest" '{target:$target,digest:$digest}')
headers=$(curl -fsS --unix-socket "$HOME/.vicoop-outbound/sign.sock" \
  --json "$request" http://localhost/sign)
printf '%s' "$headers" | jq -er 'to_entries[] | "\(.key): \(.value)"' | \
  curl -fsS --header @- -H 'A2A-Version: 1.0' \
    -H 'A2A-Extensions: https://mentionable.dev/ns/publication/v0.1' --data-binary @message.json "$target"
```

Use a canonical absolute HTTPS URL without credentials or a fragment. The exact target URI identifies the recipient. The daemon returns HTTP 400 for invalid input and 503 when disconnected, busy, or connected to a bridge without signing enabled. Retry with backoff. Keep signing responses and signature headers out of logs and shell traces.

## Verify before dispatch

The [runnable Node receiver example](../examples/outbound/verify.mjs) implements the fixed [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) profile and checks [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html) content integrity. Pass it the actual external target URI (including query), actual method, HTTP headers and raw entity bytes before JSON parsing. Use trusted proxy configuration to establish the external URI. Require unencoded application/json. Use only the signed body for destination, reply target and message ID.

The signature covers, in order, `@method`, `@target-uri`, `content-type`, `content-digest`, `mentionable-agent` (canonical `@local@domain`) and `mentionable-subject` (a non-reassigned HTTPS URI). Use the exact serialized signature parameters shown in the fixture, with a 60-second lifetime, a fresh lowercase UUIDv4 nonce, key ID, Ed25519 and tag `mentionable-publication-v1`. Allow five seconds of clock skew. The receiver must match the target to its configured public endpoint.

Resolve the signed address at its own HTTPS WebFinger endpoint and require the exact JRD subject `acct:local@domain`. Its single `https://mentionable.dev/ns/rel/publication-identity` link points to the current agent ID. Dereferencing that explicitly linked HTTPS ID yields a document with the same `id` and public JWKs in `keys`. Verify with the matching key from that document. A direct host can use the [standalone Node signer](../examples/outbound/sign-direct.mjs) with its own key; an address authority that delegates signing to a bridge publishes the bridge key for that specific ID. The bridge serves discovery only for registrations on its own domain. The bridge derives the ID from its registration and ownership epoch. Transfers and new registrations get a different ID and require new receiver grants. Key rotation preserves the ID.

The [example verifier](../examples/outbound/verify.mjs) takes a set of trusted HTTPS origins and a JSON loader. Use trusted origins even when accepting direct signers. Configure the loader for HTTPS, no redirects, bounded responses and timeouts. Fetch current discovery on each verification and fail closed on errors. Grant and authorize by the verified ID. On queued dispatch and retries, recheck the current address-to-ID binding and active grant.

For rolling key changes, set `VICOOP_OUTBOUND_PUBLIC_KEYS_FILE` to a JSON array of public PEM strings for overlap. First deploy the next public key on every instance, switch the signing key on all instances while advertising both public keys, then remove the retired key after the last signature acceptance window. The active key is always included. For compromise, remove the affected key from all instances immediately.

Supply an atomic `consumeNonce(id, nonce, retainUntilEpochSeconds)` shared by receiver instances. On a lost response, sign the same message and bytes again. The receiver owns durable deduplication by ID and message ID, destination authorization and reply permissions.

The [public test vectors](../examples/outbound/fixture.json) are copied from the [Mentionable conformance fixture](https://github.com/planetarium/mentionable/blob/f5caea5/docs/spec/fixtures/publication-http-signature.json) and include valid requests and tampering cases. Use the fixture time for offline verification. Upgrade the server and daemon together for signing and use a receiver implementing this profile.
