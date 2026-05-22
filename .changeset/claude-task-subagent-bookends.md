---
'@vicoop-bridge/client': minor
---

Surface Claude Task subagent activity as user-visible bookend messages.
When the model invokes the built-in `Task` tool, the bridge now emits a
`claude-message` artifact reading `Task started: <description>` (and a
matching `Task completed: <description>` / `Task failed: <description>`
when the subagent's `tool_result` returns). These bookends fire
regardless of the traceability extension opt-in, closing the otherwise
silent window between the model's Task call and its final response —
previously callers (e.g. a Slack relay) saw zero progress while the
subagent ran and could not tell whether the run had stalled. Artifact
`metadata.event` carries `subagent-started` / `subagent-completed` /
`subagent-failed` plus the `toolUseId` so consumers can correlate or
style the lifecycle.
