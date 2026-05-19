# Native function-call surface for openai-compat caller tools (codex v0.130.0 spike)

Scope: codex backend only, pinned to `openai/codex` tag `rust-v0.130.0`.

## Findings

### 1. `ToolRouterParams.dynamic_tools`

- **[verified via source quote]** `ToolRouterParams` already has a native dynamic-tool slot:

  > `codex-rs/core/src/tools/router.rs:45-52`
  >
  > ```rust
  > pub(crate) struct ToolRouterParams<'a> {
  >     pub(crate) mcp_tools: Option<Vec<ToolInfo>>,
  >     pub(crate) deferred_mcp_tools: Option<Vec<ToolInfo>>,
  >     pub(crate) unavailable_called_tools: Vec<ToolName>,
  >     pub(crate) parallel_mcp_server_names: HashSet<String>,
  >     pub(crate) discoverable_tools: Option<Vec<DiscoverableTool>>,
  >     pub(crate) dynamic_tools: &'a [DynamicToolSpec],
  > }
  > ```

- **[verified via source quote]** `built_tools()` does not synthesize dynamic tools itself; it borrows them from `turn_context.dynamic_tools` on every sampling request:

  > `codex-rs/core/src/session/turn.rs:1149-1273`
  >
  > ```rust
  > pub(crate) async fn built_tools(
  >     sess: &Session,
  >     turn_context: &TurnContext,
  >     input: &[ResponseItem],
  >     explicitly_enabled_connectors: &HashSet<String>,
  >     skills_outcome: Option<&SkillLoadOutcome>,
  >     cancellation_token: &CancellationToken,
  > ) -> CodexResult<Arc<ToolRouter>> {
  >     let mcp_connection_manager = sess.services.mcp_connection_manager.read().await;
  >     let has_mcp_servers = mcp_connection_manager.has_servers();
  >     let all_mcp_tools = mcp_connection_manager
  >         .list_all_tools()
  >         .or_cancel(cancellation_token)
  >         .await?;
  >     let parallel_mcp_server_names = mcp_connection_manager.parallel_tool_call_server_names();
  >     drop(mcp_connection_manager);
  > ```
  >
  > `codex-rs/core/src/session/turn.rs:1263-1273`
  >
  > ```rust
  > Ok(Arc::new(ToolRouter::from_config(
  >     &turn_context.tools_config,
  >     ToolRouterParams {
  >         mcp_tools,
  >         deferred_mcp_tools,
  >         unavailable_called_tools,
  >         parallel_mcp_server_names,
  >         discoverable_tools,
  >         dynamic_tools: turn_context.dynamic_tools.as_slice(),
  >     },
  > )))
  > ```

- **[verified via source quote]** `turn_context.dynamic_tools` is copied from `SessionConfiguration.dynamic_tools` at turn creation and cloned into sub-turns:

  > `codex-rs/core/src/session/turn_context.rs:94`
  >
  > ```rust
  > pub(crate) dynamic_tools: Vec<DynamicToolSpec>,
  > ```
  >
  > `codex-rs/core/src/session/turn_context.rs:572-573`
  >
  > ```rust
  > dynamic_tools: session_configuration.dynamic_tools.clone(),
  > ```
  >
  > `codex-rs/core/src/session/turn_context.rs:277`
  >
  > ```rust
  > dynamic_tools: self.dynamic_tools.clone(),
  > ```

