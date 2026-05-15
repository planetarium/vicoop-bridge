---
'@vicoop-bridge/client': minor
---

Add `vicoop-client logout`, symmetric with `vicoop-client login`. By default it
invalidates the operator's owner-session bearer server-side via the bridge's
new RFC 7009 `POST /oauth/revoke` endpoint and then removes
`~/.vicoop/owner-session.json`. Two flags split the two effects:

- `--local-only` skips the network call and just deletes the local file —
  useful when the bridge is unreachable.
- `--keep-local` revokes server-side but leaves the file in place — useful
  for inspection / debugging.

The server call is best-effort: a non-200 reply prints a warning but the local
file is still deleted (the local hygiene win shouldn't depend on the bridge
being up). A missing local session is reported, not an error.

This closes the credential-hygiene gap where the only way to invalidate a
leaked / shared-machine owner-session bearer was to wait out its 90-day TTL.
The corresponding server endpoint is shipped at the same time.
