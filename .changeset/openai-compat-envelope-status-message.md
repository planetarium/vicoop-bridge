---
'@vicoop-bridge/client': patch
---

Fix openai-compat envelope being duplicated on `task.complete.status.message.parts`
in addition to the `data` artifact (issue #200).

When the `openai-compat/v1` extension is active and the model emits a
`{"tool_calls":[…]}` envelope, the codex, claude, and openclaw backends
correctly route it as a `data` part on a `task.artifact`. They also used to
re-stamp the raw envelope JSON as a `text` part on the terminal
`task.complete.status.message`. Per A2A spec §3.7 — "Messages SHOULD NOT be
used to deliver task outputs" — that mirror is a spec violation, and the
upstream `oai2a2a` gateway re-parsed the text part as `tool_calls` and emitted
them a second time on the OpenAI streaming response. OpenAI clients
concatenate `tool_calls[].function.arguments` by index, so the duplicate
emission produced invalid JSON like `{…}{…}` and silently broke tool-calling
clients (root cause of planetarium/oai2a2a#50, #51).

All three backends now omit the envelope text from `status.message.parts` when
it has already been routed via a data artifact. The `usage` metadata path on
`status.message.metadata` is unchanged, so per-spec usage delivery still
works.
