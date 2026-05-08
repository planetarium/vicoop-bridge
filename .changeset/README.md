# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets)
intent files. They drive `@vicoop-bridge/client` versioning, the per-release
`CHANGELOG.md`, and the `client-v*` GitHub release pipeline.

## When to add a changeset

Any PR that should bump `@vicoop-bridge/client` (a behaviour change, fix, or
docs change relevant to operators) needs a changeset. Changes that only
touch `@vicoop-bridge/server`, `@vicoop-bridge/protocol`, or
`@vicoop-bridge/admin-ui` can skip it — those packages are listed under
`ignore` in `config.json` and are not versioned.

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
2. When the Version Packages PR is merged, `scripts/changesets-publish.sh`
   builds the portable client bundle and creates the
   `client-v<version>` GitHub release.
