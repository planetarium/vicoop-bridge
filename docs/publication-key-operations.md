# Operating Bridge publication keys

## Deploy and verify

Preserve the canonical `PUBLIC_URL`. Back up the full database (including `bridge_private`) and escrow the raw 32-byte wrapping key in a separately access-controlled secret store. Test restoration in an isolated database. A digest in the Fly dashboard cannot recover a key. Keep key material out of shell arguments, command history and logs.

At first deployment set the Fly secret from the escrowed key. Re-use that version for later deployments.

```sh
(printf 'VICOOP_OUTBOUND_WRAPPING_KEY_B64='; openssl base64 -A -in "$WRAPPING_KEY_FILE"; printf '\n') |
  fly secrets import --stage -a vicoop-bridge-server
```

Startup validates the database's wrapping-key verifier before serving. The deploy workflow also reads the approved operations agent's WebFinger record and JWK Set after its signing-enabled daemon reconnects. It pins the approved subject and rejects the retired shared key. When this agent's registration changes, update the pin after a fresh channel approval. During an intentional pause, the normal publication check must fail.

CI checks public discovery. Before signing off a production cutover, run the end-to-end check from a current checkout on the authorized daemon host. Use the account and subject independently recorded with its grant, and the socket of that registration. The probe signs inert bytes for a reserved `.invalid` target and verifies the signature locally against live public discovery. It sends no external POST.

```sh
node examples/outbound/check-publication.mjs --address "$ACCOUNT" --subject "$APPROVED_SUBJECT" --socket "$SIGNING_SOCKET"
```

After migration, retire the shared Fly secret and remove its file mapping from any other deployment configuration. A request signed just before cutover can receive HTTP 403. Retry the same saved bytes and message ID with a fresh signature. The current daily report runner needs a manual retry in that case.

## Database roles

With separate `DB_SETUP_URL` and `DATABASE_URL`, apply the schema using the setup role. As the database owner, grant the Bridge runtime login the following additional privileges (replace `bridge_runtime` with the trusted service login). The existing privileges on `agents` must permit token lookup and row locking. PostGraphile's anonymous and authenticated API roles must have no access to the private schema. The CLI recovery commands require a separate administrative database connection.

```sql
GRANT USAGE ON SCHEMA bridge_private TO bridge_runtime;
GRANT SELECT, INSERT (client_id, publication_revision, envelope, public_x, public_mac),
  UPDATE (public_mac) ON bridge_private.publication_keys TO bridge_runtime;
GRANT SELECT, INSERT (singleton, wrapping_tag), UPDATE (singleton)
  ON bridge_private.publication_control TO bridge_runtime;
```

The column updates permit PostgreSQL row locks. If the setup role initialized the control row with the correct wrapping key, the runtime can omit the control INSERT grant.

## Revoke or rotate one registration

Keep an independent change record with the registration ID, publication revision, address, owner, token rotation status, key fingerprint, channel grant and revocation time. Back up changes to the issued-ID ledger, including deleted registrations. Use a current, trusted inventory for recovery.

To revoke, set the following `psql` variables from that inventory. The statement locks the live registration and creates a tombstone even if the daemon has never requested a key. Check that exactly one row was affected.

```sql
INSERT INTO bridge_private.publication_keys (client_id, publication_revision)
SELECT a.client_id, a.publication_revision FROM agents a
WHERE a.client_id=:'client_id' AND a.publication_revision=:'revision'::bigint AND a.id=:'agent_id'
FOR NO KEY UPDATE
ON CONFLICT (client_id, publication_revision) DO UPDATE
SET envelope=NULL, public_x=NULL, public_mac=NULL;
```

Verify the grant's previous key URL returns 404 and WebFinger omits the publication relation. If accepted messages waiting for delivery must also be stopped, revoke the channel grant in Mentionable. Key revocation governs future discovery and verification; connector delivery after acceptance is controlled by the channel grant.

For routine key rotation, delete only the matching **active** key row. The next authenticated sign provisions a fresh key under the same subject. Confirm the new key using the daemon probe with `--deny-kid "$OLD_KID"`. Deleting a tombstone explicitly enables signing again and requires separate authorization.

