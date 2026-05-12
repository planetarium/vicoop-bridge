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
alias) is **removed**. In its default mode `login` saves the owner
bearer to `~/.vicoop/owner-session.json`, and admin subcommands fall
back to that file via `resolveOwnerSession` whenever the
`VICOOP_OWNER_TOKEN` / `VICOOP_BRIDGE` env pair is unset — so the
env-file output was structurally redundant. Scripts that need the raw
access token without touching the session file can still use
`vicoop-client login --json`, which prints the token-endpoint response
to stdout and (intentionally) does not persist. Closes #136.

The setup-written env file now single-quotes its values
(`export KEY='value'`) so shell metacharacters in operator input —
notably AGENT_ID, which the bridge echoes back verbatim — can't
trigger expansion or command substitution when the file is sourced.