- **[verified via source quote]** `SessionConfiguration.dynamic_tools` is set once at thread/session construction. If caller supplies tools at start, those win; otherwise codex reloads persisted tools for resumed/forked threads:

  > `codex-rs/core/src/session/mod.rs:551-584`
  >
  > ```rust
  > // Respect thread-start tools. When missing (resumed/forked threads), read from the db
  > // first, then fall back to rollout-file tools.
  > let persisted_tools = if dynamic_tools.is_empty() {
  >     let thread_id = match &conversation_history {
  >         InitialHistory::Resumed(resumed) => Some(resumed.conversation_id),
  >         InitialHistory::Forked(_) => conversation_history.forked_from_id(),
  >         InitialHistory::New | InitialHistory::Cleared => None,
  >     };
  >     match thread_id {
  >         Some(thread_id) => {
  >             let state_db_ctx = if config.ephemeral {
  >                 None
  >             } else if let Some(local_store) =
  >                 thread_store.as_any().downcast_ref::<LocalThreadStore>()
  >             {
  >                 local_store.state_db().await
  >             } else {
  >                 None
  >             };
  >             state_db::get_dynamic_tools(state_db_ctx.as_deref(), thread_id, "codex_spawn")
  >                 .await
  >         }
  >         None => None,
  >     }
  > } else {
  >     None
  > };
  > let dynamic_tools = if dynamic_tools.is_empty() {
  >     persisted_tools
  >         .or_else(|| conversation_history.get_dynamic_tools())
  >         .unwrap_or_default()
  > } else {
  >     dynamic_tools
  > };
  > ```
  >
  > `codex-rs/protocol/src/protocol.rs:2464-2477`
  >
  > ```rust
  > pub fn get_dynamic_tools(&self) -> Option<Vec<DynamicToolSpec>> {
  >     match self {
  >         InitialHistory::New | InitialHistory::Cleared => None,
  >         InitialHistory::Resumed(resumed) => {
  >             resumed.history.iter().find_map(|item| match item {
  >                 RolloutItem::SessionMeta(meta_line) => meta_line.meta.dynamic_tools.clone(),
  >                 _ => None,
  >             })
  >         }
  >         InitialHistory::Forked(items) => items.iter().find_map(|item| match item {
  >             RolloutItem::SessionMeta(meta_line) => meta_line.meta.dynamic_tools.clone(),
  >             _ => None,
  >         }),
  >     }
  > }
  > ```
  >
  > `codex-rs/protocol/src/protocol.rs:2730-2733`
  >
  > ```rust
  > pub base_instructions: Option<BaseInstructions>,
  > #[serde(skip_serializing_if = "Option::is_none")]
  > pub dynamic_tools: Option<Vec<DynamicToolSpec>>,
  > ```

- **[verified via source quote]** There is a per-thread injection surface at `thread/start`, but it is experimental-gated and omitted from the stable generated TypeScript schema:

  > `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:148-153`
  >
  > ```rust
  > #[experimental("thread/start.environments")]
  > #[ts(optional = nullable)]
  > pub environments: Option<Vec<TurnEnvironmentParams>>,
  > #[experimental("thread/start.dynamicTools")]
  > #[ts(optional = nullable)]
  > pub dynamic_tools: Option<Vec<DynamicToolSpec>>,
  > ```
  >
  > `codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts:12-19`
  >
  > ```ts
  > export type ThreadStartParams = {model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, /**
  >  * Override where approval requests are routed for review on this thread
  >  * and subsequent turns.
  >  */
  > approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, serviceName?: string | null, baseInstructions?: string | null, developerInstructions?: string | null, personality?: Personality | null, ephemeral?: boolean | null, sessionStartSource?: ThreadStartSource | null, /**
  >  * Optional client-supplied analytics source classification for this thread.
  >  */
  > threadSource?: ThreadSource | null};
  > ```

