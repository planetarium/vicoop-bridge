---
"@vicoop-bridge/client": patch
---

`vicoop-client agent callers list` now renders allowed callers as a plain `TYPE`/`PRINCIPAL` table (matching `agent list` and the other list commands), with a `(no callers — agent is public)` empty-state, instead of the old multi-line `agent:` / `owner_principal:` / `is_public:` header block. The `--json` output is unchanged (it still carries `agent_id`, `owner_principal`, `is_public`, and `allowed_callers`).
