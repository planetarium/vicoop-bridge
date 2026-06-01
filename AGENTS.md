# Repo orientation

Monorepo for `vicoop-bridge` — an A2A bridge that exposes local coding
agents (claude / codex / openclaw) to Google A2A clients via an
outbound WebSocket to a public server.

`CLAUDE.md` in the repo root is a symlink to this file. Keep edits to
this file; both names resolve to the same content.

## Packages

| Path                  | Package                       | Role                                                                                  | Released via      |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| `packages/client`     | `@vicoop-bridge/client`       | Bun-compiled CLI operators install to connect their local agent to the bridge server. | Changesets + tags |
| `packages/server`     | `@vicoop-bridge/server`       | The bridge gateway.                                                                   | `fly deploy`      |
| `packages/admin-ui`   | `@vicoop-bridge/admin-ui`     | Web UI bundled into the server.                                                       | Bundled w/ server |
| `packages/protocol`   | `@vicoop-bridge/protocol`     | Shared types / codecs.                                                                | Workspace-only    |

`@vicoop-bridge/{server,protocol,admin-ui}` are listed under `ignore`
in `.changeset/config.json` and have no published artifact — server
and admin-ui ship together via `fly deploy`, protocol is consumed
internally as a workspace dep.

## Common commands

From the repo root:

```bash
pnpm install                                # install once
pnpm -r build                               # build all packages (run this before client tests — they import @vicoop-bridge/protocol from its dist/)
pnpm -r typecheck                           # typecheck all packages
pnpm --filter @vicoop-bridge/client test    # client tests (~490 today)
pnpm --filter @vicoop-bridge/server test    # server tests
pnpm dev:client                             # tsx watch on the client CLI (long-running daemon)
pnpm -s cli:client <args>                   # run a one-shot client subcommand from source (no watch), e.g. `pnpm -s cli:client agent callers list <id>`
pnpm dev:server                             # tsx watch on the server
pnpm dev:admin-ui                           # vite dev server for the admin UI
pnpm deploy:server                          # fly deploy the server
pnpm changeset                              # add a release intent file for the client
```

## Release flow (client)

1. Add a changeset with your PR (`pnpm changeset`).
2. The `Release` workflow keeps a single "chore: version packages" PR
   up to date with the resulting `package.json` bump and the matching
   `packages/client/CHANGELOG.md` entry.
3. Merging that Version PR triggers the publish step:
   `pnpm changeset tag` creates `@vicoop-bridge/client@<version>`, the
   action pushes the tag and creates the GitHub release, then
   `scripts/upload-client-release-assets.sh` attaches Bun
   cross-compiled binaries (macOS / Linux / Windows + `.sha256` for
   each).

**Full operational rules — including which packages NOT to write
changesets for, why mixed or ignored-only changesets break the
pipeline, and how to recover from a stalled Release run — live in
[`.changeset/README.md`](./.changeset/README.md). Read it before
authoring or cleaning up changesets.**

## Deeper reading

- [`README.md`](./README.md) — project overview and onboarding pointers
- [`docs/design.md`](./docs/design.md) — architecture
- [`docs/install-client.md`](./docs/install-client.md) — operator install + SIWE / registerClient flow
- [`docs/local-testing.md`](./docs/local-testing.md), [`docs/remote-testing.md`](./docs/remote-testing.md) — testing flows
- [`docs/claude-e2e.md`](./docs/claude-e2e.md), [`docs/openclaw-e2e.md`](./docs/openclaw-e2e.md) — backend-specific E2E
- [`docs/container.md`](./docs/container.md) — container runtime profiles (bundled-direct + external-runtime)
