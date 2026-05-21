---
'@vicoop-bridge/client': patch
---

Restart the bundled-direct image publish (#244). Adds
`.github/workflows/release-bundled.yml` so `container/bundled/`'s
Dockerfile rebuilds and pushes to
`ghcr.io/planetarium/vicoop-bridge-client` whenever its inputs
change — paths filter covers `container/bundled/**`, the shared
`container/` scripts, and the bridge-client source (the image
embeds the bun-compiled `vicoop-client` binary).

Companion to PR A's `release-runtime.yml` (#249); the two image
families now have their own workflows so the changesets/action
release for the npm artifact stays independent of either image's
publish schedule. PR #250 removed the in-line bundled push from
`release.yml` precisely so a separate workflow could own it.

No bridge-client behavior change — the image artifact was the only
missing piece between the bundled code on disk (landed in #245,
reorganized in #250) and operators being able to
`docker pull ghcr.io/planetarium/vicoop-bridge-client` again.

`VICOOP_BRIDGE_IMAGE` build-arg is stamped with `<tag>-<full-sha>`
so `vicoop-client info` / `vicoop-client upgrade`'s in-container
fingerprint reads more diagnostic than just `latest`.
