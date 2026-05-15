# @vicoop-bridge/client

## 0.16.0

### Minor Changes

- 4075b13: Fix the codex backend leaving an orphaned `codex app-server` subprocess
  after the daemon exits (#186). The `Backend` interface gains an optional
  `stop()` hook; `Client.stop()` invokes it before returning, and the codex
  backend uses it to SIGTERM the long-lived `app-server` child that
  otherwise outlived SIGINT/SIGTERM on the daemon.

  Always-on service registration has been removed pending a redesign:
  `install.sh` no longer writes a `vicoop-client.service` unit or env
  template (the `INSTALL_SKIP_SERVICE` / `INSTALL_SERVICE_SCOPE` env vars
  are gone), and `vicoop-client upgrade` no longer tries to
  `systemctl try-restart` after swapping the bundle. Restart the daemon
  manually with whatever supervisor you use until the new design lands.
  `setup --write-env-file` is unchanged; it now describes itself as a
  generic shell-sourceable env file rather than a systemd
  `EnvironmentFile=`.

- 7218b61: Ship `@vicoop-bridge/client` as a self-contained native binary per platform
  (macOS arm64/x64, Linux arm64/x64, Windows x64) instead of a Node.js
  portable bundle (#188). The release no longer requires Node.js on the
  host: `install.sh` now downloads
  `vicoop-client-<version>-<os>-<arch>[.exe]` + its `.sha256`, verifies
  integrity, and drops the macOS quarantine xattr so first launch isn't
  Gatekeeper-blocked. The binary is produced by `bun build --compile` from
  a single Linux runner via cross-compile (`oven-sh/setup-bun@v2` in
  `release.yml`).

  The asset layout, install path, and upgrade flow change in lock-step:

  - **Install path**: `$INSTALL_DIR/vicoop-client` (single file), not
    `$INSTALL_DIR/bin/vicoop-client` + `dist/` + `node_modules/`. Anything
    else the operator leaves under `$INSTALL_DIR` is preserved by upgrades
    by construction (the swap only moves three filenames).
  - **`vicoop-client upgrade`**: rewritten for the binary model. Downloads
    the matching per-platform asset, sha256-verifies, runs `--version` as
    a healthcheck, atomically renames `vicoop-client` →
    `vicoop-client.prev` and `vicoop-client.new` → `vicoop-client`. Dev
    workspace invocations (`tsx src/cli.ts upgrade`, `node dist/cli.js
upgrade`) are now rejected up front because `process.execPath` ends in
    `node` / `tsx` / `bun` rather than `vicoop-client[.exe]`.
  - **Released-bundle `cards/` directory is gone** (closes the A side of
    #164). The bridge already publishes the canonical card per backend;
    `--card <path>` (or `"card"` in `config.json`) is the operator
    override path, and source-tree
    [`packages/client/cards/`](https://github.com/planetarium/vicoop-bridge/tree/main/packages/client/cards)
    remains the documented reference for authoring overrides.
  - **Prerequisites**: Node.js 20+ and `tar` are no longer required by the
    install path. `curl` + `sha256sum`/`shasum` is enough; `jq` is added
    only when `install.sh` auto-resolves the latest tag (skip-able with
    `VERSION=@vicoop-bridge/client@<x.y.z>`).

  This is breaking for anyone who currently scripts against
  `$INSTALL_DIR/bin/vicoop-client` or extracts the released `.tgz`
  directly — both go away.

- 6ce7428: Migrate the `vicoop-client` argv parsers to [optique](https://github.com/dahlia/optique),
  a type-safe parser-combinator library, as a PoC for #189. The hand-rolled
  `for (let i = 0; i < args.length; i++)` loops that lived in `cli-args.ts`,
  `login.ts`, `setup.ts`, `whoami.ts`, `admin-cli.ts`, and `cli.ts` (upgrade)
  are gone — one optique grammar per subcommand replaces them.

  The user-visible behavior changes that land with this:

  - **`--flag=value` is accepted everywhere** (#189 §2). The old parser
    silently dropped `--backend=claude` and fell through to the `'echo'`
    default with no error; it now parses identically to `--backend claude`.
  - **Every env-only backend knob now has a CLI flag** (#189 §1):
    `--claude-cwd`, `--claude-settings-file`, `--codex-cwd`,
    `--codex-sandbox`, `--openclaw-gateway`, `--openclaw-gateway-token`,
    `--openclaw-agent`, `--openclaw-openai-compat-agent`,
    `--openclaw-task-timeout-ms`. Flag wins over env wins over `backends.*`
    in `config.json`. The corresponding `CLAUDE_CWD` / `CODEX_SANDBOX_MODE` /
    `OPENCLAW_*` env vars are still honoured for systemd compatibility.
  - **`--server` falls back to a built-in `DEFAULT_BRIDGE_URL`** (#189 §6,
    `wss://vicoop-bridge-server.fly.dev`); `--bridge` on `login` falls back
    to `DEFAULT_BRIDGE_HTTPS_URL` (`https://vicoop-bridge-server.fly.dev`).
    A fresh install on the public bridge no longer needs `--server` /
    `SERVER_URL` for the daemon or `--bridge` for `login`.
  - **Typo'd flags are rejected** instead of silently ignored. The old
    parser passed unknown `--whatever` through, which masked real mistakes
    (a misspelled flag would fall all the way through every fallback to
    the wrong default with no signal).
  - **Enum validation happens at parse time.** `--codex-sandbox banana`
    now reports the bad value at the parser layer with a list of accepted
    values, rather than exiting later from `parseCodexSandboxMode` in
    `cli.ts`.
  - **Env vars are removed from the runtime config chain entirely**
    (#189 §5). The daemon no longer reads `SERVER_URL`, `SERVER_TOKEN`,
    `AGENT_ID`, `BACKEND`, `AGENT_CARD`, `CLAUDE_CWD`,
    `CLAUDE_SETTINGS_JSON`, `CODEX_CWD`, `CODEX_SANDBOX_MODE`,
    `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT`,
    `OPENCLAW_OAI_COMPAT_AGENT`, `OPENCLAW_TASK_TIMEOUT_MS`,
    `OPENCLAW_THINKING`, `OPENCLAW_DEBUG`, or `OPENCLAW_PROCESS_NAME`.
    `vicoop-client whoami` no longer falls back to `AGENT_ID` /
    `SERVER_URL` env either — it reads the canonical `config.json`. The
    resulting precedence is **CLI flag > `--config <path>` > canonical
    config.json > built-in default**. Operators with env-only setups need
    to either run `setup` (persists credentials into `config.json`) or
    pass the equivalent CLI flags. Env vars the client still reads
    (different category — config _location_, not config _content_):
    `VICOOP_HOME`, `XDG_CONFIG_HOME`, `HOME` (config-dir resolution),
    `VICOOP_BRIDGE` / `VICOOP_OWNER_TOKEN` (admin-command owner-session
    bootstrap), `VICOOP_CLIENT_LOG_LEVEL` (logging diagnostic).
    `vicoop-client setup --write-env-file` still emits a shell-sourceable
    file at the path you pass (useful as a credentials audit / scripting
    hook), but the daemon will no longer consume those env vars on its
    own — point operators at `--config` or `config.json` instead.

  `docs/install-client.md` is updated alongside the parser so the new
  flag forms are the leading examples — Step 6 backend recipes are now
  `vicoop-client --backend claude --claude-cwd …` instead of
  `BACKEND=claude CLAUDE_CWD=…`, the OpenClaw / Claude / Codex sections
  ship flag-keyed knob tables, and the public-bridge examples no longer
  export `BRIDGE_URL`. Self-hosting overrides are collected in one place.

  `vicoop-client --help` (and `help`) now prints **grouped daemon-mode
  help** (#189 §3): Identity / Connection / Backend selection /
  Backend-specific (Claude / Codex / OpenClaw), with a precedence-chain
  footer. Error-path output keeps the short single-line `usage:` form so
  test assertions on `/usage: vicoop-client/` continue to match.

  The `install.sh` systemd unit rewrite (#189 AC#6) stays deferred to
  **#190** — it depends on the supervisor strategy that #190 will decide
  (Linux systemd vs macOS launchd, auto-install vs operator-installed,
  etc.). #187 already removed the half-built systemd auto-registration;
  reintroducing a Linux-only path here would conflict with that.

## 0.15.1

### Patch Changes

- 88fd6c2: Close the built-in-tool leak in the codex backend's openai-compat dispatch path (#183). Under openai-compat the caller's `tools` array is the only legitimate dispatch surface, but `features.shell_tool: false` alone was leaving `exec_command` (and its fallback handlers `local_shell` / `shell_command` / `container.exec`) callable in codex CLI 0.130 — we observed codex actually execute `git clone` via `exec_command` despite the feature disables.

  Two changes on `thread/start` when caller-side tool dispatch is active:

  1. Send `environments: []`. This is sticky on the thread and structurally removes every handler that `spec_plan.rs` gates on `environment_mode.has_environment()` — `shell`, `unified_exec`, `exec_command`, `write_stdin`, `shell_command`, `local_shell`, `container.exec`, `apply_patch`, `view_image` — from the tool registry, regardless of which feature flags are set. The model can no longer dispatch these handlers by name. `ThreadResumeParams` does not accept `environments`, so we only send it on start (relying on app-server's sticky behavior).

  2. Trim `config.features` to the surfaces NOT covered by `environments: []`: hosted modalities (image*generation, web_search*_), plugin / MCP discovery (tool*search, tool_suggest, tool_call_mcp_elicitation, builtin_mcp, plugins, apps, enable_mcp_apps), multi-agent / fan-out (multi_agent, multi_agent_v2, enable_fanout), request_permissions_tool, experimental code surfaces (code_mode, goals, memories), and workspace_dependencies. The previous shell_tool / unified_exec / apply_patch_freeform / apply_patch_streaming_events / browser*_ / computer_use / in_app_browser entries are now redundant — `environments: []` covers them structurally.

  Surfaces still un-disable-able from this seam: `update_plan` and `request_user_input` are unconditional in codex's tool registry. They are benign in practice (plan mutation is session-local; `request_user_input` blocks on an MCP elicitation reply that never arrives under openai-compat). `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` are gated by codex's per-server `mcp_tools` config rather than a feature flag — out of scope for this change.

## 0.15.0

### Minor Changes

- d609ec5: Add per-task timing milestones to codex and claude backends. Each task now
  emits a single structured `[client] timing backend=… taskId=… contextId=…
mapMs=… spawnMs=… firstOutMs=… firstFinalMs=… closedMs=… emitMs=…
totalMs=… state=… code=…` line at the terminal emit, so operators can grep
  per-phase distribution without running a profiler. Emitted at `debug` so
  default `info` level is unchanged; set `VICOOP_CLIENT_LOG_LEVEL=debug` to
  see it.
- 514fc52: Rewrite the `codex` backend to drive one persistent `codex app-server` subprocess over stdio JSON-RPC for the lifetime of the client, instead of spawning `codex exec` per task. The wire-facing A2A surface is unchanged — same `--backend codex`, same `BACKEND=codex`, same `backends.codex` config block, same openai-compat extension, same `tool_call_history`, image FileParts, traceability artifacts, and sandbox modes.

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

- f1406de: Add `vicoop-client list-clients` and `vicoop-client revoke-client` subcommands so an owner can inspect and clean up their own `clients` rows from the CLI without dropping into admin GraphQL or psql (issue #166).

  **Client surface**

  - `vicoop-client list-clients [--bridge URL] [--json]` lists every `clients` row owned by the operator. Output columns are `client_id`, `client_name`, `allowed_agent_ids`, `revoked`, `connected`, `created_at`. `connected` reflects in-memory registry state so orphans left behind by an aborted setup or an exited daemon show up with `connected: false`.
  - `vicoop-client revoke-client <client-id-or-name> [--bridge URL]` resolves either a UUID `client_id` or a unique `client_name` and sets `revoked = true` on the row. An ambiguous name exits non-zero with a list of candidate ids so the operator can retry with the id.
  - Both subcommands authenticate with the existing `vicoop-client login` owner-session bearer — same flow as `add-caller` / `remove-caller`.

  **Server surface**

  - `GET /admin-api/clients` and `DELETE /admin-api/clients/:target` under the same owner-session bearer guard as the existing `/admin-api/agents/*` routes. RLS filters list/delete to the operator's own rows; reads of another principal's rows return 404 (no existence leak), name-resolution ambiguity returns 409.
  - `Registry.disconnectClient(clientId)` closes every live WebSocket bound to a revoked client with new close code **4014 "client revoked"**. (4010 was already taken by the agent-id-owned-by-different-principal path in `ws.ts`.)

  **Daemon behavior**

  - The client daemon's reconnect loop now treats two close codes as terminal: 4014 "client revoked" (the live-disconnect path) and 4005 "bad token" (the relaunch path — a daemon restarted with the same revoked token, or launched with a wrong token in the first place). Both fire `onFatal` and exit non-zero instead of reconnect-looping against a permanently-failing auth. All other close codes still go through the normal exponential-backoff reconnect path.

  **Revocation propagation**

  - Client-token verification in `ws.ts` queries `clients` directly on every WS register (no LRU cache, unlike the 60s `callers` cache documented in `local-testing.md`), so revocation is effectively synchronous from the next auth attempt — and combined with the 4005-terminal client behavior above, a daemon relaunched with the same token after revoke exits at first hello instead of looping. No cache-invalidation work needed on the server side.

  **Schema**

  - No schema migration. The existing `clients.revoked BOOLEAN` column and `revoke_client(TEXT)` PL/pgSQL function are reused as-is. Promoting the column to a `revoked_at TIMESTAMPTZ` for audit-trail purposes is filed as a follow-up — it's orthogonal to the CLI surface this change ships and would have a much larger blast radius (the `client_with_token` TYPE, the admin agent's LLM prompt, and all `SELECT … WHERE revoked = false` predicates would need touching).

  Documentation: a new "Inspecting and revoking your clients" section in `docs/install-client.md` replaces the previous "use the admin agent's CRUD mutations" hand-wave for the cleanup case.

- bc2fbf5: Forward authoritative token counts from the `codex` and `claude` backends as the A2A [openai-compat/v1 response-side `usage`](https://github.com/planetarium/oai2a2a/pull/35) payload, so OpenAI-compatible gateways can surface real numbers in `chat.completion.usage` instead of falling back to a local cl100k_base estimate.

  Wiring:

  - **codex**: parse `turn.completed.usage` (`input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens`) and map 1:1 to the spec — `cached_input_tokens` is already included in `input_tokens` (mirrored to `prompt_tokens_details.cached_tokens`); `reasoning_output_tokens` is a breakdown of `output_tokens`, not additive.
  - **claude**: parse the terminal `result.modelUsage` map and sum across entries. Using top-level `result.usage` would silently underreport because Claude Code can route a single turn through internal sub-models (e.g. haiku for summarisation) whose tokens never appear on `result.usage` but do appear under `modelUsage`. `cacheReadInputTokens` is mirrored losslessly: included in `prompt_tokens` AND surfaced as `prompt_tokens_details.cached_tokens`.

  When the underlying CLI omits usage (older codex versions, claude runs that never produced a `result` event), the agent emits no `usage` key and the gateway falls back to its local estimate — emission is best-effort per the spec.

  The wire shape lives on `Task.status.message.metadata[<openai-compat/v1 URI>].usage` of the final A2A message of the turn, with `total_tokens = prompt_tokens + completion_tokens` computed locally so the MUST invariant holds regardless of what the runtime reports.

## 0.14.0

### Minor Changes

- 62d7f50: Implement the A2A [openai-compat/v1 extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) on the `codex` backend, mirroring the contract added for `claude` in #152. When an inbound `Message.metadata` carries the extension key, the client lifts `system` / `tools` / `tool_choice` out of the payload and materialises them to a per-task instructions file pointed at by `-c model_instructions_file="<path>"` (codex 0.130+; `experimental_instructions_file` is deprecated). The file teaches the spawned `codex` to emit a `{"tool_calls":[{"id":"call_…","function":{"name":"…","arguments":{…}}}]}` envelope when it decides to call a function. Envelope replies are detected on every `agent_message` and surfaced as an A2A `data` part artifact (`extensions: ["…/openai-compat/v1"]`) so the upstream OpenAI-compatible gateway can forward them verbatim as `tool_calls`; non-envelope turns continue to stream as text artifacts.

  The instructions file co-locates with the existing per-task image temp dir when one is present, or a freshly-minted one otherwise — a single cleanup path drains both. Write failures emit `task.fail` with code `input_file_write_failed`. The `codex` agent card now advertises the extension URI under `capabilities.extensions[]`, so cooperating gateways can discover the capability from a card fetch. Tasks that do not carry the extension metadata key are unchanged — no instructions file, no envelope detection, no argv injection.

- aad09b9: Implement the A2A [openai-compat/v1 extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) on the `openclaw` backend, mirroring the contract added for `claude` in #152 and `codex` in #159. Because OpenClaw's `chat.send` RPC has no `system` field — the entire writable channel into the model is the user `message` text — the contract is folded into the user content as tagged XML blocks: `<system_instructions>` carrying the envelope contract + tools + tool_choice, then `<user_message>` carrying the caller's actual prompt. Envelope detection runs on every assistant transcript entry (and on the terminal `chat` event for the non-streaming fallback path) and surfaces matches as A2A `data` part artifacts tagged with `OPENAI_COMPAT_EXTENSION_URI`.

  The `openclaw` agent card now advertises the extension URI under `capabilities.extensions[]` so cooperating gateways can discover it from a card fetch. The card description explicitly flags the contract as **best-effort**: because OpenClaw's wire has no system-prompt seam, reliability depends on the gateway's host model honoring the text-injected instructions. Verified on Anthropic `claude-sonnet-4-6` in repeated probes (5/5 envelope-on-tool-turn, 5/5 anti-loop-on-history-turn); OSS-hosted gateways may require per-model measurement, and tasks against a non-cooperating host model fall through cleanly to the existing text-artifact path with no extension URI tag.

- 62d7f50: Extend the [openai-compat/v1 A2A extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) handling on the `codex` backend with multi-turn `tool_call_history` support (per the consensus on [planetarium/oai2a2a#30](https://github.com/planetarium/oai2a2a/issues/30)), mirroring the claude-side behaviour shipped in #152. When the metadata payload carries a `tool_call_history` array — an OpenAI-shaped record of prior `assistant.tool_calls` and `role:"tool"` returns — the bridge renders it as a `<tool_call_history>...</tool_call_history>` JSON block and prepends it to the user prompt sent to `codex` on stdin, so the model can pick up the conversation where it left off after the gateway executed a tool externally.

  The bridge replays the history unconditionally on every turn (stateless-gateway contract): even when `codex exec resume` brings the model's own prior turn into thread memory, the wire history is the source of truth and gets injected. The shared system-prompt paragraph (from `claude.ts`) pins the anti-loop directive — the model must NOT repeat any call whose `tool_call_id` already appears in the history. A history-only payload (no `system` / `tools` / `tool_choice`) skips the instructions file entirely but still triggers the prompt prepend.

- aad09b9: Extend the [openai-compat/v1 A2A extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) handling on the `openclaw` backend with multi-turn `tool_call_history` support (per the [planetarium/oai2a2a#30](https://github.com/planetarium/oai2a2a/issues/30) consensus), mirroring the claude-side behaviour shipped in #152 and the codex-side behaviour shipped in #159. When the metadata payload carries a `tool_call_history` array, the bridge renders it as a `<tool_call_history>...</tool_call_history>` JSON block and inserts it between the `<system_instructions>` and `<user_message>` wrappers in `chat.send.message`, so the model reads the prior round before the current user turn.

  The bridge replays the history unconditionally on every turn (stateless-gateway contract): even though `chat.send` against the same `sessionKey` resumes a session whose memory may already include the prior turn, the wire history is the source of truth. The shared anti-loop directive from `buildOpenAICompatSystemPrompt` keeps the model from re-emitting a call whose `tool_call_id` already appears in the history.

- aad09b9: Add an opt-in `openaiCompatAgent` / `backends.openclaw.openai_compat_agent` / `OPENCLAW_OAI_COMPAT_AGENT` option that routes tasks carrying the openai-compat extension metadata to a secondary OpenClaw agent name (encoded in the `chat.send.sessionKey` `agent:<name>:<contextId>` prefix), instead of the default `agent`. The operator pairs this with an `agents.list` entry in the OpenClaw gateway config whose `tools.deny=["*"]` disables the host model's native tools (Bash, browser, weather skills, etc.) so the model has no in-host alternative to the envelope contract.

  Motivation: the text-injected envelope contract competes with whatever native tools the host agent advertises in its own system prompt. When both are present, the model frequently satisfies the request with a native skill (Bash + wttr.in, browser, etc.) and ignores the envelope-emit directive. Pilot measurement on anthropic `claude-sonnet-4-6` (`N=10` per arm) on a tool-call-prone weather prompt: envelope compliance was 5/10 with the default `main` agent (full tools), 10/10 when the same request was routed to an `oai` agent configured with `tools.profile=minimal` + `tools.deny=["*"]`. Non-extension tasks continue to flow through the default `agent`, so the split is invisible to callers that don't request the extension.

  When the option is unset (default), all tasks — extension or not — use the single configured `agent`, preserving today's behavior.

## 0.13.1

### Patch Changes

- 3ba7af5: Fix `vicoop-client` daemon exiting on the first WebSocket disconnect instead of reconnecting (#156). `scheduleReconnect()` previously called `.unref()` on the reconnect timer, which left the daemon process with no refed handles after the `close` handler cleared the heartbeat and reconnect-reset timers — Node would drain the event loop and exit before the first reconnect attempt fired, killing the entire exponential-backoff/jitter path. The other `.unref()` calls in the file are kept: the heartbeat and reconnect-reset timers only matter while the WS is open (the WS itself refs the loop then), and the probe-deadline timer is cleared on the fast path. `stop()` still cleans up the now-refed reconnect timer explicitly via `clearReconnectTimer()`, so intentional shutdown remains prompt.

  Production daemons running under a supervisor (systemd `Restart=`, etc.) masked the bug behind automatic restarts; dev / sidecar daemons without a supervisor died on the first network blip.

- 41cb870: Accept A2A `data` parts on the `codex`, `claude`, and `openclaw` backends (#150). Previously, a task whose message included an `application/json` data part alongside the user text failed immediately with `unsupported_part_kind` (claude/codex) or `unsupported_data_part` (openclaw), surprising callers that attach structured metadata as auxiliary context.

  The three backends now serialize each `DataPart.data` into a deterministic, grep-friendly block that is folded into the prompt the LLM sees:

  ```
  <context kind="application/json">
  { ...JSON.stringify(data, null, 2)... }
  </context>
  ```

  For codex/openclaw the block is appended to the prompt text (after any text parts); for claude it is emitted as an additional `type: 'text'` content block following the primary text. Mixed `text+data`, `data`-only, and `text+data+file` messages are all accepted; only a fully empty message still fails with `empty_prompt`. The canonical server agent cards for `codex`, `claude`, and `openclaw` now advertise `application/json` in `defaultInputModes` so callers can discover the capability from the card.

## 0.13.0

### Minor Changes

- f9f52b3: Implement the A2A [openai-compat/v1 extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) on the `claude` backend. When an inbound `Message.metadata` carries the extension key, the client lifts `system` / `tools` / `tool_choice` out of the payload and folds them into a per-task `--append-system-prompt` that teaches the spawned `claude` to emit a `{"tool_calls":[{"id":"call_…","function":{"name":"…","arguments":{…}}}]}` envelope when it decides to call a function. Envelope replies are detected at every assistant turn and surfaced as an A2A `data` part artifact (`extensions: ["…/openai-compat/v1"]`) so the upstream OpenAI-compatible gateway can forward them verbatim as `tool_calls`; non-envelope turns continue to stream as text artifacts.

  `tool_choice` is honored at the prompt level: `"auto"` adds a soft directive, `"required"` and `{type:"function", function:{name}}` mandate the envelope, and `"none"` suppresses the envelope contract entirely and instructs the model to answer in natural language. The `claude` agent card now advertises the extension URI under `capabilities.extensions[]`, so cooperating gateways can discover the capability from a card fetch. Tasks that do not carry the extension metadata key are unchanged — no system-prompt injection, no envelope detection.

- f9f52b3: Extend the [openai-compat/v1 A2A extension](https://github.com/planetarium/oai2a2a/extensions/openai-compat/v1) handling on the `claude` backend with multi-turn `tool_call_history` support (per the consensus on [planetarium/oai2a2a#30](https://github.com/planetarium/oai2a2a/issues/30)). When the metadata payload carries a `tool_call_history` array — an OpenAI-shaped record of prior `assistant.tool_calls` and `role:"tool"` returns — the bridge renders it as a `<tool_call_history>...</tool_call_history>` JSON block and prepends it to the user content sent to `claude`, so the model can pick up the conversation where it left off after the gateway executed a tool externally.

  The bridge replays the history unconditionally on every turn (stateless-gateway contract): even when `--resume` brings the model's own prior turn into session memory, the wire history is the source of truth and gets injected. The SYSTEM_INSTRUCTION grows by one paragraph explaining the block format and pinning an anti-loop directive — the model must NOT repeat any call whose `tool_call_id` already appears in the history, otherwise tool turns chain forever. Whole-array validation: a malformed entry drops the entire history rather than leaving a hole, since `tool_call_id` pairings depend on order.

## 0.12.1

### Patch Changes

- b9074af: Make Codex backend usable from any `cwd` and surface backend failure detail (#147). Two changes work together:

  - **Foreground log now includes `error.message` on `task.fail`.** Backends pack stderr tails and exit-status detail into `error.message`, but the lifecycle log emitted only `code=` and dropped the message — forcing operators to enable bridge-side wire-frame tracing just to learn why a task failed. The message is appended via `safeToken` (4 KB cap, line breaks escaped) so the log stays single-line and wire-derived bytes can't break out of it. Host-local detail (argv, absolute cwd) is **not** put into `error.message`; that travels over the wire to the bridge / caller and so stays redacted (see the local repro log below).
  - **Codex backend always passes `--skip-git-repo-check`.** `codex exec` refuses by default to run from a directory that is neither a git repo nor an operator-trusted path, exiting `1` with `Not inside a trusted directory…` in ~200 ms. vicoop agents work in an operator-chosen `cwd` that is often not a git repo, so the new default is to skip codex's cwd-trust ergonomics gate. Sandboxing is unchanged — this is a separate concern from `sandbox_mode`. The flag is deduplicated when also listed in `backends.codex.extra_args`.
  - When `codex exec` exits non-zero (auth errors, usage errors, signal termination, …) the backend writes a local-only `codex exec-failure repro taskId=… argv=… cwd=…` line (logger.warn) so operators can reproduce the failing invocation. The wire-level `task.fail` `error.message` keeps only stderr-tail + exit/signal detail; argv (which carries `--image` temp paths) and `cwd` are host-local and not forwarded to the bridge or the caller. Real spawn(2) failures still use the existing `spawn_failed` error code and emit `task.fail` directly — this repro line is specifically for the codex-started-but-exited-non-zero case.
  - Config accepts `backends.codex.extra_args: string[]`. Entries are validated as a homogeneous string array, then trimmed; whitespace-only entries are dropped (so `" --flag"` and `"   "` don't reach codex argv with stray spaces). Malformed arrays are dropped entirely.

## 0.12.0

### Minor Changes

- e84dc43: Consolidate client state under a canonical `config.json` (#137). `vicoop-client setup` now writes the daemon credentials to a single JSON config; its directory is resolved as `$VICOOP_HOME > (existing) ~/.vicoop > $XDG_CONFIG_HOME/vicoop > ~/.vicoop` — the existing-`~/.vicoop` branch preserves prior installs that already have an `owner-session.json` there, so setting `$XDG_CONFIG_HOME` later doesn't orphan them. The daemon resolves args as CLI flag > env > `--config <path>` > canonical config. `--write-env-file` stays as an opt-in for systemd `EnvironmentFile=`. Existing `SERVER_URL` / `SERVER_TOKEN` / `AGENT_ID` env vars and `owner-session.json` behaviour are unchanged.

  The daemon also prints the agent's `whoami` identity block (mention / acct / a2a endpoint / agent-card URL / WebFinger URL) on first connect, so operators don't have to run `vicoop-client whoami` in a second shell after startup.

  **Backend sandbox defaults flipped on**: the Claude backend now forwards `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}'` when neither `CLAUDE_SETTINGS_JSON` nor `backends.claude.settings` is set, and the Codex backend explicitly passes `-c sandbox_mode="read-only"` (the same effective default Codex CLI applied, now stamped into argv). Operators with sandbox-aware settings keep their override semantics — supplying any value replaces the default. To run without a sandbox, pass `{ "sandbox": { "enabled": false } }` to Claude or `CODEX_SANDBOX_MODE=danger-full-access` to Codex.

## 0.11.0

### Minor Changes

- 58de79c: Claude backend now forwards an operator-supplied Claude Code settings
  JSON to every spawned `claude -p` via `--settings <json>`. The new
  `CLAUDE_SETTINGS_JSON` env var (read by the daemon's `pickBackend`)
  accepts a top-level JSON object; it is parsed at startup, re-serialized
  with `JSON.stringify`, and forwarded as `--settings <json>` on every
  spawn (whitespace and key order may change but the semantic value is
  preserved). Primary use case is enabling the OS-level sandbox (Seatbelt
  on macOS, bubblewrap on Linux) in non-interactive mode, where the
  `/sandbox` slash command is unavailable and on-disk `settings.json`
  is awkward on systemd `DynamicUser=yes` hosts.

  The backend does not validate or merge defaults: operators set the
  shape they want. Malformed JSON or a non-object value fails loud at
  startup (exit 1, named error on stderr) so a typo in a sandbox
  profile surfaces before any task runs unsandboxed. The flag sits
  between identity args and operator `extraArgs`, so an `extraArgs`-
  supplied `--settings` would still win if both are set.

  When the `send_file` MCP server is enabled, operators that turn on
  `sandbox.network.allowManagedDomainsOnly` must allow the loopback
  host themselves — the URL is chosen lazily per task, so the backend
  does not rewrite the operator's JSON to inject it.

  ### Two-layer hardening: sandbox is necessary but not sufficient

  Empirically (Claude Code 2.1.139): `{"sandbox":{"enabled":true}}`
  alone does **not** block reads outside the working directory — the
  sandbox's default read policy is permissive, and the built-in
  Read/Edit/Write tools bypass the OS sandbox entirely (only Bash
  subprocesses are isolated). Operators that want real isolation need
  two layers in the same `--settings` JSON:

  1. `sandbox.filesystem.denyRead` / `allowRead` — blocks Bash
     subprocess reads (covers `gh`, `git`, `npm`, `kubectl`, etc.).
  2. `permissions.deny` rules for `Read(...)` / `Edit(...)` — blocks
     Claude's own internal file tools.

  A vetted starter profile that keeps common dev tooling (`gh`, `git`,
  `npm`/`pnpm`) working while blocking SSH keys, cloud credentials,
  `.env` files, and DNS-shaped exfil tools (CVE-2025-55284 pattern):

  ```json
  {
    "sandbox": {
      "enabled": true,
      "failIfUnavailable": true,
      "allowUnsandboxedCommands": false,
      "filesystem": {
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc"],
        "allowWrite": ["/tmp/vicoop", "~/.npm", "~/.cache/pnpm"]
      },
      "network": {
        "allowManagedDomainsOnly": true,
        "allowedDomains": [
          "github.com",
          "api.github.com",
          "codeload.github.com",
          "objects.githubusercontent.com",
          "uploads.github.com",
          "registry.npmjs.org"
        ]
      }
    },
    "permissions": {
      "deny": [
        "Read(~/.ssh/**)",
        "Read(~/.aws/**)",
        "Read(~/.netrc)",
        "Read(**/.env*)",
        "Bash(ping:*)",
        "Bash(nslookup:*)",
        "Bash(dig:*)",
        "Bash(host:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Bash(nc:*)",
        "Bash(socat:*)"
      ]
    }
  }
  ```

  This is a starting point, not a guarantee — broader `network.allowedDomains`
  opens domain-fronting paths the built-in proxy cannot inspect (the
  proxy does not terminate TLS), and `allowUnsandboxedCommands:false`
  is required to neutralise the documented `dangerouslyDisableSandbox`
  escape hatch (the Ona writeup showed Claude self-disabling the
  sandbox when caught).

  ### Non-obvious gotchas (verified empirically on Seatbelt + claude 2.1.139)

  - **`allowedDomains` must be nested under `sandbox.network`.** Placing
    it at `sandbox.allowedDomains` is silently ignored — every outbound
    request still gets a proxy 403. Easy to miss because no error fires.
  - **`npm`/`pnpm` need their cache dirs in `allowWrite`.** With only
    `/tmp/vicoop` allowed, even `npm view <pkg>` fails with EPERM at the
    cache-write step _after_ the registry fetch succeeds. Add `~/.npm`
    and/or `~/.cache/pnpm`.
  - **`gh` cannot read its macOS Keychain token under Seatbelt.**
    `gh auth status` fails regardless of network policy. If the agent
    needs `gh`, inject the token via `GH_TOKEN` env on the systemd unit
    (a fine-grained PAT scoped to the repos the agent actually touches)
    — matches Anthropic's recommended "credential-injecting proxy"
    pattern.

  ### Observability via OpenTelemetry

  `claude-code` is OTEL-native; the bridge daemon inherits its env
  verbatim. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` plus
  `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_TOOL_CONTENT=1`, and
  `OTEL_LOG_USER_PROMPTS=1` on the systemd unit (see install.sh env
  template) gives a queryable trace of every tool call, file read,
  and user prompt — usable as an audit trail since the agent cannot
  tamper with it once exported.

  Closes #138.

- f9f41e3: `vicoop-client setup --write-env-file` now emits `export KEY=VALUE`
  lines instead of bare `KEY=VALUE`. Sourcing the generated file with
  `. vicoop-client.env` followed by running `vicoop-client whoami` (or the
  daemon) used to fail with `missing required: agentId, server` because
  the assignments stayed shell-local and never reached the child
  process's environment. The `export` prefix makes the source-then-run
  idiom work without needing `set -a` wrappers. The stdout-only `setup`
  output (no `--write-env-file`) gains the prefix too, so piping it into
  a file behaves the same way. Fixes #134.

  systemd's `EnvironmentFile=` consumer is unaffected — the install-time
  template written by `install.sh` to `/etc/vicoop-client.env` (or the
  user-scope equivalent) is unchanged and still uses bare `KEY=VALUE`,
  matching what systemd actually parses.

  `vicoop-client login --write-env-file` (and its deprecated `--env-file`
  alias) is **removed**. In its default mode `login` saves the owner
  bearer to `~/.vicoop/owner-session.json`, and admin subcommands fall
  back to that file via `resolveOwnerSession` whenever the
  `VICOOP_OWNER_TOKEN` / `VICOOP_BRIDGE` env pair is unset — so the
  env-file output was structurally redundant. Scripts that need the raw
  access token without touching the session file can still use
  `vicoop-client login --json`, which prints the token-endpoint response
  to stdout and (intentionally) does not persist. Closes #136.

  The setup-written env file now single-quotes its values
  (`export KEY='value'`) so shell metacharacters in operator input —
  notably AGENT_ID, which the bridge echoes back verbatim — can't
  trigger expansion or command substitution when the file is sourced.

- 3f76593: Add a first-party Codex CLI backend with text/image input, session resume, trace artifacts, and canonical cards.

## 0.10.0

### Minor Changes

- f995db4: claude backend: inject self-identity via `--append-system-prompt` so the
  spawned `claude` recognises its own A2A mention (`@<agentId>@<host>` /
  `acct:<agentId>@<host>`) as a self-reference and responds directly instead
  of calling out to itself via a2a-wallet or any other outbound A2A skill.
  Addresses the failure mode in #128 where a backend Claude tried to a2a-call
  its own canonical address.

  New `vicoop-client whoami` subcommand prints the agent's mention, acct,
  A2A endpoint, A2A agent-card URL, and WebFinger URL — useful for operators
  registering this agent on other agents' allowed-caller lists, sharing the
  A2A endpoint with a caller, or pasting into the OpenClaw gateway persona
  (OpenClaw's `chat.send` has no per-message system field, so its persona is
  configured separately on the gateway). `--verify` actually performs the
  WebFinger lookup to confirm the bridge resolves the acct; `--json` emits a
  machine-readable record.

- a390f51: Switch release tag format from `client-v<version>` to the Changesets monorepo
  standard `@vicoop-bridge/client@<version>`. `install.sh`, `vicoop-client
upgrade`, and the release workflow now target the new format only; the prior
  `client-v*` releases remain on GitHub but are no longer extended. `--version`
  accepts a bare semver (`0.9.1`), `v0.9.1`, or the full new tag.

## 0.9.0

### Minor Changes

- Split owner login from client setup and add one-step setup support for creating client tokens, writing daemon env files, and optionally configuring allowed callers.
