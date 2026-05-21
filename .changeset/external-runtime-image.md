---
'@vicoop-bridge/client': patch
---

Add the external-runtime container image (#249, PR A). Lands the
agent-agnostic `vicoop-runtime` image alongside the bundled-direct
profile (#244, `container/bundled/`) so the two profiles can coexist:

```
execution=direct
  - host direct                          (existing bare-metal)
  - bundled bridge container direct      (#244 — container/bundled/)

execution=container
  - external runtime container           (#249 — container/runtime/)
```

The image is intentionally agent-agnostic: agent CLIs (claude / codex)
are NOT baked in. The host-resident bridge client provisions them into
a named volume at backend init time via
`docker exec <c> install-backend.sh <kind>` (the shared install
machinery under `container/` works inside either profile's container).
Container body is `sleep infinity` after firewall init; per-task work
flows through `docker exec` from the host.

Published to `ghcr.io/planetarium/vicoop-runtime` from a new
`.github/workflows/release-runtime.yml` that builds linux/amd64 +
linux/arm64 on main pushes that touch image inputs (`container/runtime/**`,
shared scripts under `container/`).

Bridge client wiring (a `SpawnAdapter` + `runtime: host | container`
config) lands in PR B of #249. This PR only ships the image so the
runtime artifact exists by the time the host-side code starts
exec'ing into it.
