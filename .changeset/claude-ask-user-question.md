---
'@vicoop-bridge/client': minor
---

claude backend: surface `AskUserQuestion` calls as A2A
`input-required` instead of silently looping (#221).

When the spawned `claude` invokes the built-in `AskUserQuestion` tool the
backend now:

- closes the task with `task.complete state=input-required` carrying the
  tool call as a `DataPart` on `status.message.parts[0]`
  (`{ kind: 'tool_call', toolName, toolUseId, input }`) so downstream
  clients (e.g. slack-connector) can reconstruct the question via
  `toolCallPartFromLegacyRecord` and render it as interactive UI (Slack
  Block Kit, etc.).
- writes a placeholder `tool_result` back to claude's stdin and closes
  the stream so the session terminates cleanly and the next turn can
  `--resume` against the same `contextId`.
- sets an `emittedAskUserQuestion` flag that suppresses any further
  assistant text / `tool_use` events from claude, preventing the retry
  loop where claude re-invokes `AskUserQuestion` upon receiving the
  placeholder.

No A2A `ask-user-question` artifact is emitted — the terminal
`input-required` frame is the single source of truth for the multi-turn
contract. Plain claude tasks that never hit `AskUserQuestion` are
unaffected.
