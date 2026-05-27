---
'@vicoop-bridge/client': patch
---

fix(vicoop-codex): place the current user turn before tool_call_history

The vicoop-codex backend assembled the `vicoop-codex call` body as
`system → tool_call_history → user`, leaving the current user request after
every prior assistant/tool round. With a growing multi-turn history,
gpt-5.3-codex read its own request as a brand-new instruction arriving after
all that tool activity and restarted from the first tool (e.g. re-calling
`list_workflows` every turn) instead of progressing to completion.

`buildMessages` now emits `system → user → tool_call_history`, preserving the
original linear OpenAI conversation order (the user request first, then the
tool rounds it drove). This matches what the model sees when talking to
`vicoop-codex serve` directly, eliminating the re-call loop.
