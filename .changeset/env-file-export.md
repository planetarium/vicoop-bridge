---
'@vicoop-bridge/client': minor
---

`vicoop-client setup --write-env-file` now emits `export KEY=VALUE`
lines instead of bare `KEY=VALUE`. Sourcing the generated file with
`. vicoop-client.env` followed by running `vicoop-client whoami` (or the
daemon) used to fail with `missing required: agentId, server` because
the assignments stayed shell-local and never reached the child
process's environment. The `export` prefix makes the source-then-run
idiom work without needing `set -a` wrappers. The stdout-only `setup`
output (no `--write-env-file`) gains the prefix too, so piping it into
a file behaves the same way. Fixes #134.

systemd's `EnvironmentFile=` consumer is unaffected — the install-time
template written by `install.sh` to `/etc/vicoop-client.env` (or the
user-scope equivalent) is unchanged and still uses bare `KEY=VALUE`,
matching what systemd actually parses.

`vicoop-client login --write-env-file` (and its deprecated `--env-file`
alias) is **removed**. Admin subcommands already fall back to
`~/.vicoop/owner-session.json` (auto-saved by `login` regardless of
flags) via `resolveOwnerSession`, so the env-file output was structurally
redundant. Scripts that need the raw access token can still use
`vicoop-client login --json`, which prints the token-endpoint response
to stdout without persisting it. Closes #136.
