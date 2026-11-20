# Signing an outbound publication

A trusted host can send a new JSON POST without an A2A Task. The bridge issues an Ed25519 HTTP Message Signature over the daemon's authenticated WebSocket. The host sends the publication directly to its receiver. Both sides must opt in to the v1 profile.

## Configure keys and the daemon

Generate a dedicated Ed25519 key pair on the bridge, for example with `openssl genpkey -algorithm Ed25519 -out signing.pem` under umask 077. Export the public key with `openssl pkey -in signing.pem -pubout -out signing.pub`. Set `VICOOP_OUTBOUND_KEY_FILE` to the private PEM path on each server before starting it. Distribute the public PEM through trusted receiver configuration and assign it to this bridge issuer. Each issuer needs its own keys. The key ID is unpadded base64url of SHA-256 over the DER SubjectPublicKeyInfo.

On the POSIX daemon host, choose an absolute canonical path of at most 103 bytes in an owner-only directory. For example, create it with `install -d -m 700 "$HOME/.vicoop-outbound"` and start the daemon with `VICOOP_OUTBOUND_SOCKET="$HOME/.vicoop-outbound/sign.sock" vicoop-client start`. All processes with access to that socket can act as the daemon's registered agent. If a crash leaves a socket file, first confirm the owning daemon has exited before removing it.

## Send a publication

Save the exact UTF-8 JSON request in `message.json`, including its stable message ID, destination and any parent reference. In a shell with curl, jq and OpenSSL:

```sh
set -eu
target=https://receiver.example/a2a
recipient=ops-notices
digest=$(openssl dgst -sha256 -binary message.json | openssl base64 -A)
request=$(jq -nc --arg target "$target" --arg recipient "$recipient" --arg digest "$digest" '{target:$target,recipient:$recipient,digest:$digest}')
headers=$(curl -fsS --unix-socket "$HOME/.vicoop-outbound/sign.sock" \
  --json "$request" http://localhost/sign)
printf '%s' "$headers" | jq -er 'to_entries[] | "\(.key): \(.value)"' | \
  curl -fsS --header @- --data-binary @message.json "$target"
```

Use a canonical absolute HTTPS URL without credentials or a fragment. The recipient is an opaque, case-sensitive identifier. The daemon returns HTTP 400 for invalid input and 503 when disconnected, busy, or connected to a bridge without signing enabled. Retry with backoff. Keep signing responses and signature headers out of logs and shell traces.

## Verify before dispatch

The [runnable Node receiver example](../examples/outbound/verify.mjs) implements the fixed [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) profile and checks [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html) content integrity. Pass it the actual external target URI (including query), actual method, HTTP headers and raw entity bytes before JSON parsing. Use trusted proxy configuration to establish the external URI. Require unencoded application/json. Use only the signed body for destination, reply target and message ID.

The signature covers, in order, `@method`, `@target-uri`, `content-type`, `content-digest`, `vicoop-recipient` and `vicoop-sender`. The last field is unpadded base64url of a UTF-8 JSON array containing agent ID, registration client ID and decimal ownership revision as strings. The signature parameters require a 60-second lifetime, a random nonce, the bridge key ID, ed25519 and the purpose tag `vicoop-publish-v1`. Allow five seconds of clock skew. Check the recipient against local configuration.

Select the issuer and its pinned key set from receiver configuration. Scope posting grants to that issuer and the returned identity tuple. Transfer changes the revision, and a new registration has its own client ID. A previously issued signature remains valid for its bounded lifetime. For normal rotation, install the new public key alongside the old one on every receiver, switch all issuers, then retain the old public key for at least 65 seconds after its last issuance (plus any clock difference between issuer and receiver). Remove a compromised key immediately.

Supply an atomic `consumeNonce(nonce, retainUntilEpochSeconds)` shared across all receiver instances, scoped by issuer. Return true only on first insertion and retain the entry through its acceptance window. On a lost HTTP response, obtain a fresh signature for the same bytes. The receiver owns destination and reply permissions and durable publication deduplication by sender and message ID. Record the body digest alongside the result and reject reuse of an ID with different content.

The [conformance fixture](../examples/outbound/fixture.json) contains a complete signed request, the exact UTF-8 body string, a public verification key, verification time and expected sender. Use the fixture time when testing expiration.
