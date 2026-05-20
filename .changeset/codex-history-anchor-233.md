---
'@vicoop-bridge/client': patch
---

fix(client/codex): anchor injected `tool_call_history` with a user message
and reset the codex thread per openai-compat task to stop the re-call loop
(#233).

Under the openai-compat extension, follow-up A2A turns inject the prior
`tool_call_history` into the codex thread via `thread/inject_items` so the
model sees its previous round-trips as native `function_call` /
`function_call_output` items (#209). #233 surfaced a tail behaviour where
the codex backend still re-emitted the same tool call on every continuation
turn even though the result was already in scope:

- The injected pairs were attached to the thread without a preceding
  `message`-type user turn, so the model read them as orphan tool dispatch
  rather than as "what I did for the user's request".
- The bridge reused the codex thread across A2A turns sharing a contextId
  (TTL-gated), so each continuation re-injected a full history on top of
  the persisted prior items — the model saw the user prompt and every
  function-call pair twice, then took the freshest user prompt as a new
  imperative.
- Codex's auto-injected `<environment_context>` user-role message lands at
  the head of every `turn/start`, which re-introduced a synthetic user turn
  at the conversation tail when the bridge tried to drive a continuation
  with `turn/start.input: []`.

Three changes:

1. `historyToInjectItems` now prepends a `ResponseItem::Message` with
   `role: "user"` carrying the current user prompt, so the injected
   sequence reads as `[user → assistant tool_call → tool result]` — the
   model treats the tool result as satisfying the request.
2. openai-compat tasks opt out of session reuse and always do
   `thread/start` (mirroring the existing claude.ts guard). The
   stateless-gateway contract is that every turn replays the full history;
   resuming a codex thread on top of that double-feeds the model.
3. `thread/start.config.include_environment_context: false` suppresses
   codex's auto env_context user message; `turn/start.input` then carries
   a single empty-text wake-up item — enough to drive codex's model call
   without leaving a synthetic user turn at the conversation tail. (Empty
   `input: []` was investigated but makes codex's model go silent in
   practice: it's called against pure history but never emits a final
   assistant message.)

This eliminates the unbounded re-call loop the issue captured. A residual
gpt-5 tendency to emit one or two extra tool calls on strongly imperative
prompts ("랜덤 숫자 띄워") remains, attributable to lost
reasoning-continuity across the OpenAI Chat Completions replay (see
[GPT-5 troubleshooting guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_troubleshooting_guide));
addressing that would require carrying reasoning items through the
openai-compat extension and is left for a follow-up.
