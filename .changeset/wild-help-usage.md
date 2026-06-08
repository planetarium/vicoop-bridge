---
"@vicoop-bridge/client": patch
---

Fix `--help` usage lines dropping the command-path prefix. `vicoop-client
auth login --help` (and every other subcommand under an umbrella, e.g.
`agent register`, `container init`, plus top-level `start` / `upgrade`)
rendered its synopsis as `Usage: vicoop-client login …`, omitting the
`auth`/`agent`/`container` prefix — so the new command's help pointed at
the deprecated flat form. The umbrellas are marked `hidden: 'usage'` to
keep them out of the top-level synopsis, but @optique 1.0.2's
`formatUsage` also stripped those hidden command terms from each
subcommand's own help. Patched via `patchedDependencies` so leading
command-path terms survive; the top-level synopsis stays unchanged.
