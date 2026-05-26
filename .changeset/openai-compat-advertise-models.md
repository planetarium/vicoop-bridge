---
'@vicoop-bridge/client': minor
---

Advertise the underlying model on the `openai-compat/v1` AgentExtension's
`params.models` slot for the `claude` and `codex` backends, per
planetarium/oai2a2a#63. Claude reads its `system/init` stream-json event
on a SIGTERM'd probe (no LLM call), and codex reads the `model` /
`model_reasoning_effort` keys from `${CODEX_HOME ?? ~/.codex}/config.toml`.
Probes are best-effort and silent on failure; the advertise is omitted
when the model cannot be determined. Wire semantics are unchanged.
