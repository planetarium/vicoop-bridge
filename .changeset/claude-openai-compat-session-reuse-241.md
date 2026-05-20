---
'@vicoop-bridge/client': minor
---

feat(client/claude): reuse the claude session across openai-compat
continuation turns and prepend only newly-arrived `role:"tool"` results
(#241).

Before this change, every A2A task carrying the openai-compat extension
spawned a fresh `--session-id` and the bridge re-fed the entire
`tool_call_history` JSON block on every turn. That made the per-turn
prompt cost grow linearly in the number of prior round-trips and the
cumulative cost grow quadratically; it also discarded the prior
reasoning continuity that `--resume` would otherwise carry in claude's
own session memory. The fresh-spawn gate (`sessionReuseEligible =
openaiCompat === null && sessionTtlMs > 0` at `claude.ts:1149`) was the
emergency workaround for #175 — when session reuse was on AND the
gateway also re-sent the full history, the model saw every prior round
twice and looped.

The redesign keeps the contextId-keyed session alive across openai-compat
A2A tasks and reconciles the two sources of truth instead of avoiding
the conflict. Each `SessionEntry` now carries an `ackSet:
Set<string>` of `tool_call_id` values whose `role:"tool"` result has
already been delivered to this claude session. A continuation turn:

1. Resumes the prior session via `--resume <sid>` (`isResume = true`).
2. Filters the inbound `tool_call_history` to `role:"tool"` entries
   whose `tool_call_id` isn't in the cached `ackSet`. The matching
   `assistant.tool_calls` entries are *not* re-fed — they're already in
   claude's own session memory from the prior turn, and re-feeding them
   is precisely the #233 / #175 failure mode.
3. Renders the filtered list through the existing `formatToolCallHistory`
   wrapper and prepends it to the user content.
4. On a successful terminal frame (`task.complete` with state
   `completed` or `input-required`), adds every `role:"tool"`
   `tool_call_id` from this turn's history to the ackSet so the next
   continuation turn doesn't replay them. Failure leaves the ackSet
   unchanged so the retry sees the same diff.

First turns and fresh-fallback paths (no cached entry, TTL-evicted, or
in-process restart) render the full history exactly as before, so a
caller's first sight of any given conversation is identical.

What was deliberately NOT added, after weighing the implementation cost
against the failure modes:

- **`callerPrincipal`-keyed cache.** A2A's `contextId` is UUID v4 in
  practice (122-bit entropy); blind-guess hijack collisions are
  negligible and the remaining leak vectors (caller-internal storage,
  TLS-broken transport, server log access) aren't the bridge's
  responsibility. See the closed PR #242 for the discussion that
  arrived at this decision.
- **`(system, tools)` fingerprint check.** If a caller changes their
  system prompt or tools array mid-conversation, the cached claude
  session has stale dispatch surface in its system prompt because
  `--resume` can't reissue `--append-system-prompt`. Acceptable
  trade-off: callers that change tools should also change contextId
  (the natural "new conversation" boundary). If this turns into a
  real failure mode in production, the fingerprint check is a small
  follow-up — keep `system` + canonicalised `tools` sorted by
  `function.name`, hash to 16 hex, mismatch → fresh fallback.
- **Fork detection (incoming history prefix vs cached `historyPrefix`).**
  A caller cutting their conversation history mid-flight is a malformed
  use of the extension. The ackSet's "drop already-delivered ids"
  semantics is safe even under this scenario — the worst that happens
  is the model has a stale view of an earlier turn that the caller is
  now claiming didn't happen.

Operational requirement: same-`contextId` continuation turns must land
on the same bridge instance for the optimisation to apply. Round-robin
across multiple bridge processes correctly falls back to fresh every
turn (no regression) but realises none of the savings — sticky routing
on `contextId` is required to hit the acceptance-criteria benchmark in
#241.

Tests added:

- `openai-compat continuation: second turn with same contextId resumes
  via --resume (#241)` — argv-level proof that `--resume <sid>` carries
  the first turn's minted session id and `--session-id` is absent on
  the second spawn. Replaces the prior `#213`-era invariant assertion
  ("openai-compat ALWAYS spawns fresh `--session-id`") that the
  emergency workaround had to lock in.
- `openai-compat continuation: prepended history contains only new
  role:"tool" results since the prior turn (#241)` — three-turn
  scenario verifying that the prepended block contains only the
  newly-acked tool results, never the matching `assistant.tool_calls`
  and never a `role:"tool"` entry whose id was already acked on a
  prior turn.
- `openai-compat continuation: regression guard against #175
  double-feeding` — structural invariant: across both turns' stdin
  payloads combined, any given `tool_call_id` appears at most once.