```sql
DELETE FROM bridge_private.publication_keys
WHERE client_id=:'client_id' AND publication_revision=:'revision'::bigint AND envelope IS NOT NULL;
```

## Rotate the wrapping key

1. Pause new signing and discovery on the current implementation with `UPDATE bridge_private.publication_control SET paused=true WHERE singleton RETURNING paused`. Confirm one row was updated. Quiesce all server instances, database writers, automated deployments and in-flight verification. Preserve the current database backup and key under separate custody.
2. Generate and escrow a fresh 32-byte raw key. Using an administrative `DATABASE_URL` on the isolated management host, run the rewrap command below. It validates the old wrapping key and migrates the envelopes, public-key bindings and verifier in one transaction. Failure rolls the transaction back. Success leaves the database paused.
3. Install the new secret on every instance. Keep the wrapping key whose version matches each retained backup. Start the current server while paused and check that the previous key URL is inaccessible. Explicitly unpause, then verify the existing approved subject with the no-post daemon probe. An unchanged signing key keeps the same fingerprint. If an attacker could have recovered signing keys, rotate or revoke those keys as well.

```sh
pnpm --filter @vicoop-bridge/server exec tsx scripts/rewrap-publications.ts "$OLD_KEY_FILE" "$NEW_KEY_FILE"
```

## Roll back, restore a database, or recover from key loss

A restored snapshot can contain a retired key, stale daemon credential, obsolete principal generation, or a previously revoked grant. A pre-migration binary ignores the database pause and tombstones. Rolling back an image **with its previous Fly configuration** can immediately expose the old shared key for every approved subject.

1. Freeze automated deployments. Before restoring any database or starting an older binary, stop all serving instances and block public ingress, or deploy and verify a signing-disabled recovery configuration **outside the database**. Remove both signing-file environment settings (`VICOOP_OUTBOUND_WRAPPING_KEY_FILE`, `VICOOP_OUTBOUND_KEY_FILE`), the legacy public-key overlap setting and the corresponding Fly file mappings/secrets from the recovery deployment. An old image may be used only with this signing-disabled configuration. Close outstanding signed-request windows and control queued delivery at the receiver. Verify absence using the command below when a recovery server is reachable. Keep all writers quiesced for the isolated recovery work.
2. Restore the backup into isolation, apply the current schema and set `paused=true` on its singleton. A missing singleton on a pre-cutover restore requires the explicit replacement-key form below. Quarantine **all** restored keys before reopening signing. The quarantine command destroys their stored key material, adds tombstones for registrations that had no key at snapshot time and leaves the authority paused. With an unavailable or compromised wrapping key, provide a freshly generated, separately escrowed 32-byte key. This repins the database atomically after discarding its old key material.
3. Reconcile the latest external change record and Mentionable's channel grants against the restored owners, registrations, epochs, token rotations and revocations. Restore the complete issued-ID ledger. For registrations with uncertain ownership, token history or generation, keep them disabled, revoke stale connector grants, retire the old registration and create a fresh one with a fresh token, subject and channel approval. Finish reconciliation of old identities before allowing registration or ownership mutations. An incomplete recovery inventory requires keeping publication disabled.
4. Enable only reviewed registrations. While still offline, delete the exact tombstone for an independently verified registration and revision. Verify the owner still controls the current credential or rotate the daemon token. All other restored registrations retain tombstones. Deploy the current registration-signing build with the verified wrapping key, initially paused. Confirm WebFinger omits the publication relation and every former subject tested returns 404.
5. After operator sign-off, run `UPDATE bridge_private.publication_control SET paused=false WHERE singleton AND paused RETURNING paused`. Reconnect authorized daemons or request a no-post signature to provision fresh keys. Probe both an approved and a still-revoked registration before enabling report schedules. Resume normal deployments only after the configuration used by CI points to the registration signer.

```sh
node examples/outbound/check-publication.mjs --address "$ACCOUNT" --subject "$APPROVED_SUBJECT" --absent
pnpm --filter @vicoop-bridge/server exec tsx scripts/quarantine-publications.ts --discard-restored-keys
# If the old wrapping key is unavailable, use this form instead:
pnpm --filter @vicoop-bridge/server exec tsx scripts/quarantine-publications.ts --discard-restored-keys --new-wrapping-key "$NEW_KEY_FILE"
```
