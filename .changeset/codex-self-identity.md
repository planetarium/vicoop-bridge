---
'@vicoop-bridge/client': patch
---

codex backend: inject self-identity into `developerInstructions` on
plain `thread/start` so the spawned codex agent recognises its own A2A
mention (`@<agentId>@<host>` / `acct:<agentId>@<host>`) as a
self-reference and answers directly instead of trying to a2a-call its
own address via the a2a-wallet skill. Mirrors what PR #129 added for the
claude backend; the codex backend (introduced after #129 merged) was
missing the equivalent injection, so the failure mode from #128 had
regressed for codex-backed agents. Skipped on openai-compat tasks
because codex is acting as a model endpoint there, not an A2A agent —
the gateway owns conversation context so the directive doesn't apply.
`buildSelfIdentitySystemPrompt` is now shared from `identity.ts` so both
backends use the exact same wording.
