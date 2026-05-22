---
'@vicoop-bridge/client': minor
---

Reshape the Claude subagent lifecycle bookend (added in #274) as a
proper trace artifact. The previous version emitted unconditionally as
a `claude-message`, which leaked execution-trace detail to callers
that had not opted into the traceability extension and made the
artifact-name semantics ("model's words to the user") incorrect. The
bookend now rides the same opt-in as `claude-tool-call` /
`claude-tool-result`:

- Artifact name: `claude-subagent-event`
- `extensions: [traceability/v1]` and `metadata.traceType: "subagent-event"`
- Carries the same lifecycle text (`Task started/completed/failed:
  <description>`) plus a structured `data` part
  (`{event, toolUseId, description}`) for correlation
- Only emitted when the task's `requestedExtensions` (or the inbound
  message's `extensions`) includes the traceability URI

Trace-aware A2A consumers already render `claude-tool-call` for the
underlying `Agent` invocation; the bookend pair adds value over that
alone because text-only subagent results don't fire a
`claude-tool-result` — without the explicit "completed" marker, trace
consumers would see "started" with no matching finish event.

Verified end-to-end against the deployed bridge: trace ON → both
bookend artifacts plus the raw `claude-tool-call` line up around the
subagent run; trace OFF → only the model's final `claude-message`,
nothing else.
