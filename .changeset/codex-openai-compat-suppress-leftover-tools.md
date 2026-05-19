---
'@vicoop-bridge/client': patch
---

Steer the codex model away from host-side scaffolding tools under
openai-compat caller-side dispatch so it falls back to emitting the
`tool_calls` envelope instead of chaining unsuppressable codex
internals (issue #207).

`update_plan` and `request_user_input` are unconditional
`executors.push(...)` entries in codex-rs `spec_plan.rs` with no
feature gate, so config-level disable is not possible. The
`CODEX_LEFTOVER_TOOL_DIRECTIVE` appended to `developerInstructions`
names both tools explicitly and tells the model they are host
scaffolding outside this task's tool surface — the only legitimate
outputs are a `tool_calls` envelope or a natural-language reply.
Gated to caller-side dispatch so non-openai-compat callers keep their
normal codex affordances.

Verified against the #207 session jsonl (`019e3a10-…`): the auto-injected
`<environment_context>` already had no `<cwd>` / `<shell>` tags thanks
to the existing `environments: []`, so the remaining surface for the
model to misuse was the host-side scaffolding addressed here. Live
re-test against a deployed `codex-Mac-pr208` agent showed
`request_user_input` calls dropped to zero across four sessions; the
model now emits the envelope and tasks complete (vs the silent
text-only completion observed in #207).

Also relaxes `tryParseToolCallsEnvelope` to recover envelopes the model
prefixed with prose (or wrapped in a code fence). A 5-run re-test caught
one case where the model emitted
`"<short narration>{"tool_calls":[…]}"` — a fully-formed envelope at
the suffix that the strict pre-relaxation path discarded, producing a
silent run failure even though the call payload was complete. The
relaxed path keeps the fast (clean-envelope) check unchanged and adds a
slow fallback: locate the `{"tool_calls":` marker, balance-match the
surrounding JSON object (respecting strings + escapes), and parse the
slice. False positives are bounded by the marker specificity + valid-JSON
+ `tool_calls`-array gate.

Also overrides `sandbox` to `workspace-write` on `thread/start` /
`thread/resume` whenever caller-side dispatch is active. A second 5-run
re-test caught two runs (030, 031) where the model read codex's
built-in permissions text ("`sandbox_mode` is `read-only`") and
explicitly refused the caller's writable tools:

> "this session is currently in a read-only filesystem sandbox, so I
>  can't create `index.html`, `styles.css`, or `script.js` from here."

The model never executes locally under caller-side dispatch
(`environments: []` removes every shell / write / apply_patch handler),
so the operator-configured sandbox value only matters for the
permissions-text rendering. Forcing it to `workspace-write` aligns the
text the model reads with its actual contract (emit envelopes the caller
will execute against the caller's workspace). Non-openai-compat callers
still get the operator-configured sandbox unchanged.

Not addressed by this PR (tracked separately):

- `list_mcp_resources` / `list_mcp_resource_templates` /
  `read_mcp_resource` are gated in `spec_plan.rs` by
  `if params.mcp_tools.is_some()`, which traces back to
  `mcp_connection_manager.has_servers()` — a session/process-level
  manager. Thread-level overrides (`config.mcp_servers: {}` on
  `thread/start`) are silently merged with no effect. Process-level
  `-c mcp_servers.<name>.enabled=false` per server flips
  `codex mcp list` to disabled but does not suppress `has_servers()`
  in app-server mode on cli 0.130 — see PR #208 review for the
  detailed trace.
- `update_plan` registration cannot be config-killed; the directive
  reduces but does not eliminate calls.
