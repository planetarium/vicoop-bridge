---
'@vicoop-bridge/client': minor
---

Switch release tag format from `client-v<version>` to the Changesets monorepo
standard `@vicoop-bridge/client@<version>`. `install.sh`, `vicoop-client
upgrade`, and the release workflow now target the new format only; the prior
`client-v*` releases remain on GitHub but are no longer extended. `--version`
accepts a bare semver (`0.9.1`), `v0.9.1`, or the full new tag.
