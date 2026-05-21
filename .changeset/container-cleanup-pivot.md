---
'@vicoop-bridge/client': patch
---

Reorganize #245's container scaffolding to clarify it's the
**bundled-direct deployment profile**, and prepare for #249's
**external-runtime profile** to land alongside (not replace) it.

The two profiles coexist:

```
execution=direct
  - host direct                          (existing bare-metal)
  - bundled bridge container direct      (#244 — this profile)

execution=container
  - external runtime container           (#249 — landing later)
```

Moved
- `Dockerfile` → `container/bundled/Dockerfile`
- `container/entrypoint.sh` → `container/bundled/entrypoint.sh`
- The non-`bundled/` `container/` content (`install-backend.sh`,
  `backends/*.sh`, `init-firewall.sh`) stays shared between profiles.

Removed
- `.github/workflows/release.yml` ghcr image build/push step +
  `packages: write` permission. The bundled image's release pipeline
  will land when the profile is officially supported; until then we
  avoid emitting a "shipped" signal for an image whose design is
  still settling.
- `installed.json` write at the end of `container/install-backend.sh`
  + the entrypoint's reads of it. Both profiles probe agent CLI
  versions directly (`<bin> --version`) — no on-disk manifest cache.
  See #249 §"State management" for the rationale.
- The pre-existing `.changeset/container-image-foundation.md` —
  superseded by this changeset and a future bundled-image release
  changeset when the image actually publishes.

Unchanged from #245's PR 1
- `vicoop-client info` subcommand (still emits `version`,
  `imageVersion` when running under the bundled image, and the
  backend compat manifest).
- `vicoop-client upgrade` `VICOOP_BRIDGE_IMAGE` guard — still useful
  inside the bundled image to prevent the overlay-fs upgrade trap.
- `packages/client/src/backends-manifest.ts` — supportedRange data,
  consumed by both profiles' compat checks.
- `container/init-firewall.sh`, `container/install-backend.sh`,
  `container/backends/{claude,codex}.sh` — shared assets.

See #249 for the new external-runtime profile design and #244 for the
bundled-direct profile it complements.
