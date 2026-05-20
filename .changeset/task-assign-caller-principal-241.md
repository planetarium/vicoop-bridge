---
'@vicoop-bridge/protocol': minor
'@vicoop-bridge/server': minor
---

Forward the server-verified caller principal to the connected client as
`TaskAssignFrame.callerPrincipal`. Prerequisite for the diff-based
openai-compat session reuse redesign in #241: the client backends will key
their per-conversation session cache on `(callerPrincipal, contextId)`
plus a `(system, tools)` fingerprint so one caller cannot resume another's
backend session by guessing or sharing a `contextId`.

Scope is the bridge-internal server↔client WebSocket frame only. No change
to the A2A wire shape, the openai-compat extension contract, or any
externally-visible API. `_principalId` continues to be stripped from
`message.metadata` before the frame leaves the bridge — the new field
carries the same value as a typed sibling so the client never has to
parse the internal-metadata convention.

Backwards compatibility:

- `callerPrincipal` is optional and omitted on the wire when the binding
  has no principalId (public-agent path; no auth middleware ran).
- `PROTOCOL_VERSION` is unchanged — `HelloFrame.version` literal stays at
  `'0.1'`, so the hello handshake remains compatible in both directions.
- zod's default unknown-key strip on `z.object` means an older client
  parsing a newer server's frame silently drops the new field and behaves
  exactly as before.
- A newer client parsing an older server's frame sees
  `callerPrincipal === undefined` and treats the task as anonymous (never
  resumable across turns), which is the same fail-safe path used for the
  public-agent flow.

No behaviour change in this release — `@vicoop-bridge/client` does not yet
read the new field. The follow-up PRs for the claude and codex backends
(#241) consume it.
