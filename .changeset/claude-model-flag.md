---
'@vicoop-bridge/client': minor
---

Add a `--claude-model` flag (and matching `backends.claude.model` config
key) to pin the model for the spawned `claude`, e.g.
`vicoop-client start --backend claude --claude-model claude-opus-4-8`. The
value is folded into Claude `--settings` as its `model` field, so the
default sandbox guard and any operator-supplied settings are preserved. A
per-request openai-compat `model` still overrides it. Pairing the flag with
a non-claude backend exits non-zero.
