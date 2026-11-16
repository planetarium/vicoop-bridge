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

`reason` is `none` for an ordinary one-round answer (logged at `info`),
`host_tool_round` when the model spent a round on something other than a
caller tool (`info`), and `host_tool_failed` or `tool_choice_unmet` — a
codex-side tool failed or was declined, or `tool_choice: "required"` was
answered with prose — at `warn`. `hostToolKinds` names the MCP servers
involved, which is usually what needs removing from the codex config. No model
output is logged.

**Opt-in — retry.** With `--codex-retry-stalled-tool-call` (or
`backends.codex.retry_stalled_tool_call: true`) a turn with any of those three
reasons gets one corrective turn on the same thread, telling the model that
host tools cannot run and naming the caller's tools. **Off by default**: it
costs an extra turn when it fires, and `host_tool_round` is a heuristic that
can misfire on a genuine answer. The retry happens at most once, and a retry
that fails leaves the first attempt's result in place rather than failing the
task.

The first attempt's text has already streamed and cannot be recalled, so a
streaming caller sees it followed by the retry's output; the final
`chat_completion` carries only the retry's result.
