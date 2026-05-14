---
'@vicoop-bridge/client': minor
'@vicoop-bridge/server': minor
---

Rewrite the `codex` backend to drive one persistent `codex app-server` subprocess over stdio JSON-RPC for the lifetime of the client, instead of spawning `codex exec` per task. The wire-facing A2A surface is unchanged — same `--backend codex`, same `BACKEND=codex`, same `backends.codex` config block, same openai-compat extension, same `tool_call_history`, image FileParts, traceability artifacts, and sandbox modes.

Operator config impact:

- `backends.codex.cwd`, `backends.codex.sandbox_mode`, `CODEX_CWD`, `CODEX_SANDBOX_MODE` keep their meaning.
- `backends.codex.extra_args` is removed — the JSON-RPC transport doesn't take CLI flags the way `codex exec` did. The single in-tree user (`--skip-git-repo-check`) is no longer needed because app-server doesn't require a git-trusted directory.
- New: `backends.codex.approval_decision` (`accept` / `acceptForSession` / `decline`, default `decline`) — what to answer when codex sends a server-initiated approval request (`execCommandApproval` / `applyPatchApproval`). Safe even under `workspace-write`; operators that explicitly want auto-accept opt in.

Behavior changes:

- Multi-turn `tool_call_history` is now injected as native Responses API `function_call` / `function_call_output` items via `thread/inject_items`, not as a `<tool_call_history>` JSON blob prepended to the user prompt. This eliminates the multi-turn re-call loop observed under prompts like `"Use a tool to list ..."` (#176) — the model sees real prior tool dispatch rather than a JSON envelope it has to be instructed to interpret.
- Built-in `shell_tool` / `unified_exec` are disabled per-thread via `config.features` (was: `--disable shell_tool --disable unified_exec` argv).
- Concurrent same-`contextId` tasks are serialised through a per-context lock (app-server rejects a second `turn/start` while another is active on the same thread). Previously each task got its own subprocess so the race didn't exist.
- Per-task fork-exec isolation is no longer in play. Operators that depended on it should comment on #177.

Performance (prompt: `Reply OK`, same contextId, 2 turns):

- Old (per-task spawn): turn 1 ~10s, turn 2 ~10s
- New (persistent app-server): turn 1 ~6–9s, turn 2 ~1.3–1.6s

The win is on follow-up turns — the prior backend paid `codex exec resume` startup on every turn; the new one keeps the agent warm in a single process. See #169 for the design and measurement notes; #177 for why the two backends were consolidated under the `codex` name instead of shipping a separate `codex-app-server` backend alongside.
