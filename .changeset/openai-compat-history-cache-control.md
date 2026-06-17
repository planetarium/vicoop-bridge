---
'@vicoop-bridge/client': patch
---

Strip `cache_control` markers from the replayed `<chat_history>` block on the
openai-compat path. Anthropic-style `cache_control: {"type":"ephemeral"}`
markers ride inbound on `messages[]` (the gateway / calling agent places one
ephemeral breakpoint on a recent turn). `formatChatHistory` rendered the history
verbatim, so the marker — which moves to the latest turn every request — mutated
an entry in the middle of the otherwise byte-identical history on each follow-up
turn. That broke the Anthropic prompt-cache prefix match at the marker's
position, forcing the entire replayed transcript after it to be re-written to
cache (1.25×) instead of read (0.1×) on every turn. Since openai-compat
conversations resend the full growing history each turn, this dominated token
usage on long sessions. The markers are an API-transport hint, not conversation
content, and were never part of the history shape the model is told to expect —
they are now deep-stripped before rendering so the block is a stable
append-only prefix and the replayed history stays cache-readable across turns.