- **[verified via source quote]** There is no per-turn dynamic tool injection field in the published v2 schema:

  > `codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts:13-45`
  >
  > ```ts
  > export type TurnStartParams = {threadId: string, input: Array<UserInput>, /**
  >  * Override the working directory for this turn and subsequent turns.
  >  */
  > cwd?: string | null, /**
  >  * Override the approval policy for this turn and subsequent turns.
  >  */
  > approvalPolicy?: AskForApproval | null, /**
  >  * Override where approval requests are routed for review on this turn and
  >  * subsequent turns.
  >  */
  > approvalsReviewer?: ApprovalsReviewer | null, /**
  >  * Override the sandbox policy for this turn and subsequent turns.
  >  */
  > sandboxPolicy?: SandboxPolicy | null, /**
  >  * Override the model for this turn and subsequent turns.
  >  */
  > model?: string | null, /**
  >  * Override the service tier for this turn and subsequent turns.
  >  */
  > serviceTier?: string | null | null, /**
  >  * Override the reasoning effort for this turn and subsequent turns.
  >  */
  > effort?: ReasoningEffort | null, /**
  >  * Override the reasoning summary for this turn and subsequent turns.
  >  */
  > summary?: ReasoningSummary | null, /**
  >  * Override the personality for this turn and subsequent turns.
  >  */
  > personality?: Personality | null, /**
  >  * Optional JSON Schema used to constrain the final assistant message for
  >  * this turn.
  >  */
  > outputSchema?: JsonValue | null};
  > ```

- **[verified via source quote]** The callback path is native and async. When the model calls a dynamic tool, app-server emits a structured request to the client and waits for a structured reply:

  > `codex-rs/app-server/src/bespoke_event_handling.rs:790-828`
  >
  > ```rust
  > EventMsg::DynamicToolCallRequest(request) => {
  >     let call_id = request.call_id;
  >     let turn_id = request.turn_id;
  >     let namespace = request.namespace;
  >     let tool = request.tool;
  >     let arguments = request.arguments;
  >     let item = ThreadItem::DynamicToolCall {
  >         id: call_id.clone(),
  >         namespace: namespace.clone(),
  >         tool: tool.clone(),
  >         arguments: arguments.clone(),
  >         status: DynamicToolCallStatus::InProgress,
  >         content_items: None,
  >         success: None,
  >         duration_ms: None,
  >     };
  >     let notification = ItemStartedNotification {
  >         thread_id: conversation_id.to_string(),
  >         turn_id: turn_id.clone(),
  >         started_at_ms: request.started_at_ms,
  >         item,
  >     };
  >     outgoing
  >         .send_server_notification(ServerNotification::ItemStarted(notification))
  >         .await;
  >     let params = DynamicToolCallParams {
  >         thread_id: conversation_id.to_string(),
  >         turn_id: turn_id.clone(),
  >         call_id: call_id.clone(),
  >         namespace,
  >         tool: tool.clone(),
  >         arguments: arguments.clone(),
  >     };
  >     let (_pending_request_id, rx) = outgoing
  >         .send_request(ServerRequestPayload::DynamicToolCall(params))
  >         .await;
  >     tokio::spawn(async move {
  >         crate::dynamic_tools::on_call_response(call_id, rx, conversation).await;
  >     });
  > }
  > ```
  >
  > `codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts:1-6`
  >
  > ```ts
  > export type DynamicToolCallParams = { threadId: string, turnId: string, callId: string, namespace: string | null, tool: string, arguments: JsonValue, };
  > ```
  >
  > `codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts:1-6`
  >
  > ```ts
  > export type DynamicToolCallResponse = { contentItems: Array<DynamicToolCallOutputContentItem>, success: boolean, };
  > ```
  >
  > `codex-rs/app-server/src/dynamic_tools.rs:33-49`
  >
  > ```rust
  > let DynamicToolCallResponse {
  >     content_items,
  >     success,
  > } = response.clone();
  > let core_response = CoreDynamicToolResponse {
  >     content_items: content_items
  >         .into_iter()
  >         .map(CoreDynamicToolCallOutputContentItem::from)
  >         .collect(),
  >     success,
  > };
  > if let Err(err) = conversation
  >     .submit(Op::DynamicToolResponse {
  >         id: call_id.clone(),
  >         response: core_response,
  >     })
  >     .await
  > {
  >     error!("failed to submit DynamicToolResponse: {err}");
  > }
  > ```
  >
  > `codex-rs/protocol/src/protocol.rs:714-720`
  >
  > ```rust
  > /// Resolve a dynamic tool call request.
  > DynamicToolResponse {
  >     /// Call id for the in-flight request.
  >     id: String,
  >     /// Tool output payload.
  >     response: DynamicToolResponse,
  > },
  > ```

