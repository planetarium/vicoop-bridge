---
'@vicoop-bridge/client': minor
---

Rename `agent revoke` to `agent delete` and align with the server's
hard-delete semantics.

The server-side soft-delete machinery is being removed (see companion
server changeset / `feat(server,client)!:` commit); the CLI follows
suit. The deprecated flat alias `vicoop-client revoke-client` is
preserved with a deprecation warning that now points at
`agent delete`, so existing scripts keep working through this
release — that's why this is shipped as a minor rather than a major
bump.

**New / changed**

- `vicoop-client agent revoke <TARGET>` →
  `vicoop-client agent delete <TARGET>`. The new `delete` subcommand
  prompts `Delete agent "<TARGET>"? [y/N]` before calling the API;
  pass `--yes` / `-y` to skip (required for non-TTY usage like
  scripts and CI).
- The deprecated `vicoop-client revoke-client` flat alias now points
  at `agent delete` in its warning text. It still calls the same
  endpoint and skips the prompt (preserving script behavior).
- Daemon close-code 4014 reason text changes from `"client revoked"`
  to `"client deleted"`; the log line is now `client deleted by
  owner; stopping`. The behavior (exit non-zero, no reconnect) is
  unchanged.

**Migration**

- Interactive users on `vicoop-client agent revoke …`: switch to
  `agent delete …` and confirm the prompt.
- Scripts on the same: switch to `agent delete --yes …`.
- Scripts on the legacy `vicoop-client revoke-client …` flat form:
  no immediate action required, but plan to move to `agent delete
  --yes` before the deprecated alias is removed.
