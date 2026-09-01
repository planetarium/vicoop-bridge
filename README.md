# vicoop-bridge

A2A Server + Client for exposing local coding agents (OpenClaw, Claude Code, Codex, …) as Google A2A-compliant remote agents.

Agents connect *outbound* to a public Server via WebSocket, so they can sit behind NAT/firewalls while still being addressable by external A2A clients.

Docs:

- [`docs/design.md`](./docs/design.md) — architectural design
- [`docs/install-client.md`](./docs/install-client.md) — onboarding a new client against a deployed bridge
- [`docs/remote-testing.md`](./docs/remote-testing.md) — end-to-end testing against a deployed bridge
- [`docs/local-testing.md`](./docs/local-testing.md) — running both bridge and client from source
- [`docs/oauth-federation.md`](./docs/oauth-federation.md) — direct-Connector OAuth federation, policy, and task continuity
- [`docs/openclaw-e2e.md`](./docs/openclaw-e2e.md) — exercising the `openclaw` backend directly against the gateway Docker image
- [`docs/claude-telemetry.md`](./docs/claude-telemetry.md) — observability for the `claude` backend: what the journal already reports, and collecting the CLI's OTEL stream

## Client Releases

`@vicoop-bridge/client` releases are driven by
[Changesets](https://github.com/changesets/changesets). PRs that should bump
the client include a changeset describing the change; merging them keeps a
single "Version Packages" PR up to date with the resulting version + changelog
entry. Merging that Version PR triggers
[`.github/workflows/release.yml`](./.github/workflows/release.yml), which
cross-compiles per-platform native binaries (macOS/Linux/Windows) with Bun
and publishes them as assets on the `@vicoop-bridge/client@<version>`
GitHub release.

Day-to-day flow for contributors:

```bash
pnpm changeset           # pick patch / minor / major + write a one-line summary
git add .changeset/      # commit the new file alongside your change
```

See [`.changeset/README.md`](./.changeset/README.md) for the full flow,
including which packages are versioned (only `@vicoop-bridge/client`).

Operators installing from a published release should follow
[`docs/install-client.md`](./docs/install-client.md) — the one-liner
installer plus SIWE/registerClient flow for obtaining a client token.

Before merging a Version Packages PR, verify that
[`docs/install-client.md`](./docs/install-client.md) still matches the
bundle being released:

- shipped backends listed in the doc match `packages/client/src/cli.ts`
- backend-specific launch examples still reflect the released client behavior
- the asset filename matrix in `scripts/package-client-release.sh` and
  `install.sh`'s platform-detect block still agree with
  `resolvePlatformAsset()` in `packages/client/src/upgrade.ts`

## Status

Active development. The client currently ships `echo`, `openclaw`, `claude`,
and `codex` backends.
