---
"@vicoop-bridge/client": patch
---

Close out #302. The `openclaw` backend now reads the openai-compat
extension envelope directly off `metadata[URI].chat_completions_request`
via `parseOpenAICompatEnvelope`, matching the pattern the other three
backends (`vicoop-codex` / `codex` / `claude`) adopted in the prior
release. With every backend on the envelope-direct path the legacy
`parseOpenAICompatMetadata` shim, the `OpenAICompatMetadata`
decomposed-view interface, and the legacy `{system, tools, tool_choice,
chat_history}`-under-URI back-compat are all removed; the parser is now
a thin `chat_completions_request` extractor plus the projection helpers
each backend uses inline.

No operator-visible behaviour change: openclaw produces the same
XML-wrapped `<system_instructions>` / `<chat_history>` / `<user_message>`
blocks it always did, just sourced from the envelope instead of the
decomposed view.
