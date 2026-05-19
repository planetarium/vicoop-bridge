# Spike: native function-call surface for openai-compat caller tools (codex backend)

Tracks: [#209](https://github.com/planetarium/vicoop-bridge/issues/209) — replace the `{"tool_calls":[…]}` text envelope (PR #208) with codex's native dynamic-tools / function-call surface for the openai-compat A2A extension.

Codex reference: `openai/codex` tag `rust-v0.130.0`, matching `codex-cli 0.130.0` (the version vicoop-bridge ships against).

## TL;DR

`ThreadStartParams.dynamicTools` already exists, is wired all the way through codex's tool router, and is gated behind `experimentalApi` — the capability vicoop-bridge already opts in to. Each spec is exposed to the model as a real Responses-API `function` tool; when the model calls it, codex sends the client a JSON-RPC server request `item/tool/call` with `DynamicToolCallParams { threadId, turnId, callId, namespace, tool, arguments }`, then blocks the turn until the client replies with `DynamicToolCallResponse { contentItems, success }`.

No code change in codex is needed. No MCP server impersonation is needed. The bridge can replace the envelope-text path with a small surface on top of the existing `AppServerRpcClient` — translate the caller's `tools` metadata to `dynamicTools` on `thread/start`, register an `item/tool/call` handler, and route the call back to the A2A caller as a `tool_calls` artifact (same wire shape PR #208 already emits), then `turn/interrupt` so the next A2A turn from the caller delivers results via `tool_call_history` and the existing `historyToInjectItems` path resumes naturally.

Recommendation: replace the envelope path on the codex backend outright. No capability negotiation, no fallback — see Section 4 for why the wire shape to the caller is unchanged so callers don't need to opt in.

## 1. Research question 1 — `ToolRouterParams.dynamic_tools`

### 1a. What it is

`DynamicToolSpec` is a first-class protocol type:

```rust
// codex-rs/protocol/src/dynamic_tools.rs:10-18
pub struct DynamicToolSpec {
    pub namespace: Option<String>,
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
    pub defer_loading: bool,
}
```

It is reachable through three converging paths into `ToolRouterParams`:

1. **`thread/start` parameter** (the one we care about). `ThreadStartParams.dynamic_tools` is `Option<Vec<DynamicToolSpec>>`, gated behind `#[experimental("thread/start.dynamicTools")]`:

   ```rust
   // codex-rs/app-server-protocol/src/protocol/v2/thread.rs:151-153
   #[experimental("thread/start.dynamicTools")]
   #[ts(optional = nullable)]
   pub dynamic_tools: Option<Vec<DynamicToolSpec>>,
   ```

2. The app-server's thread processor validates and forwards the specs into `SessionConfiguration.dynamic_tools`:

   ```rust
   // codex-rs/app-server/src/request_processors/thread_processor.rs:1035-1049
   let dynamic_tools = dynamic_tools.unwrap_or_default();
   let core_dynamic_tools = if dynamic_tools.is_empty() {
       Vec::new()
   } else {
       validate_dynamic_tools(&dynamic_tools).map_err(invalid_request)?;
       dynamic_tools.into_iter().map(|tool| CoreDynamicToolSpec { ... }).collect()
   };
   ```

3. Core copies them into `TurnContext.dynamic_tools` at session creation; `built_tools` in `session/turn.rs` then hands them to the registry via `ToolRouterParams.dynamic_tools`:

   ```rust
   // codex-rs/core/src/session/turn.rs:1271
   dynamic_tools: turn_context.dynamic_tools.as_slice(),

   // codex-rs/core/src/tools/spec_plan.rs:407
   for tool in params.dynamic_tools {
       // registers DynamicToolHandler::new(handler_name) as a model-visible tool
   }
   ```

`defer_loading` (alias `exposeToContext = false`) controls model visibility: when `false`, the tool is in the registry AND in the model-visible spec; when `true`, it's discoverable via `tool_search` but not in the default prompt. For the openai-compat case the caller wants the tool **visible**, so `deferLoading: false` (the default).

### 1b. Per-thread / per-task scoping

Yes. `SessionMeta.dynamic_tools` is captured at thread start and persisted in the rollout (`codex-rs/protocol/src/protocol.rs:2732`). Resumed threads re-hydrate the same set from `state_db::get_dynamic_tools` or the rollout meta (`codex-rs/core/src/session/mod.rs:553-584`). Two threads spawned by the same app-server process can carry **different** `dynamicTools` sets — no global registry collision.

For vicoop-bridge this is the desired isolation: each A2A `contextId` maps to one codex thread, and each `thread/start` injects the caller's tool set for that thread only.

### 1c. How the model's `function_call` is routed back

The full round-trip is observable end-to-end in the upstream test:

```
// codex-rs/app-server/tests/suite/v2/dynamic_tools.rs:391-419
// (after thread/start + turn/start, when the model emits a function_call)
let request = mcp.read_stream_until_request_message().await??;
let (request_id, params) = match request {
    ServerRequest::DynamicToolCall { request_id, params } => (request_id, params),
    other => panic!("expected DynamicToolCall request, got {other:?}"),
};
// params: DynamicToolCallParams { threadId, turnId, callId, namespace, tool, arguments }

let response = DynamicToolCallResponse {
    content_items: vec![DynamicToolCallOutputContentItem::InputText {
        text: "dynamic-ok".to_string(),
    }],
    success: true,
};
mcp.send_response(request_id, serde_json::to_value(response)?).await?;
```

The wire method (TypeScript schema, `codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts`):

```ts
{ "method": "item/tool/call", id: RequestId, params: DynamicToolCallParams }
```

The bridge's `AppServerRpcClient.setServerRequestHandler` already routes server requests (`packages/client/src/backends/codex-rpc.ts:436-461`); today it only handles approval prompts, but the handler signature already takes `(id, method, params) => Promise<unknown>`, so adding `item/tool/call` is a one-branch addition.

Verdict on RQ1: **viable, no upstream work needed**.

## 2. Research question 2 — MCP impersonation fallback

Out of scope given (1) is viable. For the record: it's also possible (codex's connection_manager is process-level, but per-thread `config.mcp_servers` overrides do reach the merged Config — they just don't trigger reconnection mid-process). Concurrency-wise it would need a per-thread mux, which is materially more code than the dynamicTools route. Recommend revisiting only if (1) hits a blocker the spike didn't surface.

## 3. Research question 3 — reliability comparison

Out of scope for the document part of the spike — needs 20+ trials on a real model and codex stack. Empirically though, the failure modes the issue calls out (prose-prefixed envelope, malformed JSON across batched calls, step-2 narration without follow-through) all originate in the model treating tool-emit as **assistant-text generation**. The dynamicTools path emits `function_call` items through codex's native parser path; the failure surface that envelope parsing creates is structurally absent.

The comparison run can be a follow-up: same `#207` prompt ("create a static todo app"), same model, same N, three counters (success / json_parse_failure / step2_no_call). Land it as a separate scripted experiment under `packages/client/scripts/` once the dynamicTools path is wired into the codex backend proper.

## 4. Research question 4 — capability negotiation

**Not needed.** The dispatch choice is entirely bridge-internal; the wire shape the caller sees is unchanged in both directions:

1. **Output to caller** — `tool_calls` artifact stays identical (`{"tool_calls":[{"id","function":{"name","arguments"}}]}`). The bridge constructs it from `DynamicToolCallParams` instead of parsing it out of assistant text, but the artifact emitted upstream is byte-equivalent.
2. **Input from caller on follow-up** — `tool_call_history` continues to work as-is. The existing `historyToInjectItems` (`packages/client/src/backends/codex.ts:313`) already maps history to native `function_call` / `function_call_output` Responses-API items via `thread/inject_items`. No change.

Because both directions are unchanged from the caller's perspective, an opt-in field would only let callers opt **into a worse path** for no reason. Drop the envelope path on the codex backend wholesale.

(claude / openclaw backends keep the envelope path — they have no equivalent of `dynamicTools`. This spike is codex-only.)

## 5. Research question 5 — codex protocol fit

Methods inspected in `codex-rs/app-server-protocol/schema/typescript/v2/`:
- `ThreadStartParams.dynamicTools` — the field this spike depends on (experimentalApi).
- `DynamicToolSpec` — `{ namespace?, name, description, inputSchema, deferLoading? }`.
- `DynamicToolCallParams` — `{ threadId, turnId, callId, namespace, tool, arguments }`.
- `DynamicToolCallResponse` — `{ contentItems, success }`.
- `DynamicToolCallOutputContentItem` — `{ type: "inputText", text }` | `{ type: "inputImage", imageUrl }`.
- `ThreadItem.dynamicToolCall` — the per-item status surface that `item/started` / `item/completed` notifications fire for. Useful for tracing but not strictly required.

No `thread/register_tool` or `tool/inject` mid-thread method exists — tools are fixed at `thread/start`. For the openai-compat use case this matches the caller's request shape exactly (the OpenAI request carries the tool list per-call; we map it onto one thread).

`experimentalApi` is already opted in by vicoop-bridge (`packages/client/src/backends/codex-rpc.ts:54-56`), so no client-side capability change is required.

## 6. Recommendation

**Replace the envelope path on the codex backend with `dynamicTools`. Rough effort estimate:**

1. `codex-rpc.ts` — extend `ThreadStartParams` with `dynamicTools?: DynamicToolSpec[]`; add `item/tool/call` to the server-request method enum; add `DynamicToolCallParams` / `DynamicToolCallResponse` types. ~30 LOC.
2. `codex.ts` —
   - Convert `OpenAICompatMetadata.tools` (OpenAI tool spec shape) to `DynamicToolSpec[]` (camelCase). OpenAI's `{ type: "function", function: { name, description, parameters } }` ⇒ `{ name, description, inputSchema: parameters }`. ~40 LOC + tests.
   - Delete the envelope-specific scaffolding when `callerToolDispatchActive(openaiCompat)`:
     - `developerInstructions` no longer carries the envelope-teaching block (`buildOpenAICompatSystemPrompt` becomes a no-op for the tool surface; the caller's `system` text still flows through).
     - `environments: []` and the `features.*: false` wall come out — the model never sees the envelope contract, so it has no incentive to dispatch the built-in shell as a tool-call substitute. (Removing them simplifies #183's gymnastics.)
     - `tryParseToolCallsEnvelope` and the `emitAgentArtifact` envelope branch are removed.
   - Add a server-request handler branch for `item/tool/call` that:
     - Emits a `task.artifact` containing the `tool_calls` envelope (same wire shape as today, byte-equivalent — the OpenAI caller sees no change).
     - Issues `turn/interrupt`, then responds to the server request with a minimal `DynamicToolCallResponse` so codex unwinds cleanly. The model's `function_call` is already on the wire; the artifact carries it upstream with `finish_reason: "tool_calls"` semantics. On the next A2A turn the caller submits `tool_call_history`, and the existing `historyToInjectItems` path already speaks native Responses-API items.
   - ~120 LOC + tests.
3. `claude.ts` — the helpers stay (claude / openclaw still use them). Just stop the codex backend from calling `buildOpenAICompatSystemPrompt` for the tool block. ~0 LOC if we tighten the call site instead.
4. Test coverage — extend `codex.test.ts` with a dynamicTools roundtrip fake. Drop the envelope tests in `codex.test.ts` (the helpers themselves still have tests via `claude.test.ts`). Net ~80 LOC.

Total: ~270 LOC + tests; the deletions roughly offset the additions. Mostly mechanical given the surfaces already exist.

Migration risk is low because the **caller wire shape is unchanged in both directions** (see Section 4); the only callers that could be affected would be ones depending on the model's prose preamble around the envelope, which by spec they shouldn't.

## 7. PoC

`docs/spikes/native-function-call-surface-poc.mjs` — single-shot Node script. Spawns the real `codex app-server` (codex-cli 0.130.0), runs the full handshake, injects one `DynamicToolSpec`, captures the model's `item/tool/call`, returns a synthetic result, and prints the turn's terminal assistant text. About 200 lines, no dependencies outside Node built-ins, and exits non-zero on any contract violation (no item/tool/call observed, schema mismatch, turn/failed, etc.).

Run it:

```
node docs/spikes/native-function-call-surface-poc.mjs
```

Expected stdout:

```
[poc] spawning codex app-server …
[poc] initialize OK
[poc] thread/start OK threadId=…
[poc] turn/start OK turnId=…
[poc] >>> received item/tool/call name=get_weather args={"city":"Seoul"}
[poc] <<< responded with synthetic result
[poc] turn/completed status=completed
[poc] assistant text: It's 17 °C and sunny in Seoul today.
[poc] PASS
```

The PoC requires a working `codex` on PATH with valid auth (`~/.codex/auth.json`), the same prerequisite the existing `e2e-claude-text-*` scripts have.

## 8. Non-goals

- No wire-shape change to the openai-compat A2A extension in either direction — caller-facing artifacts and `tool_call_history` input stay byte-equivalent (Section 4).
- claude / openclaw backends untouched. Spike is codex-only — the envelope path stays the supported route there because those backends have no equivalent of `dynamicTools`.
- PR #208 stays the supported route on codex until the replacement lands; this spike does not in itself land the replacement.