- **[verified via source quote]** `thread/inject_items` is history injection only, not tool registration:

  > `codex-rs/app-server-protocol/schema/typescript/v2/ThreadInjectItemsParams.ts:6-10`
  >
  > ```ts
  > export type ThreadInjectItemsParams = { threadId: string,
  > /**
  >  * Raw Responses API items to append to the thread's model-visible history.
  >  */
  > items: Array<JsonValue>, };
  > ```

- **[verified via source quote]** The bridge already has the two local preconditions needed for a native-tool prototype: it opts into `experimentalApi`, and it already models native `function_call` / `function_call_output` history for `thread/inject_items`.

  > `packages/client/src/backends/codex-rpc.ts:45-56`
  >
  > ```ts
  > // app-server gates a number of fields behind `experimentalApi`
  > export interface InitializeCapabilities {
  >   experimentalApi?: boolean;
  > }
  > ```
  >
  > `packages/client/src/backends/codex-rpc.ts:124-153`
  >
  > ```ts
  > export interface FunctionCallItem {
  >   type: 'function_call';
  >   call_id: string;
  >   name: string;
  >   arguments: string;
  > }
  > export type ResponsesApiItem =
  >   | FunctionCallItem
  >   | FunctionCallOutputItem
  >   | { type: string; [key: string]: unknown };
  > export interface ThreadInjectItemsParams {
  >   threadId: string;
  >   items: ResponsesApiItem[];
  > }
  > ```

- **[verified via source quote]** The bridge also has one architectural hazard to fix first: codex thread reuse is currently keyed only by `contextId`, while upstream persists `dynamic_tools` on the thread.

  > `packages/client/src/backends/codex.ts:385-389`
  >
  > ```ts
  > // contextId → (threadId, lastUsedAt). writeId-protected rollback so a
  > // concurrent task on the same contextId doesn't get its session entry
  > // rolled back from under it.
  > const sessions = new Map<string, SessionEntry>();
  > ```
  >
  > `packages/client/src/backends/codex.ts:752-760`
  >
  > ```ts
  > const startResult = await client.request<{ thread: { id: string } }>(
  >   'thread/start',
  >   {
  >     cwd,
  >     sandbox: sandboxMode,
  >     ...(systemPrompt ? { developerInstructions: systemPrompt } : {}),
  >     ...(featuresOverride ? { config: featuresOverride } : {}),
  >     ...(sendEmptyEnvironments ? { environments: [] } : {}),
  >   },
  > );
  > ```

**Answer:** yes, codex v0.130.0 has a native per-thread tool surface via experimental `thread/start.dynamicTools`. It is the cheapest viable path. It is **not** mutable per-turn after thread creation, so the bridge must treat `(contextId, native-tool-surface)` as part of the session identity or disable reuse while native caller tools are active.

### 2. MCP server impersonation fallback

- **[verified via source quote]** MCP tool enumeration is per-session, not per-turn:

  > `codex-rs/core/src/state/service.rs:37-39`
  >
  > ```rust
  > pub(crate) struct SessionServices {
  >     pub(crate) mcp_connection_manager: Arc<RwLock<McpConnectionManager>>,
  > ```
  >
  > `codex-rs/core/src/session/turn.rs:1157-1164`
  >
  > ```rust
  > let mcp_connection_manager = sess.services.mcp_connection_manager.read().await;
  > let has_mcp_servers = mcp_connection_manager.has_servers();
  > let all_mcp_tools = mcp_connection_manager
  >     .list_all_tools()
  >     .or_cancel(cancellation_token)
  >     .await?;
  > let parallel_mcp_server_names = mcp_connection_manager.parallel_tool_call_server_names();
  > drop(mcp_connection_manager);
  > ```

