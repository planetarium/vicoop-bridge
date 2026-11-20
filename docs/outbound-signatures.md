# Signing an outbound publication

A trusted host can send a new JSON POST without an A2A Task. The bridge issues an Ed25519 HTTP Message Signature over the daemon's authenticated WebSocket. The host sends the publication directly to its receiver. Both direct agents and delegated bridge signers use [Web Bot Auth draft-01](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-01.html) with the request-binding rules below.

## Configure keys and the daemon

Bridge holds an independent Ed25519 key for each registration and publication revision. A signing-enabled daemon provisions it on authenticated connection or first signing request. Public discovery reads its authenticated public-key record. The encrypted PKCS#8 private key stays in a private PostgreSQL schema. Bridge holds a separate persistent 32-byte wrapping key. Compromise of a single signing key affects its registration; access to the wrapping key and the encrypted database affects every registration.

Use `VICOOP_OUTBOUND_WRAPPING_KEY_FILE` for the owner-only wrapping-key file. Fly mounts `VICOOP_OUTBOUND_WRAPPING_KEY_B64` there at startup. Existing channel approvals keep the same principal URL during migration. Rename, ownership transfer or re-registration changes that principal. After a transfer, the successor must rotate the daemon token before it can publish. Previously transferred registrations also need a one-time token rotation during migration.

See the [publication key operations runbook](publication-key-operations.md) for deployment verification, per-registration revocation, wrapping-key rotation, and failure recovery.

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

The sender uses the RFC 9421 label `sig1` and sends `Signature-Agent: sig1="https://agents.example/agents/7"`. This URL serves the public JWK Set for one permanent principal. The application requires a canonical, query-free HTTPS principal URL. Use distinct paths for distinct principals, including when several principals delegate to the same bridge key.

Cover `"@method" "@target-uri" "content-type" "content-digest" "signature-agent";key="sig1"` in that order. The last component's value in the signature base is the quoted URL alone. Use the signature parameters shown in the fixture, a 60-second lifetime, a fresh lowercase UUIDv4 nonce, the Ed25519 JWK thumbprint, `alg="ed25519"` and `tag="web-bot-auth"`. Allow five seconds of clock skew. Match the actual target to the publication endpoint configured by the receiver.

At channel approval, resolve the administrator's `acct:local@domain` at that domain's HTTPS WebFinger endpoint. Require the exact JRD subject and one `https://mentionable.dev/ns/rel/publication-identity` link. Store that account and linked URL with the channel grant. During submission, use the requested destination or parent publication to look up the expected active grant in receiver storage. Use the matching signed agent URL to distinguish principals where multiple grants exist. The reference verifier takes that trusted `grant: { address, id }` as input. Require its ID, the current WebFinger href, and the labeled Signature-Agent member to agree. Resolve the linked URL and verify using a public key in its JWK Set whose computed thumbprint matches `keyid`. The account address travels in discovery. The bridge derives the signing URL from its authenticated registration.

The [standalone direct signer](../examples/outbound/sign-direct.mjs) can use its own authorized key. The [example verifier](../examples/outbound/verify.mjs) accepts configured HTTPS origins and a JSON loader. Fetch directly with HTTP 200, no redirects, bounded responses and timeouts. Revalidate current discovery before accepting publication and check the active grant on queued dispatch. Key rotation preserves the URL. Transfer or re-registration requires reapproval for a new URL.

For legacy shared signing, set `VICOOP_OUTBOUND_KEY_FILE` to an Ed25519 private PEM. For rolling key changes in that mode, set `VICOOP_OUTBOUND_PUBLIC_KEYS_FILE` to a JSON array of public PEM strings for overlap. First deploy the next public key on every instance, switch the signing key on all instances while advertising both public keys, then remove the retired key after the last signature acceptance window. The active key is always included. For compromise, remove the affected key from all instances immediately.

Supply an atomic `consumeNonce(id, nonce, retainUntilEpochSeconds)` shared by receiver instances. On a lost response, sign the same message and bytes again. The receiver owns durable deduplication by ID and message ID, destination authorization and reply permissions.

The [public test vectors](../examples/outbound/fixture.json) provide WebFinger, the JWK Set, a channel grant, exact signature bases, and valid direct/delegated signatures produced independently with OpenSSL. They include invalid body, target, identity and signature-label cases. Use the fixture time for offline verification. Upgrade the server and daemon together for signing and use a receiver implementing this profile.
