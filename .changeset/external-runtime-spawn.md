---
'@vicoop-bridge/client': minor
---

Add `runtime: 'host' | 'container'` to the claude and codex backends
(#249 PR B). This is the bridge-client side of the external-runtime
profile landed in PR A (#251) — when an operator opts in, the agent
CLI runs inside a long-lived `vicoop-runtime` container the bridge
client orchestrates via `docker exec`, instead of being spawned as a
host child process.

New surface:

- Config: `backends.claude.runtime` / `backends.codex.runtime` accept
  `'host'` (default) or `'container'`.
- CLI flags: `--claude-runtime host|container`, `--codex-runtime host|container`.
  Standard precedence (flag > config) applies.
- A `RuntimeContainer` module (`src/runtime-container.ts`) owns the
  per-backend lifecycle: docker daemon ping, image pull, named-volume
  provisioning (`vicoop-agents-<kind>`, `vicoop-creds-<kind>`,
  `vicoop-sessions-<kind>`), container create with
  `--restart unless-stopped` + `NET_ADMIN/NET_RAW`, reuse of an
  existing container on bridge-client restart, and an explicit stop
  on shutdown.
- A `SpawnAdapter` module (`src/spawn-adapter.ts`) presents the
  existing `ClaudeSpawnFn` / `AppServerSpawnFn` shape regardless of
  mode. The host implementation is the same `node:child_process.spawn`
  the backends use today; the container implementation runs the
  command via `docker exec` (shelled out as a child process) so the
  backend sees a normal child-handle either way.
- All docker interactions go through the `docker` CLI as child
  processes — image pull, volume / container lifecycle, and the
  per-task `docker exec` for agent spawn. No programmatic Docker
  client library; the operator-side `docker` install we already
  require (Decision §6) is the dependency surface.

Decisions reflected (#249 §Decisions):

- §1 docker CLI as the daemon-interaction surface.
- §2 `--restart unless-stopped` + bridge-client-side reuse on restart.
- §3 Per-backend long-lived only; no per-context runtime.
- §4 Creds in a container-only named volume — the host's `~/.claude`
  never enters the container.
- §5 Sessions volume mounted into the container so claude/codex
  session resume survives container re-creation.
- §6 No docker daemon → explicit error from `RuntimeContainer.start()`
  with a "switch to runtime: 'host' or start docker" hint; no
  fallback.
- §8 The two backend kinds keep their identity; runtime mode is the
  `runtime` field, and backend internals stay unaware of it.

Out of scope (separate work):

- Per-context workspace branching (today the host bind-mount is whole).
- `vicoop-client backend init` operator-UX subcommand (PR C of #249).
- Bundled-direct image publishing (still off per #250).