- **[verified via source quote]** Refresh is full replacement of the session-level manager, not per-thread registration:

  > `codex-rs/core/src/session/mcp.rs:320-353`
  >
  > ```rust
  > let (refreshed_manager, cancel_token) = McpConnectionManager::new(
  >     &mcp_servers,
  >     store_mode,
  >     auth_statuses,
  >     &turn_context.approval_policy,
  >     turn_context.sub_id.clone(),
  >     self.get_tx_event(),
  >     turn_context.permission_profile(),
  >     mcp_runtime_environment,
  >     config.codex_home.to_path_buf(),
  >     codex_apps_tools_cache_key(auth.as_ref()),
  >     host_owned_codex_apps_enabled,
  >     tool_plugin_provenance,
  >     auth.as_ref(),
  >     elicitation_reviewer,
  > )
  > .await;
  > let mut old_manager = {
  >     let mut manager = self.services.mcp_connection_manager.write().await;
  >     std::mem::replace(&mut *manager, refreshed_manager)
  > };
  > old_manager.shutdown().await;
  > ```

- **[verified via source quote]** Builtins are not suppressible through per-server `enabled=false` because builtin MCP servers always return enabled:

  > `codex-rs/codex-mcp/src/server.rs:42-46`
  >
  > ```rust
  > pub fn enabled(&self) -> bool {
  >     match &self.launch {
  >         McpServerLaunch::Configured(config) => config.enabled,
  >         McpServerLaunch::Builtin(_) => true,
  >     }
  > }
  > ```

- **[verified via source quote]** `McpConnectionManager` exposes only aggregate server state (`has_servers`, `list_all_tools`, `parallel_tool_call_server_names`), not any thread-scoped mux key:

  > `codex-rs/codex-mcp/src/connection_manager.rs:98-100`
  >
  > ```rust
  > pub fn has_servers(&self) -> bool {
  >     !self.clients.is_empty()
  > }
  > ```
  >
  > `codex-rs/codex-mcp/src/connection_manager.rs:133-139`
  >
  > ```rust
  > pub fn parallel_tool_call_server_names(&self) -> HashSet<String> {
  >     self.server_metadata
  >         .iter()
  >         .filter_map(|(name, metadata)| {
  >             metadata
  >                 .supports_parallel_tool_calls
  >                 .then_some(name.clone())
  >         })
  > }
  > ```
  >
  > `codex-rs/codex-mcp/src/connection_manager.rs:368-374`
  >
  > ```rust
  > pub async fn list_all_tools(&self) -> Vec<ToolInfo> {
  >     let mut tools = Vec::new();
  >     for managed_client in self.clients.values() {
  >         let Some(server_tools) = managed_client.listed_tools().await else {
  >             continue;
  >         };
  > ```

- **[hypothesis]** A single bridge-hosted MCP server shared by multiple codex threads would need to expose the union of all active task tools. Because tool discovery is session-wide and model-visible, that leaks tool names/descriptions across tasks unless every tool is task/thread-namespaced in the model-visible name.

- **[hypothesis]** The smallest safe MCP fallback is therefore **one codex app-server process + one MCP shim per active task/tool set**, not one shared app-server process with per-task tool catalogs.

Concurrency pseudocode for the safe fallback:

```text
on start_task(taskId, threadId, toolSet):
  spawn dedicated codex app-server process
  spawn dedicated MCP shim process exposing exactly toolSet
  sessions[taskId] = {
    threadId,
    toolSet,
    pendingCalls: Map<callId, oneshot>,
    cancelled: AbortController,
  }

MCP shim tools/call(name, args, requestId):
  callId = uuid()
  tx, rx = oneshot()
  sessions[taskId].pendingCalls[callId] = tx
  forward structured caller-tool request to awaiting A2A task resolver
  await rx or cancellation
  return structured MCP tool result

on caller_tool_result(taskId, callId, result):
  resolve sessions[taskId].pendingCalls[callId] with result
  delete pendingCalls[callId]

on task_cancel(taskId):
  abort all pendingCalls
  terminate dedicated MCP shim
  terminate dedicated codex app-server
  delete sessions[taskId]
```

