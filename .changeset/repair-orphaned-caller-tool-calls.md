---
'@vicoop-bridge/client': patch
---

claude: log every non-`init` SDK system event; openai-compat: harden tool-call pairing

`model_refusal_fallback` — emitted when the requested model's safeguards flag a
message and claude silently retries the turn on a different model — reached no
log at all. A caller asking for model X would get model Y with the only record
being the on-disk session transcript; one incident ran at 24% of turns before
anyone noticed. All non-`init` system subtypes are now logged generically, so a
subtype added later is never silent either.

Alongside it, `chatHistoryFromMessages` now synthesizes an error result for any
`tool_calls` id with no result anywhere in the replayed history, inserted
directly after the assistant turn that made it. An unanswered call is invalid on
the wire (the real OpenAI API 400s it) and reads to a model as a dispatch still
in flight, which can drive it to re-dispatch until the run hits its turn cap.
This is defensive hardening rather than a fix for an observed failure: an audit
of 29 production tasks found every call correctly paired, and a well-formed
history passes through byte-for-byte unchanged. Calls without a usable
`function.name` are left alone to match how the codex backend already drops them.
