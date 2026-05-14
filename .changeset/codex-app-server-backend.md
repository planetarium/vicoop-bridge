---
'@vicoop-bridge/client': minor
---

Add `codex-app-server` backend that drives one persistent `codex app-server`
subprocess over stdio JSON-RPC for the lifetime of the client, instead of
spawning `codex exec` per task. Same A2A surface as the existing `codex`
backend (drop-in replacement: openai-compat extension, tool_call_history,
image FileParts, traceability artifacts, sandbox modes). Operators opt in
via `--backend codex-app-server`, `BACKEND=codex-app-server`, or
`config.backend = "codex-app-server"`; the existing `codex` backend is
unchanged so rollback is one flag away.

Measured baseline (prompt: `Reply OK`, same contextId, 2 turns):
- `codex` (current, per-task spawn): turn 1 ~10s, turn 2 ~10s
- `codex-app-server` (new): turn 1 ~6–9s, turn 2 ~1.3–1.6s

The win is on follow-up turns — the prior backend paid `codex exec resume`
startup on every turn; the new one keeps the agent warm in a single
process. See #169 for the full design and measurement notes.