**Answer:** MCP impersonation is possible only as a heavier fallback. On v0.130.0 it does not fit the current shared app-server architecture cleanly because MCP registration and tool discovery are session-global.

### 3. Native function-call vs envelope reliability

- **[verified empirically (with command)]** Live comparison was not run in this sandbox because codex CLI is unavailable here:

  ```bash
  $ codex --version
  bash: codex: command not found
  ```

- **[methodology only]** If run outside this sandbox, use the same caller harness, same model (`codex-Mac-pr208` or whatever production-equivalent is under test), same prompt (`#207 create a static todo app`), and two branches only:
  1. current envelope path (`developerInstructions` + `tryParseToolCallsEnvelope`),
  2. native path (`thread/start.dynamicTools` + dynamic tool call request/response).

- **[methodology only]** Record per run:
  - caller-side success (`write` tool actually invoked and files created),
  - end-to-end latency,
  - token usage,
  - malformed output class (`no tool call`, `text instead of call`, `bad JSON`, `schema mismatch`, `unexpected builtin tool use`).

- **[verified via source quote]** The current envelope path in this repo is text-based and parser-dependent:

  > `packages/client/src/backends/claude.ts:584-593`
  >
  > ```ts
  > 'When you decide a function should be called, respond with ONLY a single JSON object (no prose, no code fences, no markdown) of the exact shape:',
  > '{"tool_calls":[{"id":"call_<unique>","function":{"name":"<fn name>","arguments":{<args as JSON object>}}}]}',
  > '- Emit nothing outside the JSON object.',
  > '- Do not execute the function yourself; just emit the call.',
  > ```
  >
  > `packages/client/src/backends/claude.ts:647-661`
  >
  > ```ts
  > export function tryParseToolCallsEnvelope(
  >   text: string,
  > ): (Record<string, unknown> & { tool_calls: unknown[] }) | null {
  >   const trimmed = text.trim();
  >   if (!trimmed.startsWith('{')) return null;
  >   let parsed: unknown;
  >   try {
  >     parsed = JSON.parse(trimmed);
  >   } catch {
  >     return null;
  >   }
  >   if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  >   const obj = parsed as Record<string, unknown>;
  >   if (!Array.isArray(obj.tool_calls)) return null;
  >   return obj as Record<string, unknown> & { tool_calls: unknown[] };
  > }
  > ```

- **[verified via source quote]** The codex backend currently routes such envelopes by parsing assistant text artifacts:

  > `packages/client/src/backends/codex.ts:825-842`
  >
  > ```ts
  > if (openaiCompat) {
  >   const envelope = tryParseToolCallsEnvelope(text);
  >   if (envelope) {
  >     emit({
  >       type: 'task.artifact',
  >       taskId: task.taskId,
  >       artifact: {
  >         artifactId: randomUUID(),
  >         name: 'codex-message',
  >         parts: [{ kind: 'data', data: envelope }],
  >         extensions: [OPENAI_COMPAT_EXTENSION_URI],
  >       },
  >       lastChunk: true,
  >     });
  >     emittedAnyArtifact = true;
  >     return;
  >   }
  > }
  > ```

**Answer:** no numbers from this environment. Methodology is ready; expected direction is that native dynamic tools remove the JSON-envelope failure class entirely, but that remains a hypothesis until live trials are run.

### 4. Capability negotiation sketch

- **[hypothesis]** Add an optional bridge-only hint under the existing openai-compat metadata, e.g.

  ```json
  {
    "tool_dispatch": {
      "preferred": "native_function_call",
      "fallback": "json_envelope"
    }
  }
  ```

