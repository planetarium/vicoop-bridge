---
'@vicoop-bridge/client': minor
---

CLI cleanup (breaking flag changes):

- **Unify per-backend `--cwd` / `--runtime`.** The daemon flags `--claude-cwd`, `--codex-cwd`, `--claude-runtime`, `--codex-runtime` are replaced by `--cwd` and `--runtime`. The new flags are scoped to whichever backend `--backend` selects; on the config side, `backends.claude.{cwd,runtime}` and `backends.codex.{cwd,runtime}` keep their per-backend shape. Scripts passing the old flags must update.
- **`container init` polish.** Drop the placeholder `--runtime` option (only `container` was implemented; `host` exited with an error); name the `KIND` positional and list its valid values (`claude`, `codex`).
- **Help output cleanup.** Remove the noisy config-precedence blurb from `--help` (the same content lives in `docs/install-client.md`). Strip internal `#NNN` / `PR <letter>` issue references from operator-facing descriptions and runtime error messages.
- **Scoped pre-error help.** On parse errors, render the partially parsed subcommand's help (e.g. `vicoop-client container` prints just the `container` group) instead of dumping the full root usage.
