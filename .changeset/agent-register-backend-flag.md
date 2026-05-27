---
'@vicoop-bridge/client': minor
---

Add `--backend` to `vicoop-client agent register`. When supplied (one of
`echo` / `openclaw` / `claude` / `codex` / `vicoop-codex`), the chosen
backend is persisted into `config.json` alongside the just-minted
credentials so the daemon picks it up on next start without the
entrypoint wizard or a separate `--backend` daemon flag. Omitting
`--backend` leaves any pre-existing `backend` field intact, so
re-running register to rotate a token does not clobber an operator's
prior backend choice.
