---
'@vicoop-bridge/client': patch
---

Auto-detect when the bridge client itself is running inside a
container (bundled-direct profile, #244) and apply the same
sandbox-relaxation the external-runtime profile (#249) already
gets when it spawns an *outside* runtime container.

Previously, `--<kind>-runtime container` was the only path that
flipped claude's `sandbox.failIfUnavailable=false` and codex's
default to `danger-full-access`. The bundled image's in-container
`vicoop-client` daemon had no way to know its own context — so it
defaulted to the host-process safety floor (read-only / refuse-
unsandboxed) and a codex file-write task got rejected as
"escalation request was rejected" on the first try.

Detection delegates to [`is-inside-container`][lib] (37M weekly
downloads, MIT, single dep on `is-docker`), which already covers
the signals we care about for the operator footprint
(`/.dockerenv`, `/run/.containerenv`, `/proc/self/cgroup`,
`/proc/self/mountinfo`). `pickBackend` treats
`runtime !== undefined || isInsideContainer()` as the unified
"already isolated" condition for both claude and codex; the
runtime-container lifecycle flow is untouched. Operator-explicit
overrides (`--codex-sandbox …`, claude settings file) always win.

Verified end-to-end: rebuilt the bundled image, ran headless
bootstrap, injected codex creds, restarted, and ran a
`stream` task that writes `/tmp/d.txt` and reads it back —
previously this rejected on codex's read-only sandbox
escalation; now it completes cleanly.

[lib]: https://github.com/sindresorhus/is-inside-container
