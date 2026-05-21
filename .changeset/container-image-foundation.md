---
'@vicoop-bridge/client': minor
---

Ship an OCI container image (`ghcr.io/planetarium/vicoop-bridge-client`)
for the bridge client. This is PR 1 of #244: foundation + headless
mode + outbound-allowlist isolation. The interactive setup wizard
lands in PR 2.

Client-visible changes that drive the minor bump:

- `vicoop-client info` — new subcommand emitting `{version,
  imageVersion?, backends: {<kind>: {supportedRange, installable}}}` as
  JSON. Bare-metal operators rarely need this; the container's
  `entrypoint.sh` shells out to it to compatibility-check the agent CLI
  versions recorded in `/data/installed.json`.
- `vicoop-client upgrade` — when invoked inside the container image the
  command short-circuits with `exit(2)` and a `docker pull` hint instead
  of overwriting the binary in the image layer. Detected via the
  `VICOOP_BRIDGE_IMAGE` env baked into the image at build time. Bare-metal
  upgrades are unchanged.

Operator-facing additions (the image itself, no impact on bare-metal
installs):

- `Dockerfile` — multi-stage build (node:20-bookworm-slim base, bun
  compiles the client binary, runtime stage installs the system deps each
  agent CLI needs at runtime).
- `container/entrypoint.sh` — bootstrap modes: headless env-driven setup,
  daemon mode (with `vicoop-client info`-driven compat check), and
  subcommand passthrough.
- `container/install-backend.sh` + `container/backends/{claude,codex,openclaw}.sh`
  — per-backend install/upgrade recipes. Operator-callable via
  `docker exec`.
- `container/init-firewall.sh` — outbound-allowlist firewall ported from
  Anthropic's claude-code reference devcontainer. Domains: bridge server,
  LLM APIs, npm/github. Extend via `VICOOP_EXTRA_ALLOW_DOMAINS`.
- `release.yml` — pushes the image to `ghcr.io/planetarium/vicoop-bridge-client`
  on every Version-PR merge, tagged with the client semver + `:latest`.
- `docs/container.md` — operator guide for the headless (case A) flow.
