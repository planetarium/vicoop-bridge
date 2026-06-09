---
"@vicoop-bridge/client": patch
---

fix(vicoop-codex): backfill zero usage when `serve` drops it, instead of
emitting a usage-less envelope. The openai-compat/v1 extension REQUIRES
`chat_completion.usage` with numeric prompt/completion/total tokens; when
`vicoop-codex serve` intermittently omits usage on a turn (the #317 failure
mode despite forced `stream_options.include_usage`), the backend previously
emitted the terminal envelope without usage and the gateway hard-rejected the
whole response ("missing required usage"), so the caller lost an otherwise-valid
answer. The backend now backfills a zero-filled usage block on that path,
keeping the turn spec-compliant and delivered (the existing warning still logs
the under-billing for diagnosis).
