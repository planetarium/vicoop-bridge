---
'@vicoop-bridge/client': patch
---

codex: log caller-tool turns that end with no tool call, and optionally retry the ones that stalled

On an openai-compat request that carries `tools`, the caller's tools are the
only thing that can act — the bridge strips codex's own shell and declines its
approval prompts. A turn that completes without calling one leaves the caller
nothing to run. That is fine for a final answer and a dead end when the model
gave up: it reaches for a host-side tool first (a shell call that fails with
"No usable execution environment", or an MCP server from the operator's own
`~/.codex/config.toml`, which gets cancelled) and then replies "I couldn't
create the app because the tool calls were cancelled". Until now that task
completed with `finish_reason: "stop"` and nothing in the logs
(planetarium/vicoop-bridge#207).

**Always on — logging.** Every such turn now produces one line:

```
[codex] caller-tool turn produced no tool calls taskId=… model=… textLen=… modelRounds=… toolHistory=… hostToolItems=… hostToolFailures=… hostToolKinds=mcpToolCall:<server> reason=…
```

`reason` is one of:

- `none` (`info`) — an ordinary one-round answer.
- `host_tool_round` (`info`) — the model spent a round on something other than
  a caller tool. This covers the failed shell call, but also a harmless detour
  followed by a correct answer; the two look identical, so it is only logged.
- `host_tool_failed` (`warn`) — a codex-side tool failed or was declined.
  `hostToolKinds` names the MCP servers involved, which is usually what needs
  removing from the codex config.
- `tool_choice_unmet` (`warn`) — `tool_choice` required a tool call and the
  model answered with prose.

No model output is logged.

**Opt-in — retry.** With `--codex-retry-stalled-tool-call` (or
`backends.codex.retry_stalled_tool_call: true`) a turn flagged
`host_tool_failed` or `tool_choice_unmet` gets one corrective turn on the same
thread, telling the model that host tools cannot run and naming the caller's
tools. **Off by default**: it costs an extra turn when it fires.

- The retry happens at most once and shares the task's `turnTimeoutMs` budget.
- It replaces the first attempt only if it ends cleanly with a tool call or
  with text. If it fails, times out or says nothing, the task completes with
  the first attempt's result, exactly as it would have without the flag.
- Reported usage is the sum of both attempts.
- Text cannot be recalled: a streaming caller sees the first attempt's text
  followed by the retry's, even when the retry is then discarded. The final
  `chat_completion` carries only the attempt that stands.
- Host runtime only. The setting is rejected with `--runtime container`, which
  does not serve caller tools.
