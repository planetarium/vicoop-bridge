---
'@vicoop-bridge/client': patch
---

Cleanup of #245's container image scaffolding ahead of the pivot to #249's
agent-only-container architecture. The bridge client stays bare-metal and
runs per-backend agent runtime containers via docker exec — not bundled
in the same image.

Removed (no external signal since #245's container image never published
to ghcr — the Version Packages PR carrying #245's changeset was held back):

- `Dockerfile` (repo root) — bridge+agents all-in-one image. Replaced
  in the upcoming PR by a thin agent-agnostic `vicoop-runtime` image.
- `container/entrypoint.sh` — wizard / bootstrap_from_env / compat_check
  state machine. The wizard and bootstrap move to the host bridge client
  in the new design; compat check is replaced by direct probing via
  `docker exec`.
- `docs/container.md` — bridge-in-container operator guide; will be
  rewritten for the new design.
- `release.yml` ghcr image build / push step + `packages: write`
  permission.
- `packages/client/src/upgrade.ts`'s `VICOOP_BRIDGE_IMAGE` env guard +
  matching test — dead code with the bridge client running bare-metal.
- `imageVersion` field from `vicoop-client info` output — same reason.
- `installed.json` write at the end of `container/install-backend.sh` —
  the host bridge client probes installed versions directly with
  `docker exec <c> <cli> --version` instead of caching them in a JSON
  file (#249 §"State management").
- Pre-`#245` `.changeset/container-image-foundation.md` deleted to keep
  the pending Version Packages PR's changelog honest about what
  survives.

Kept (reused as-is by the upcoming runtime image PR):

- `container/install-backend.sh` and `container/backends/{claude,codex}.sh`
  — moved into the new runtime image at build time.
- `container/init-firewall.sh` — same.
- `packages/client/src/backends-manifest.ts` + the `vicoop-client info`
  subcommand — the host bridge client uses these to know which agent CLI
  versions it can drive.

See #249 for the design + cleanup execution plan that this PR enacts.
