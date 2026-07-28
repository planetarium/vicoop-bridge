---
'@vicoop-bridge/client': patch
---

claude: surface silent model switches in the logs; openai-compat: harden tool-call pairing

`model_refusal_fallback` — emitted when the requested model's safeguards flag a
message and claude silently retries the turn on a different model — reached no
log at all. A caller asking for model X would get model Y with the only record
being the on-disk session transcript; in one incident it hit 7 of the 8 turns in
a conversation, every turn after the first, before anyone noticed. Non-`init`
system events are now logged, carrying the SDK's structured fields
(`originalModel` / `fallbackModel` / `trigger` / `apiRefusalCategory`) alongside
its prose blurb, so an operator never has to parse English to learn which model
actually served a turn. Severity follows the SDK's own `level`: anomalies warn,
while high-frequency bookkeeping subtypes such as `thinking_tokens` — measured at
10 events in one trivial turn — go to debug, which the default `info` level
suppresses. Warn therefore stays usable for alerting, and raising the level to
`debug` surfaces the rest.

Alongside it, `chatHistoryFromMessages` now synthesizes an error result for any
`tool_calls` id that has no result anywhere in the replayed history, inserted
directly after the assistant turn that made it. An unanswered call is malformed
on the wire and reads to a model as a dispatch still in flight, which can drive
it to re-dispatch until the run hits its turn cap. This is defensive hardening
rather than a fix for an observed failure: an audit of 29 production tasks found
every call correctly paired, and a well-formed history passes through
byte-for-byte unchanged. Calls without a usable `function.name` are left alone to
match how the codex backend already drops them.
