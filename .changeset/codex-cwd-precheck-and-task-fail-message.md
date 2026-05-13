---
"@vicoop-bridge/client": patch
---

Make Codex backend usable from any `cwd` and surface backend failure detail (#147). Two changes work together:

- **Foreground log now includes `error.message` on `task.fail`.** Backends already pack stderr tails, exit codes, signals, argv, and other diagnostic detail into `error.message`, but the lifecycle log emitted only `code=` and dropped the message — forcing operators to enable bridge-side wire-frame tracing just to learn why a task failed. The message is appended via `safeToken` (4 KB cap, line breaks escaped) so the log stays single-line and wire-derived bytes can't break out of it.
- **Codex backend always passes `--skip-git-repo-check`.** `codex exec` refuses by default to run from a directory that is neither a git repo nor an operator-trusted path, exiting `1` with `Not inside a trusted directory…` in ~200 ms. vicoop agents work in an operator-chosen `cwd` that is often not a git repo, so the new default is to skip codex's cwd-trust ergonomics gate. Sandboxing is unchanged — this is a separate concern from `sandbox_mode`. The flag is deduplicated when also listed in `backends.codex.extra_args`.
- The Codex `codex_exit_nonzero` message now also includes the spawned `argv=[...]` and `cwd=...` so an operator can reproduce the failing invocation from the foreground log alone.
- Config accepts `backends.codex.extra_args: string[]` (validated as a homogeneous string array; malformed values are dropped) so operators can forward additional flags to `codex exec`.
