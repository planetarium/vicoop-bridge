---
'@vicoop-bridge/client': minor
---

Ship `@vicoop-bridge/client` as a self-contained native binary per platform
(macOS arm64/x64, Linux arm64/x64, Windows x64) instead of a Node.js
portable bundle (#188). The release no longer requires Node.js on the
host: `install.sh` now downloads
`vicoop-client-<version>-<os>-<arch>[.exe]` + its `.sha256`, verifies
integrity, and drops the macOS quarantine xattr so first launch isn't
Gatekeeper-blocked. The binary is produced by `bun build --compile` from
a single Linux runner via cross-compile (`oven-sh/setup-bun@v2` in
`release.yml`).

The asset layout, install path, and upgrade flow change in lock-step:

- **Install path**: `$INSTALL_DIR/vicoop-client` (single file), not
  `$INSTALL_DIR/bin/vicoop-client` + `dist/` + `node_modules/`. Anything
  else the operator leaves under `$INSTALL_DIR` is preserved by upgrades
  by construction (the swap only moves three filenames).
- **`vicoop-client upgrade`**: rewritten for the binary model. Downloads
  the matching per-platform asset, sha256-verifies, runs `--version` as
  a healthcheck, atomically renames `vicoop-client` →
  `vicoop-client.prev` and `vicoop-client.new` → `vicoop-client`. Dev
  workspace invocations (`tsx src/cli.ts upgrade`, `node dist/cli.js
  upgrade`) are now rejected up front because `process.execPath` ends in
  `node` / `tsx` / `bun` rather than `vicoop-client[.exe]`.
- **Released-bundle `cards/` directory is gone** (closes the A side of
  #164). The bridge already publishes the canonical card per backend;
  `--card <path>` (or `"card"` in `config.json`) is the operator
  override path, and source-tree
  [`packages/client/cards/`](https://github.com/planetarium/vicoop-bridge/tree/main/packages/client/cards)
  remains the documented reference for authoring overrides.
- **Prerequisites**: Node.js 20+ and `tar` are no longer required by the
  install path. `curl` + `sha256sum`/`shasum` is enough; `jq` is added
  only when `install.sh` auto-resolves the latest tag (skip-able with
  `VERSION=@vicoop-bridge/client@<x.y.z>`).

This is breaking for anyone who currently scripts against
`$INSTALL_DIR/bin/vicoop-client` or extracts the released `.tgz`
directly — both go away.
