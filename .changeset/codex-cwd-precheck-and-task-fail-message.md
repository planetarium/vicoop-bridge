---
"@vicoop-bridge/client": patch
---

Surface backend failure detail and pre-flight codex `cwd` (#147). Two changes work together:

- **Foreground log now includes `error.message` on `task.fail`.** Backends already pack stderr tails, exit codes, signals, argv, and other diagnostic detail into `error.message`, but the lifecycle log emitted only `code=` and dropped the message — forcing operators to enable bridge-side wire-frame tracing just to learn why a task failed. The message is appended via `safeToken` (4 KB cap, line breaks escaped) so the log stays single-line and wire-derived bytes can't break out of it.
- **Codex backend pre-checks that `cwd` is a git repository.** `codex exec` refuses to run from a directory that is neither a git repo nor an operator-trusted path, printing `Not inside a trusted directory and --skip-git-repo-check was not specified.` to stderr and exiting `1` in ~200 ms. The backend now detects this up front and fails with a clear `codex_cwd_not_git_repo` code whose message names the actual `cwd` and points to the three fixes (`git init`, repoint `cwd`, or add `--skip-git-repo-check` to `backends.codex.extra_args`). The check is skipped when `--skip-git-repo-check` is already present in `extra_args`, and when `cwd` is unset.
- The Codex `codex_exit_nonzero` message now also includes the spawned `argv=[...]` and `cwd=...` so an operator can reproduce the failing invocation from the foreground log alone.