- **[hypothesis]** Semantics:
  - `preferred=native_function_call`: caller allows the bridge to use codex native tool registration internally.
  - `fallback=json_envelope`: if backend/runtime cannot honor native mode, bridge stays on the current PR #208 envelope path.

- **[hypothesis]** Fallback story for plain OpenAI Chat Completions callers through `oai2a2a`: no wire change is required. Native-vs-envelope is bridge-internal backend selection; caller-visible A2A artifacts can stay identical to today.

**Answer:** negotiation should be opt-in and bridge-internal. Do not change the on-wire tool result shape until native codex support is proven in a follow-up implementation.

### 5. Codex protocol fit

- **[verified via source quote]** There is no `thread/register_tool`, `tool/inject`, or equivalent runtime registration RPC in the published v2 schema. The only relevant surfaced pieces are:
  - `thread/start.dynamicTools` (experimental, Rust source only in this tag),
  - `DynamicToolCallParams` / `DynamicToolCallResponse`,
  - `thread/inject_items` for history replay.

- **[verified via source quote]** The bridge already opted into the only gating capability that matters here:

  > `packages/client/src/backends/codex-rpc.ts:45-56`
  >
  > ```ts
  > export interface InitializeCapabilities {
  >   experimentalApi?: boolean;
  > }
  > ```

- **[verified via source quote]** The native history path already exists locally and should carry over unchanged under a native tool-registration implementation:

  > `packages/client/src/backends/claude.ts:627-632`
  >
  > ```ts
  > // Note: the `codex` backend bypasses this text-prepend and instead injects
  > // native Responses API `function_call` / `function_call_output` items via
  > // `thread/inject_items` (see historyToInjectItems in codex.ts) — that gives
  > // the model proper native tool-call history rather than a JSON blob it has
  > // to be instructed to interpret. claude / openclaw still use this textual
  > // form because their native conversation channels are different.
  > ```

**Answer:** codex protocol fit is good enough for a codex-only spike. The missing API is not tool execution; it is only typed exposure of `thread/start.dynamicTools` inside this repo's narrow RPC wrapper.

## Recommendation

- **[verified via source quote + hypothesis]** Prefer **`thread/start.dynamicTools`** over MCP impersonation.
  - Verified upside: first-class function-tool surface already exists in codex v0.130.0.
  - Verified downside: tools are thread-scoped and sticky across resume.
  - Hypothesis: that downside is manageable by changing session reuse policy in the bridge.

- **Rough effort estimate**
  - **Prototype:** 1-2 coding days.
  - **Production hardening:** 3-5 coding days.

- **Bridge changes implied relative to PR #208 architecture**
  1. Add an internal native-dispatch mode for the codex backend only.
  2. Extend the local `thread/start` params shape to send experimental `dynamicTools` when opted in.
  3. Handle app-server `DynamicToolCall` server requests and forward them to the caller's async tool resolver.
  4. Keep existing `thread/inject_items` history injection for prior tool rounds.
  5. Reuse the existing built-in suppression (`config.features.* = false`, `environments: []`) so codex builtins do not compete with caller tools.
  6. Change codex thread reuse from `contextId` only to something like `(contextId, dispatchMode, toolSurfaceHash)` or disable reuse while native caller tools are active.
  7. Keep the envelope path as fallback until live reliability data is collected.

## PoC

- **[methodology only]** No executable PoC commit was added in this spike. Reason: this sandbox does not have a runnable codex CLI/model harness.
- **[hypothesis]** Minimal viable PoC for a follow-up implementation:
  1. widen local `ThreadStartParams` to include experimental `dynamicTools`,
  2. map `openaiCompat.tools` to `DynamicToolSpec[]`,
  3. implement `DynamicToolCall` request handling in `AppServerRpcClient`,
  4. run a single `create a static todo app` task and assert caller-side `write` was invoked without parsing assistant text.

## Out of scope

- Production implementation.
- Multi-backend work (`claude`, `openclaw`).
- Changes to the openai-compat A2A wire schema.
- Reliability numbers from live model runs.
