---
"@vicoop-bridge/client": patch
---

Close the built-in-tool leak in the codex backend's openai-compat dispatch path (#183). Under openai-compat the caller's `tools` array is the only legitimate dispatch surface, but `features.shell_tool: false` alone was leaving `exec_command` (and its fallback handlers `local_shell` / `shell_command` / `container.exec`) callable in codex CLI 0.130 — we observed codex actually execute `git clone` via `exec_command` despite the feature disables.

Two changes on `thread/start` when caller-side tool dispatch is active:

1. Send `environments: []`. This is sticky on the thread and structurally removes every handler that `spec_plan.rs` gates on `environment_mode.has_environment()` — `shell`, `unified_exec`, `exec_command`, `write_stdin`, `shell_command`, `local_shell`, `container.exec`, `apply_patch`, `view_image` — from the tool registry, regardless of which feature flags are set. The model can no longer dispatch these handlers by name. `ThreadResumeParams` does not accept `environments`, so we only send it on start (relying on app-server's sticky behavior).

2. Trim `config.features` to the surfaces NOT covered by `environments: []`: hosted modalities (image_generation, web_search_*), plugin / MCP discovery (tool_search, tool_suggest, tool_call_mcp_elicitation, builtin_mcp, plugins, apps, enable_mcp_apps), multi-agent / fan-out (multi_agent, multi_agent_v2, enable_fanout), request_permissions_tool, experimental code surfaces (code_mode, goals, memories), and workspace_dependencies. The previous shell_tool / unified_exec / apply_patch_freeform / apply_patch_streaming_events / browser_* / computer_use / in_app_browser entries are now redundant — `environments: []` covers them structurally.

Surfaces still un-disable-able from this seam: `update_plan` and `request_user_input` are unconditional in codex's tool registry. They are benign in practice (plan mutation is session-local; `request_user_input` blocks on an MCP elicitation reply that never arrives under openai-compat). `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` are gated by codex's per-server `mcp_tools` config rather than a feature flag — out of scope for this change.