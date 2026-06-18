---
'@vicoop-bridge/client': minor
---

feat(client): forward Claude extended-thinking on an openai-compat/v1
`reasoning` channel. The claude backend surfaces `thinking_delta` stream events
as a dedicated `claude-reasoning` artifact carrying
`metadata[openai-compat/v1] = { channel: "reasoning" }`, and injects a
`MAX_THINKING_TOKENS` budget on openai-compat spawns so Claude Code emits
thinking on the wire. This lets the a2x-internal-router treat a long silent
reasoning turn as alive instead of false-failing-over it
(planetarium/a2x-internal-router#95, #376). ON by default; disable with
`--no-claude-reasoning` or `backends.claude.reasoning: false` when the deployed
oai2a2a codec predates 0.6.0 and can't yet interpret the channel marker.
Redacted-thinking blocks are never forwarded.
