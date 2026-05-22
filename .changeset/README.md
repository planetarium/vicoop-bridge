# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets)
intent files. They drive `@vicoop-bridge/client` versioning, the per-release
`CHANGELOG.md`, and the `@vicoop-bridge/client@*` GitHub release pipeline.

## When to add a changeset

Any PR that should bump `@vicoop-bridge/client` (a behaviour change, fix,
or docs change relevant to operators) needs a changeset. Only
`@vicoop-bridge/client` is versioned via this pipeline.

## When NOT to add a changeset

Skip the changeset entirely if your PR only touches:

- `@vicoop-bridge/server` — deployed via `pnpm deploy:server` / `fly
  deploy`, not Changesets. Record server breaking changes in the PR
  description and commit body.
- `@vicoop-bridge/protocol` — workspace dep only; consumers (client,
  server) pin via `workspace:*` and rebuild.
- `@vicoop-bridge/admin-ui` — bundled into the server, ships with it.

These three are listed under `ignore` in `config.json`.

If your PR touches **both** the client and one of the ignored packages,
write a **client-only** changeset describing the client-side impact.
Never put the ignored package in the same file as the client (see
"Rules the pipeline is unforgiving about" below).

## How

```sh
pnpm changeset
```

Pick the bump kind (`patch` / `minor` / `major`) and write a one-line
operator-facing summary. The command writes a markdown file under
`.changeset/`. Commit it with the rest of your PR.

## What happens after merge

`.github/workflows/release.yml` runs `changesets/action`:

1. If pending changesets exist on `main`, the action keeps a "Version
   Packages" PR up-to-date with the resulting `package.json` bump and a new
   entry in `packages/client/CHANGELOG.md`.
2. When the Version Packages PR is merged, the action runs
   `pnpm changeset tag` to create the `@vicoop-bridge/client@<version>`
   git tag, pushes it, and creates the GitHub release object with the
   new `CHANGELOG.md` entry as the body. A follow-up step then runs
   `scripts/upload-client-release-assets.sh`, which builds the portable
   client bundle and attaches `.tgz` + `.sha256` to that release.

## Rules the pipeline is unforgiving about

`changesets/action` does not inspect what's inside a changeset to
decide whether to publish vs. open a PR — it just checks whether any
`.changeset/*.md` files exist and whether `pnpm changeset version`
errors out. Two failure modes have stalled releases in the past:

1. **Never mix ignored and non-ignored packages in one changeset
   file.** A single `.md` that bumps both `@vicoop-bridge/client`
   (versioned) and `@vicoop-bridge/server` (ignored) makes
   `pnpm changeset version` exit with `Found mixed changeset …`, which
   halts the entire Release run. If a PR has both-sided impact, split
   into one client-only `.md` and (optionally) one server-only `.md`.
   Precedent: #261.

2. **Don't leave changesets targeting only ignored packages on
   `main`.** Even though they bump nothing, `changesets/action` counts
   them as "pending" and takes the version-PR path. `pnpm changeset
   version` then runs as a no-op (no diff), the action tries to open a
   "chore: version packages" PR with no commits in it, GitHub rejects
   with `No commits between main and changeset-release/main`, and the
   publish step (`pnpm changeset tag`) is never reached — so no tag,
   no GitHub release. Precedent: #262.

   In practice: if you write a server-only changeset to capture a
   breaking change as changelog-style prose, treat the file as a
   short-lived artifact — delete it before (or in the same PR as) the
   next client release. The safer default is to skip server-only
   changesets entirely and put the prose in the PR description.

## Recovering when the Release run fails

- `Found mixed changeset …` → split the offending file into one
  changeset per package (one client-only `.md`, one server-only or
  none at all), then push to `main`.
- `No commits between main and changeset-release/main` → list
  `.changeset/*.md` on `main`. If any target only packages from the
  `ignore` array, delete them, push to `main`. The Release workflow
  reruns on the push; with zero pending changesets it falls into the
  publish branch and tags + releases the version already committed by
  the previous "chore: version packages" merge.
- The asset-upload step is idempotent and re-runs unconditionally — if
  it fails between tag-creation and asset-upload, re-trigger via
  Actions → Release → Run workflow.
