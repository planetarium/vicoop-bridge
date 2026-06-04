# @vicoop-bridge/client

## 0.27.2

### Patch Changes

- c267134: fix(client): qualify caller-tool names in replayed chat_history under claude
  native dispatch. Caller tools are exposed to claude as
  `mcp___vb-caller-tools__<name>`, but the wire `chat_history` records prior
  calls by their bare OpenAI name (e.g. `read`). Replaying the bare name
  conditioned the model to re-emit it; claude then rejected the call with "No
  such tool available: read", the call never reached the caller-tools MCP (so it
  was never captured), the model retried, and the run died at `--max-turns 1`
  with `terminal_reason:"max_turns"` surfaced as `claude_exit_nonzero`. The
  replayed history names are now rewritten to the live MCP ids so the model's
  historical view matches its tool list. As a diagnostic backstop, a "No such
  tool available" tool error now adds a tool-name-mismatch hint to the terminal
  failure message instead of a bare exit-1.

## 0.27.1

### Patch Changes

- 16f8441: fix(client): force `stream_options.include_usage` on streamed vicoop-codex
  calls so the terminal usage chunk is always emitted. Without it the runtime
  could intermittently drop `usage` from the SSE stream, surfacing downstream
  as a silently $0-billed 0-token call (#317).

## 0.27.0

### Minor Changes

- a7dcc72: The `vicoop-codex` backend now streams responses token-by-token in openai-compat mode. Instead of a single buffered `vicoop-codex call` invocation that emitted the whole response as one artifact, the backend now drives a shared `vicoop-codex serve` instance and streams its `POST /v1/chat/completions` (`stream:true`) SSE, emitting each `delta.content` fragment as an incremental `append:true` A2A artifact. The oai2a2a gateway maps these to OpenAI SSE `delta.content` chunks, so callers see sub-second time-to-first-token and progressive rendering (matching the `claude` / `codex` backends fixed in #294). The terminal `chat_completion` envelope (tool_calls assembled from streamed `delta.tool_calls`, usage, finish_reason) is unchanged. The bundled `vicoop-codex` agent card now advertises `capabilities.streaming: true` so the gateway takes the `message/stream` path. Requires a `vicoop-codex` build that exposes the `serve` subcommand; an older binary fails the task with `serve_unavailable`.

## 0.26.0

### Minor Changes

- fd22ef8: Add static API key callers, unified under the `agent callers` command group. `vicoop-client agent callers issue-api-key <agent>` mints a long-lived bearer key — for CI jobs and backend services that can't run the interactive Google/SIWE login — printing the secret exactly once and auto-authorizing its `apikey:<key-id>` principal on the agent (`--ttl-days` overrides the default 365-day lifetime). Keys are just callers: `agent callers list` shows them (TYPE=apikey) and `agent callers remove <agent> apikey:<key-id>` both de-authorizes the principal and revokes the underlying token.

  `agent register` without `--caller` no longer leaves the agent publicly callable: it auto-mints a static API key, seeds `allowed_callers` with the key's principal, and prints the one-time secret (under `api_keys` in `--json`). If minting fails it falls back to the previous public-agent warning. The deprecated `setup` alias keeps its old warning behavior.

### Patch Changes

- 65e3e99: `vicoop-client agent callers list` now renders allowed callers as a plain `TYPE`/`PRINCIPAL` table (matching `agent list` and the other list commands), with a `(no callers — agent is public)` empty-state, instead of the old multi-line `agent:` / `owner_principal:` / `is_public:` header block. The `--json` output is unchanged (it still carries `agent_id`, `owner_principal`, `is_public`, and `allowed_callers`).
- 4f2bcae: Fix `agent callers list/remove <AGENT_ID>` failing to parse. The
  sub-subcommands shared the literal names `list`/`remove` with the
  top-level `agent list`/`agent remove` commands, and optique's
  `longestMatch` resolved the tie in favour of the all-optional top-level
  commands — dropping the `AGENT_ID` positional and erroring with
  "Unexpected option or subcommand: <id>". Reordered the `agent` command
  group so `callers` is matched first.

  Also render `agent callers list` as a `TYPE` / `PRINCIPAL` table; the
  `PRINCIPAL` column keeps the full canonical form so a row can be pasted
  straight into `agent callers remove`.

## 0.25.1

### Patch Changes

- cf56511: Close out #302. The `openclaw` backend now reads the openai-compat
  extension envelope directly off `metadata[URI].chat_completions_request`
  via `parseOpenAICompatEnvelope`, matching the pattern the other three
  backends (`vicoop-codex` / `codex` / `claude`) adopted in the prior
  release. With every backend on the envelope-direct path the legacy
  `parseOpenAICompatMetadata` shim, the `OpenAICompatMetadata`
  decomposed-view interface, and the legacy `{system, tools, tool_choice,
chat_history}`-under-URI back-compat are all removed; the parser is now
  a thin `chat_completions_request` extractor plus the projection helpers
  each backend uses inline.

  No operator-visible behaviour change: openclaw produces the same
  XML-wrapped `<system_instructions>` / `<chat_history>` / `<user_message>`
  blocks it always did, just sourced from the envelope instead of the
  decomposed view.

## 0.25.0

### Minor Changes

- ee80b7d: Align with the **symmetric envelope contract** for the `openai-compat/v1` A2A extension (companion to planetarium/oai2a2a#80 / planetarium/oai2a2a#81).

  **Wire-breaking** for advertising agents (client major bump expected once the project crosses 1.0; using minor under the 0.x convention).

  Response side: codex (app-server), vicoop-codex (CLI), and claude backends now emit a spec-complete `chat_completion` envelope on the terminal A2A status message metadata: `id` / `object` / `created` / `model` / `choices[].{message, finish_reason, logprobs}` / `usage`. Tool calls surface exclusively via `chat_completion.choices[0].message.tool_calls`; the legacy data-part `tool_calls` artifact is no longer emitted from any of the three supported backends.

  A new shared helper `packages/client/src/backends/openai-compat-usage.ts` (`buildOpenAICompatResponseMetadata`, `buildOpenAICompatUsage`) is the single source of truth so the supported backends cannot drift on envelope shape. Each backend synthesizes a stable `id` keyed off the A2A task id (`chatcmpl-codex-…`, `chatcmpl-vicoop-codex-…`, `chatcmpl-claude-…`).

  For codex (app-server) specifically: tool-call-only turns (where codex's `thread/tokenUsage/updated` notification doesn't fire because the turn is interrupted) emit a `{0, 0, 0}` placeholder for `chat_completion.usage` rather than omit the field — the placeholder honestly signals "runtime did not report" while satisfying the new strict usage MUST on the gateway side.

  Request side: `parseOpenAICompatMetadata` now reads `metadata[URI].chat_completions_request` (the envelope) and decomposes it into the existing 4-field `OpenAICompatMetadata` view that backends already consume. The 4 backends (claude / codex / vicoop-codex / openclaw) keep their existing parameter-reading code — the parser is the seam. Legacy decomposed shape (`{system, tools, tool_choice, chat_history}`) still accepted as a transitional compat shim during gateway migration.

  `openclaw` backend is **not** updated to emit the response envelope — out of scope per the supported-backend set (`vicoop-codex` / `codex` / `claude`). openclaw can continue to emit data-part `tool_calls` but is no longer reachable through advertising-agent code paths on the new gateway.

  Also includes a follow-up race fix: claude's post-exit trailing-flush handler now runs before the `settled = true` cleanup so an orphan terminal `result` event (no trailing newline) is not silently dropped. Previously, claude exiting 1 immediately after a multi-tool turn could trip a spurious `claude_exit_nonzero` failure even when claude reported `terminal_reason: "completed"` in stdout.

### Patch Changes

- 93822e3: Implement `envelope.model` forwarding for the three migrated backends (`vicoop-codex` / `codex` / `claude`) so the gateway-resolved model id (planetarium/oai2a2a#80 `ResolvedAgent.modelOverride`) reaches the underlying CLI instead of being silently dropped (#302). Pool slug → resolved model id → backend dispatches to the right model:

  - `vicoop-codex`: adds `model` to the JSON body sent to `vicoop-codex call`. New `resolveCapabilities` probe (`vicoop-codex models --json`) advertises the supported ids on the agent card.
  - `codex`: passes `envelope.model` as `thread/start.config.model` so codex dispatches per-thread instead of using `config.toml`'s pinned default.
  - `claude`: passes `--model <id>` on the claude CLI spawn.

  Each backend validates `envelope.model` against its advertised model list (codex's `model/list`, claude's `probeClaudeModel`, vicoop-codex's `models --json`) and silently falls back to the CLI default when the value is not in the list — defensive against gateways that forward unresolved routing keys (e.g. `a2a/<card-url>`) verbatim.

  The backend-side migration also rewrites all three to read the envelope directly off `metadata[URI].chat_completions_request` instead of going through the legacy `OpenAICompatMetadata` decomposed view. Behaviour is unchanged for operators that aren't routing through an openai-compat gateway; the wire-shape change is invisible end-to-end.

  `openclaw` stays on `parseOpenAICompatMetadata`'s decomposed view — its envelope-direct migration plus the final parser/`OpenAICompatMetadata` shim deletion will land in a follow-up PR (issue #302 strategy step 3+4).

## 0.24.2

### Patch Changes

- eb3de9f: Accept docker-style short aliases on the agent and container CLI groups: `agent list` / `agent callers list` / `container list` also accept `ls`, and `agent remove` / `agent callers remove` / `container remove` also accept `rm`. `agent remove` is now the canonical form of the previous `agent delete` (which keeps working as a third alias). Help output stays a single row per subcommand — the canonical name shows in the listing with the alias noted in the brief.

## 0.24.1

### Patch Changes

- 5270cb6: codex backend: inject self-identity into `developerInstructions` on
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
- 065ab31: Emit incremental artifact chunks for Claude and Codex streaming responses.

## 0.24.0

### Minor Changes

- 49e97bc: `vicoop-client agent register` now accepts the backend's core defaults
  inline so a fresh install can be configured in a single command. Per the
  chosen `--backend`:

  - `claude`: `--cwd`, `--runtime`, `--runtime-name`, `--claude-settings-file`
  - `codex`: `--cwd`, `--runtime`, `--runtime-name`, `--codex-sandbox`
  - `openclaw`: `--openclaw-gateway`, `--openclaw-gateway-token`,
    `--openclaw-agent`, `--openclaw-openai-compat-agent`,
    `--openclaw-task-timeout-ms`

  `--claude-settings-file` is read at register time and its parsed JSON is
  embedded into `backends.claude.settings` so the persisted config.json is
  self-contained. Mismatched pairings (e.g. `--codex-sandbox` with
  `--backend claude`, or any backend-specific flag without `--backend`)
  are rejected up front — before the GraphQL call — so the operator
  never ends up holding a minted token that can't be persisted into a
  coherent config. Only the active backend's slot in `backends.*` is
  touched; other slots survive unmodified and within the active slot
  unspecified fields are preserved.

- cd18578: Migrate the openai-compat A2A extension reader from `tool_call_history`
  to `chat_history` (planetarium/oai2a2a#74). The new field carries every
  prior conversation turn except the trailing user turn (which rides A2A
  `parts` as before), so backends now replay the full multi-turn context
  rather than just the tool round-trips. Plain prior user/assistant text
  turns ride each backend's native conversation channel where one exists
  (claude stream-json envelopes, vicoop-codex Chat Completions `messages[]`,
  codex Responses API `message` items); openclaw folds them into its
  single-channel `<chat_history>` block. Backends also tolerate the
  spec's tool-continuation edge case where A2A `parts` is the placeholder
  `[{ "text": "" }]` and the conversation lives entirely in `chat_history`.
- 95e3540: Promote the daemon entrypoint to an explicit `vicoop-client start`
  subcommand and stop treating bare invocation as "start the daemon".
  Running `vicoop-client` with no arguments now prints the top-level help
  and exits 0, where previous releases would open the bridge WS. The
  flags-only form (`vicoop-client --backend ...`) also no longer starts
  the daemon — it now fails with a parse error pointing at the missing
  subcommand. Replace any operator scripts / systemd units / docker
  commands that ran `vicoop-client …` with `vicoop-client start …`; the
  flag surface is unchanged. The bundled container entrypoint
  (`container/bundled/entrypoint.sh`) rewrites the historical flags-only
  / no-args invocation to `vicoop-client start` before exec'ing, so
  `docker run … <image>` keeps working unchanged.

### Patch Changes

- 96b5a63: fix(vicoop-codex): place the current user turn before tool_call_history

  The vicoop-codex backend assembled the `vicoop-codex call` body as
  `system → tool_call_history → user`, leaving the current user request after
  every prior assistant/tool round. With a growing multi-turn history,
  gpt-5.3-codex read its own request as a brand-new instruction arriving after
  all that tool activity and restarted from the first tool (e.g. re-calling
  `list_workflows` every turn) instead of progressing to completion.

  `buildMessages` now emits `system → user → tool_call_history`, preserving the
  original linear OpenAI conversation order (the user request first, then the
  tool rounds it drove). This matches what the model sees when talking to
  `vicoop-codex serve` directly, eliminating the re-call loop.

## 0.23.1

### Patch Changes

- df42391: Fix the `openai-compat/v1` `params.models` advertise (shipped in 0.23.0)
  not reaching the hello frame from a `vicoop-client upgrade`-installed
  release binary. The bundled card lookup did
  `fileURLToPath(import.meta.url) + '..' + 'cards' + …` and then
  `existsSync`. Under `tsx` (dev) or a Node-run `dist/cli.js` that path
  resolves to a real file, but inside a `bun build --compile` single-file
  binary `import.meta.url` points into Bun's virtual root — the file
  doesn't exist on disk, `existsSync` returns false, the lookup returns
  `null`, and `agentCard` ends up `undefined`. `Client.resolveEffectiveCard`
  short-circuits before `backend.resolveCapabilities()` is even called,
  the daemon ships hello with no inline card, and the server falls back
  to its own canonical card which has no `params.models`. Symptom for
  operators upgrading via `vicoop-client upgrade`: no model advertise
  after relaunch, while `pnpm dev:client` (which runs from disk) worked.

  Replace the fs-based lookup with static JSON imports of the five
  bundled cards (`claude` / `codex` / `echo` / `openclaw` /
  `vicoop-codex`) — Bun's `--compile` embeds statically imported JSON
  into the binary, so dev and release paths converge. Operator-supplied
  `--card <path>` stays fs-based.

## 0.23.0

### Minor Changes

- eee78cd: Add `--backend` to `vicoop-client agent register`. When supplied (one of
  `echo` / `openclaw` / `claude` / `codex` / `vicoop-codex`), the chosen
  backend is persisted into `config.json` alongside the just-minted
  credentials so the daemon picks it up on next start without the
  entrypoint wizard or a separate `--backend` daemon flag. Omitting
  `--backend` leaves any pre-existing `backend` field intact, so
  re-running register to rotate a token does not clobber an operator's
  prior backend choice.
- 7f17aa9: Advertise the underlying model(s) on the `openai-compat/v1` AgentExtension's
  `params.models` slot for the `claude` and `codex` backends, per
  planetarium/oai2a2a#63. The advertise lands on the hello card so A2A callers
  can route by declared model without waiting for the first task.

  - `claude`: a SIGTERM'd probe spawns `claude --output-format stream-json …`
    and reads `model` from the `system/init` event — no LLM call. The
    Claude Code-specific tier suffix (e.g. `[1m]`) is stripped at both
    emission sites (advertise + `usage.model`) so the canonical Anthropic
    id is what callers see.
  - `codex`: the probe drives an `app-server` and calls the `model/list`
    RPC for the full model pool. `reasoning` comes from each entry's
    `supportedReasoningEfforts`. The `default` tag prefers the operator's
    `config.toml` model (the value the spawn actually loads) over
    codex's own recommended `isDefault`.
  - Daemon-wiring fixes that the advertise needed in order to reach
    the server card: load the bundled `cards/<backend>.json` as the
    default inline card on hello (so `resolveCapabilities()` runs at all),
    and raise the outer probe deadline from 3s to 12s so the claude probe
    on hook-heavy operator cwds completes before hello.

  Probes are best-effort and silent on failure; the advertise is omitted
  when the model cannot be determined. Wire semantics are unchanged.

## 0.22.1

### Patch Changes

- cb46e68: `container init`: when `--from-host` is omitted and stdin is a TTY,
  launch the agent CLI's interactive auth flow (`claude setup-token` /
  `codex login --device-auth`) inside the freshly-installed runtime
  container right after the install + compat check. Non-TTY callers (CI,
  piped input) keep the previous hint-only behavior. The daemon
  (`--runtime container`) now also probes the per-kind creds file at
  startup and exits with the same auth hint when it is missing, instead
  of accepting tasks that would fail at first spawn with a
  backend-specific auth error.

## 0.22.0

### Minor Changes

- 2a6518a: Surface Claude Task subagent activity as user-visible bookend messages.
  When the model invokes the built-in `Task` tool, the bridge now emits a
  `claude-message` artifact reading `Task started: <description>` (and a
  matching `Task completed: <description>` / `Task failed: <description>`
  when the subagent's `tool_result` returns). These bookends fire
  regardless of the traceability extension opt-in, closing the otherwise
  silent window between the model's Task call and its final response —
  previously callers (e.g. a Slack relay) saw zero progress while the
  subagent ran and could not tell whether the run had stalled. Artifact
  `metadata.event` carries `subagent-started` / `subagent-completed` /
  `subagent-failed` plus the `toolUseId` so consumers can correlate or
  style the lifecycle.
- b06cb88: Recognize WebSocket close code 4009 (another daemon connected with the
  same `CLIENT_TOKEN`, i.e. the bridge's clientId-level duplicate-token
  collision) as a distinct failure mode: log a dedicated warn line naming
  the cause and the remediation (`pgrep -fl vicoop-client`), and floor the
  next reconnect at `collisionBackoffMs` (default 5 min) so a
  duplicate-token ping-pong damps out within one cycle instead of looping
  at the 30 s exponential-backoff cap forever. 4009 remains non-fatal — if
  the other daemon goes away, this side still recovers on its own.
- ff58d0b: Reshape the Claude subagent lifecycle bookend (added in #274) as a
  proper trace artifact. The previous version emitted unconditionally as
  a `claude-message`, which leaked execution-trace detail to callers
  that had not opted into the traceability extension and made the
  artifact-name semantics ("model's words to the user") incorrect. The
  bookend now rides the same opt-in as `claude-tool-call` /
  `claude-tool-result`:

  - Artifact name: `claude-subagent-event`
  - `extensions: [traceability/v1]` and `metadata.traceType: "subagent-event"`
  - Carries the same lifecycle text (`Task started/completed/failed:
<description>`) plus a structured `data` part
    (`{event, toolUseId, description}`) for correlation
  - Only emitted when the task's `requestedExtensions` (or the inbound
    message's `extensions`) includes the traceability URI

  Trace-aware A2A consumers already render `claude-tool-call` for the
  underlying `Agent` invocation; the bookend pair adds value over that
  alone because text-only subagent results don't fire a
  `claude-tool-result` — without the explicit "completed" marker, trace
  consumers would see "started" with no matching finish event.

  Verified end-to-end against the deployed bridge: trace ON → both
  bookend artifacts plus the raw `claude-tool-call` line up around the
  subagent run; trace OFF → only the model's final `claude-message`,
  nothing else.

### Patch Changes

- 29a8898: Add `vicoop-client container ls` / `list` to show managed runtime container and volume state, plus `container rm` / `remove` for name-based cleanup and named runtime instances for multi-instance workflows. `container rm` removes the container and volumes by default, with `--preserve-volumes` for credential/session retention. `container init` now assigns a runtime name even when `--name` is omitted, stops the initialized container until daemon startup, and fails when the target runtime already exists instead of reinstalling into it.
- efe5823: Require `vicoop-client container init <kind>` before daemon container runtime startup instead of auto-creating missing runtime containers.

## 0.21.0

### Minor Changes

- 58af223: Add the interactive wizard branch (#244 case B) to the bundled
  image's entrypoint. With this, a first-time operator can run

  ```
  docker run -it -v vicoop-data:/data -v vicoop-work:/home/node/work \
    ghcr.io/planetarium/vicoop-bridge-client
  ```

  and complete the entire setup (bridge sign-in, agent registration,
  backend install + sign-in) inside the same `docker run`. After the
  wizard finishes the entrypoint flows straight into daemon mode —
  same image, same command, just with `-it` instead of `-d`.

  The wizard is gated on three conditions, all of which have to hold:

  - `/data/config.json` doesn't exist (fresh boot).
  - None of `VICOOP_BRIDGE_TOKEN` / `VICOOP_AGENT_ID` /
    `VICOOP_BACKEND` is set (any of them signals headless intent;
    we don't want to launch a wizard mid-bootstrap and surprise the
    operator).
  - stdin AND stdout are both TTYs.

  Composition is intentionally thin: every operator-facing
  operation goes through an existing `vicoop-client` subcommand or
  the existing `install-backend.sh` recipe, so the wizard's only
  real surface is the prompts and the transition. Nothing
  duplicates logic from `setup` / `auth login` / `agent register`.

  1. `vicoop-client auth login` — Google device-flow OAuth against
     the bridge. URL + code print to the operator's terminal.
  2. Prompt for backend kind + agent id (default agent id =
     `hostname` so just-hit-enter still produces a valid
     registration).
  3. `vicoop-client agent register --agent-id <id>` — mints the
     one-time AGENT_TOKEN and writes server_url / server_token /
     agent_id into config.json. The `backend` field comes from
     the prompt and gets jq-patched in.
  4. `install-backend.sh <kind>` + the native OAuth helper for
     installable backends. claude → `claude setup-token`; codex →
     `codex login --device-auth`. Both inherit the entrypoint's
     TTY so URL+code flows reach the operator directly without
     needing `docker exec -it`.
  5. Fall through to the existing daemon `exec`. No extra
     `docker run` needed.

  Subsequent `docker start <container>` invocations skip the
  wizard because config.json now exists on the named volume.

  Manual e2e validated by running

  ```
  docker pull ghcr.io/planetarium/vicoop-bridge-client:latest  # after merge
  docker volume create vicoop-bundled-data
  docker volume create vicoop-bundled-work
  docker run --rm -it \
    -v vicoop-bundled-data:/data \
    -v vicoop-bundled-work:/home/node/work \
    ghcr.io/planetarium/vicoop-bridge-client
  # follow the three steps it prints; daemon comes up automatically
  ```

  Headless env-token path (#244 case A) is unchanged. Operators
  who pass `-e VICOOP_BRIDGE_TOKEN=…` etc. skip the wizard and
  keep the production-grade `docker run -d` shape.

- 406e299: CLI cleanup (breaking flag changes):

  - **Unify per-backend `--cwd` / `--runtime`.** The daemon flags `--claude-cwd`, `--codex-cwd`, `--claude-runtime`, `--codex-runtime` are replaced by `--cwd` and `--runtime`. The new flags are scoped to whichever backend `--backend` selects; on the config side, `backends.claude.{cwd,runtime}` and `backends.codex.{cwd,runtime}` keep their per-backend shape. Scripts passing the old flags must update. Pairing `--cwd` / `--runtime` with a backend that doesn't support them (echo / openclaw / vicoop-codex) is now a hard error instead of being silently ignored.
  - **`container init` polish.** Drop the placeholder `--runtime` option (only `container` was implemented; `host` exited with an error); name the `KIND` positional and list its valid values (`claude`, `codex`).
  - **Help output cleanup.** Remove the noisy config-precedence blurb from `--help` (the same content lives in `docs/install-client.md`). Strip internal `#NNN` / `PR <letter>` issue references from operator-facing descriptions and runtime error messages.
  - **Scoped pre-error help.** On parse errors, render the partially parsed subcommand's help (e.g. `vicoop-client container` prints just the `container` group) instead of dumping the full root usage.

## 0.20.0

### Minor Changes

- a7a890d: Rename `agent revoke` to `agent delete` and align with the server's
  hard-delete semantics.

  The server-side soft-delete machinery is being removed (see companion
  server changeset / `feat(server,client)!:` commit); the CLI follows
  suit. The deprecated flat alias `vicoop-client revoke-client` is
  preserved with a deprecation warning that now points at
  `agent delete`, so existing scripts keep working through this
  release — that's why this is shipped as a minor rather than a major
  bump.

  **New / changed**

  - `vicoop-client agent revoke <TARGET>` →
    `vicoop-client agent delete <TARGET>`. The new `delete` subcommand
    prompts `Delete agent "<TARGET>"? [y/N]` before calling the API;
    pass `--yes` / `-y` to skip (required for non-TTY usage like
    scripts and CI).
  - The deprecated `vicoop-client revoke-client` flat alias now points
    at `agent delete` in its warning text. It still calls the same
    endpoint and skips the prompt (preserving script behavior).
  - Daemon close-code 4014 reason text changes from `"client revoked"`
    to `"client deleted"`; the log line is now `client deleted by
owner; stopping`. The behavior (exit non-zero, no reconnect) is
    unchanged.

  **Migration**

  - Interactive users on `vicoop-client agent revoke …`: switch to
    `agent delete …` and confirm the prompt.
  - Scripts on the same: switch to `agent delete --yes …`.
  - Scripts on the legacy `vicoop-client revoke-client …` flat form:
    no immediate action required, but plan to move to `agent delete
--yes` before the deprecated alias is removed.

- fd40f34: Remove `--name` from `vicoop-client agent register`. The flag was a
  display-only label with no authz, routing, or lookup logic tied to it
  (admin UI does not render it; active-agent listings pull from the
  runtime `AgentCard`, not the registration row). The CLI now sends the
  operator-supplied `--agent-id` as `clientName` so the server's
  `register_client()` NOT NULL contract on `agents.name` /
  `clients.client_name` stays satisfied without a schema migration. The
  redundant `name` line in the `agent register` stderr success block is
  dropped for the same reason — it used to just echo the flag back.

  Migration: drop `--name "$CLIENT_NAME"` from your `agent register`
  invocation. The legacy `setup` alias still accepts `--client-name` for
  back-compat (it's already deprecated and slated for removal).

- 14cdfe5: Add `vicoop-client container init <kind>` — operator one-shot
  bootstrap for the external-runtime container profile (#249 PR C).

  Lands the host-side UX that PR #251 (image) and PR #252 (spawn
  adapter + runtime container) left to the operator to wire up by
  hand. Before this, "use container runtime" looked like: docker
  run, docker exec --user 0 chown, docker exec install-backend.sh,
  manually copy creds into the named volume. Now:

  ```
  $ vicoop-client container init codex --from-host
  $ vicoop-client --backend codex --codex-runtime container
  ```

  The command:

  1. Boots the per-backend runtime container (`vicoop-runtime-<kind>`),
     reusing an existing one when present.
  2. Chowns the per-kind subtrees inside `/data/agents/<kind>` and
     `/data/creds/<kind>` to the image's `node` user — works around
     docker's named-volume permission landmine where the mount point
     ends up root-owned even when the image pre-creates and chowns
     it (the volume's empty state takes over at mount time).
  3. Runs the shared `install-backend.sh <kind>` recipe baked into
     the runtime image (PR A).
  4. Probes the installed binary's version via `<bin> --version` and
     verifies it satisfies `BACKENDS_MANIFEST[kind].supportedRange`.
     Bad versions surface a clear error here rather than at first-
     task-time.
  5. With `--from-host`, copies the operator's existing host creds
     into the container creds volume: - claude: macOS Keychain (`security find-generic-password -s
'Claude Code-credentials'`) or `~/.claude/.credentials.json`
     on linux. - codex: `~/.codex/auth.json` plus `~/.codex/config.toml` when
     present.

  `--from-host` is opt-in (off by default) so the Decision §4
  container-creds-isolation default still holds; operators who want
  the convenience explicitly accept the tradeoff.

  Naming: the group reads as `container ...` rather than `backend
...` because the operator's mental model is "wire up the docker
  container hosting my agent CLI"; `backend` is reserved internal
  vocab in the codebase for the Backend interface + BackendKind
  enum. The positional argument is still the backend kind
  (claude / codex).

  Also threads a `user` option through `RuntimeContainer.exec()` so
  the chown step can run as root inside an image whose default user
  is unprivileged.

  Every docker interaction (the per-step `docker exec` inside
  `container init`, the spawn-adapter's per-task `docker exec`,
  and the runtime container lifecycle calls) goes through the
  `docker` CLI as a child process. The operator-side `docker`
  install is already a hard requirement (Decision §6), so this
  adds no new dependency surface — and it sidesteps oven-sh/bun#22412
  (bun's node:http client doesn't yet emit the HTTP 101 'upgrade'
  event docker's hijack protocol relies on), which would otherwise
  deadlock a bun-compiled vicoop-client the first time it tried to
  stream stdio through a programmatic Docker client.

  Out of scope (still PR C-shaped follow-ups if motivated by ops
  feedback):

  - Interactive `claude setup-token` / `codex login --device-auth`
    passthrough as a first-class auth path (today the command
    prints the `docker exec -it …` hint to run yourself).
  - Host-mode install automation (`--runtime host`); today the
    command errors out with a clear "install via the official
    installer" pointer.
  - `container status` / `container rm` siblings — operators still
    reach for `docker ps` / `docker rm -f` / `docker volume rm` for
    those today.

- 6e29469: Add `runtime: 'host' | 'container'` to the claude and codex backends
  (#249 PR B). This is the bridge-client side of the external-runtime
  profile landed in PR A (#251) — when an operator opts in, the agent
  CLI runs inside a long-lived `vicoop-runtime` container the bridge
  client orchestrates via `docker exec`, instead of being spawned as a
  host child process.

  New surface:

  - Config: `backends.claude.runtime` / `backends.codex.runtime` accept
    `'host'` (default) or `'container'`.
  - CLI flags: `--claude-runtime host|container`, `--codex-runtime host|container`.
    Standard precedence (flag > config) applies.
  - A `RuntimeContainer` module (`src/runtime-container.ts`) owns the
    per-backend lifecycle: docker daemon ping, image pull, named-volume
    provisioning (`vicoop-agents-<kind>`, `vicoop-creds-<kind>`,
    `vicoop-sessions-<kind>`), container create with
    `--restart unless-stopped` + `NET_ADMIN/NET_RAW`, reuse of an
    existing container on bridge-client restart, and an explicit stop
    on shutdown.
  - A `SpawnAdapter` module (`src/spawn-adapter.ts`) presents the
    existing `ClaudeSpawnFn` / `AppServerSpawnFn` shape regardless of
    mode. The host implementation is the same `node:child_process.spawn`
    the backends use today; the container implementation runs the
    command via `docker exec` (shelled out as a child process) so the
    backend sees a normal child-handle either way.
  - All docker interactions go through the `docker` CLI as child
    processes — image pull, volume / container lifecycle, and the
    per-task `docker exec` for agent spawn. No programmatic Docker
    client library; the operator-side `docker` install we already
    require (Decision §6) is the dependency surface.

  Decisions reflected (#249 §Decisions):

  - §1 docker CLI as the daemon-interaction surface.
  - §2 `--restart unless-stopped` + bridge-client-side reuse on restart.
  - §3 Per-backend long-lived only; no per-context runtime.
  - §4 Creds in a container-only named volume — the host's `~/.claude`
    never enters the container.
  - §5 Sessions volume mounted into the container so claude/codex
    session resume survives container re-creation.
  - §6 No docker daemon → explicit error from `RuntimeContainer.start()`
    with a "switch to runtime: 'host' or start docker" hint; no
    fallback.
  - §8 The two backend kinds keep their identity; runtime mode is the
    `runtime` field, and backend internals stay unaware of it.

  Out of scope (separate work):

  - Per-context workspace branching (today the host bind-mount is whole).
  - `vicoop-client backend init` operator-UX subcommand (PR C of #249).
  - Bundled-direct image publishing (still off per #250).

### Patch Changes

- 739d776: Auto-detect when the bridge client itself is running inside a
  container (bundled-direct profile, #244) and apply the same
  sandbox-relaxation the external-runtime profile (#249) already
  gets when it spawns an _outside_ runtime container.

  Previously, `--<kind>-runtime container` was the only path that
  flipped claude's `sandbox.failIfUnavailable=false` and codex's
  default to `danger-full-access`. The bundled image's in-container
  `vicoop-client` daemon had no way to know its own context — so it
  defaulted to the host-process safety floor (read-only / refuse-
  unsandboxed) and a codex file-write task got rejected as
  "escalation request was rejected" on the first try.

  Detection delegates to [`is-inside-container`][lib] (37M weekly
  downloads, MIT, single dep on `is-docker`), which already covers
  the signals we care about for the operator footprint
  (`/.dockerenv`, `/run/.containerenv`, `/proc/self/cgroup`,
  `/proc/self/mountinfo`). `pickBackend` treats
  `runtime !== undefined || isInsideContainer()` as the unified
  "already isolated" condition for both claude and codex; the
  runtime-container lifecycle flow is untouched. Operator-explicit
  overrides (`--codex-sandbox …`, claude settings file) always win.

  Verified end-to-end: rebuilt the bundled image, ran headless
  bootstrap, injected codex creds, restarted, and ran a
  `stream` task that writes `/tmp/d.txt` and reads it back —
  previously this rejected on codex's read-only sandbox
  escalation; now it completes cleanly.

  [lib]: https://github.com/sindresorhus/is-inside-container

- 33aa80a: Reorganize #245's container scaffolding to clarify it's the
  **bundled-direct deployment profile**, and prepare for #249's
  **external-runtime profile** to land alongside (not replace) it.

  The two profiles coexist:

  ```
  execution=direct
    - host direct                          (existing bare-metal)
    - bundled bridge container direct      (#244 — this profile)

  execution=container
    - external runtime container           (#249 — landing later)
  ```

  Moved

  - `Dockerfile` → `container/bundled/Dockerfile`
  - `container/entrypoint.sh` → `container/bundled/entrypoint.sh`
  - The non-`bundled/` `container/` content (`install-backend.sh`,
    `backends/*.sh`, `init-firewall.sh`) stays shared between profiles.

  Removed

  - `.github/workflows/release.yml` ghcr image build/push step +
    `packages: write` permission. The bundled image's release pipeline
    will land when the profile is officially supported; until then we
    avoid emitting a "shipped" signal for an image whose design is
    still settling.
  - `installed.json` write at the end of `container/install-backend.sh`
    - the entrypoint's reads of it. Both profiles probe agent CLI
      versions directly (`<bin> --version`) — no on-disk manifest cache.
      See #249 §"State management" for the rationale.
  - The pre-existing `.changeset/container-image-foundation.md` —
    superseded by this changeset and a future bundled-image release
    changeset when the image actually publishes.

  Unchanged from #245's PR 1

  - `vicoop-client info` subcommand (still emits `version`,
    `imageVersion` when running under the bundled image, and the
    backend compat manifest).
  - `vicoop-client upgrade` `VICOOP_BRIDGE_IMAGE` guard — still useful
    inside the bundled image to prevent the overlay-fs upgrade trap.
  - `packages/client/src/backends-manifest.ts` — supportedRange data,
    consumed by both profiles' compat checks.
  - `container/init-firewall.sh`, `container/install-backend.sh`,
    `container/backends/{claude,codex}.sh` — shared assets.

  See #249 for the new external-runtime profile design and #244 for the
  bundled-direct profile it complements.

- cd0634a: Add the external-runtime container image (#249, PR A). Lands the
  agent-agnostic `vicoop-runtime` image alongside the bundled-direct
  profile (#244, `container/bundled/`) so the two profiles can coexist:

  ```
  execution=direct
    - host direct                          (existing bare-metal)
    - bundled bridge container direct      (#244 — container/bundled/)

  execution=container
    - external runtime container           (#249 — container/runtime/)
  ```

  The image is intentionally agent-agnostic: agent CLIs (claude / codex)
  are NOT baked in. The host-resident bridge client provisions them into
  a named volume at backend init time via
  `docker exec <c> install-backend.sh <kind>` (the shared install
  machinery under `container/` works inside either profile's container).
  Container body is `sleep infinity` after firewall init; per-task work
  flows through `docker exec` from the host.

  Published to `ghcr.io/planetarium/vicoop-runtime` from a new
  `.github/workflows/release-runtime.yml` that builds linux/amd64 +
  linux/arm64 on main pushes that touch image inputs (`container/runtime/**`,
  shared scripts under `container/`).

  Bridge client wiring (a `SpawnAdapter` + `runtime: host | container`
  config) lands in PR B of #249. This PR only ships the image so the
  runtime artifact exists by the time the host-side code starts
  exec'ing into it.

- 56d3b8d: Restart the bundled-direct image publish (#244). Adds
  `.github/workflows/release-bundled.yml` so `container/bundled/`'s
  Dockerfile rebuilds and pushes to
  `ghcr.io/planetarium/vicoop-bridge-client` whenever its inputs
  change — paths filter covers `container/bundled/**`, the shared
  `container/` scripts, and the bridge-client source (the image
  embeds the bun-compiled `vicoop-client` binary).

  Companion to PR A's `release-runtime.yml` (#249); the two image
  families now have their own workflows so the changesets/action
  release for the npm artifact stays independent of either image's
  publish schedule. PR #250 removed the in-line bundled push from
  `release.yml` precisely so a separate workflow could own it.

  No bridge-client behavior change — the image artifact was the only
  missing piece between the bundled code on disk (landed in #245,
  reorganized in #250) and operators being able to
  `docker pull ghcr.io/planetarium/vicoop-bridge-client` again.

  `VICOOP_BRIDGE_IMAGE` build-arg is stamped with `<tag>-<full-sha>`
  so `vicoop-client info` / `vicoop-client upgrade`'s in-container
  fingerprint reads more diagnostic than just `latest`.

- a7a890d: Route `node:child_process.spawn` through the shell on Windows so the
  codex / vicoop-codex backends can resolve the npm-installed `.cmd`
  shims (#254).

  `spawn('vicoop-codex', …)` and `spawn('codex', …)` fail with ENOENT
  on Windows because npm publishes the binaries as `.cmd` shims that
  Node cannot resolve without going through `cmd.exe`. Setting
  `shell: process.platform === 'win32'` in both `defaultSpawn`
  (vicoop-codex backend) and `defaultAppServerSpawn` (codex app-server
  RPC) lets win32 take the shim-resolution path; POSIX hosts keep
  `shell: false` to avoid the spawn-with-shell deprecation warning and
  quoting surprises.

  Safe because `command` and `args` at both call sites are fully
  internal to the bridge client (`'vicoop-codex' / ['call']` and
  `'codex' / ['app-server']`); no operator-supplied tokens enter the
  argv, so shell-injection is not a concern.

## 0.19.1

### Patch Changes

- 2d2e3e2: claude backend: pre-approve registered MCP servers via `--allowedTools`
  so the model's tool calls survive operator environments that leave
  claude's permission system at its built-in default (#235).

  claude's permission system runs even in `-p` (non-interactive) mode. With
  the built-in `defaultMode: "default"` and no TTY there's nothing to
  answer a permission prompt, so an MCP tool invocation auto-denies, the
  model never reaches the bridge's `caller-tools-mcp` handler, and the run
  dies at `--max-turns 1` with `permission_denials` in the result event —
  the exact failure path in #235.

  The fix is surgical: for every MCP server the bridge itself registers
  (`caller-tools` for openai-compat caller tools, `vicoop-bridge` for
  `send_file`), append a server-level `--allowedTools mcp__<server>` rule
  to the spawn argv. Built-ins are already off via `--tools ""`, so this
  allowlist only opens the surface we stood up — and operator settings
  retain veto power because claude resolves `deny` rules before `allow`.

  Behaviour without an active MCP server (plain claude tasks) is
  unchanged: `--allowedTools` is only appended when `--mcp-config` is.

- 2d2e3e2: claude backend: namespace internal MCP server registration keys under a
  `_vb-` ("vicoop-bridge") prefix so they cannot collide with
  operator-supplied servers under the same `--mcp-config` map.

  The previous keys were generic enough to clash with operator names —
  `caller-tools` in particular looks like something an operator might
  name their own MCP server, and claude's `--mcp-config` JSON resolves
  collisions last-wins, silently overwriting the bridge's entry.

  Renames:

  - `vicoop-bridge` → `_vb-send-file`
  - `caller-tools` → `_vb-caller-tools`

  Resulting model-visible tool ids change accordingly
  (`mcp___vb-send-file__send_file`, `mcp___vb-caller-tools__<tool>`); the
  bridge's own `--allowedTools` argv is generated from the same map so it
  tracks automatically. No A2A wire change.

  The merger of the two servers under a single namespace is tracked
  separately and naturally lands at `_vb` once #216 (long-lived listener
  for caller-tools) ships.

- 86d8b96: fix(client/codex): anchor injected `tool_call_history` with a user message
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

## 0.19.0

### Minor Changes

- c23b243: claude backend: surface `AskUserQuestion` calls as A2A
  `input-required` instead of silently looping (#221).

  When the spawned `claude` invokes the built-in `AskUserQuestion` tool the
  backend now:

  - closes the task with `task.complete state=input-required` carrying the
    tool call as a `DataPart` on `status.message.parts[0]`
    (`{ kind: 'tool_call', toolName, toolUseId, input }`) so downstream
    clients (e.g. slack-connector) can reconstruct the question via
    `toolCallPartFromLegacyRecord` and render it as interactive UI (Slack
    Block Kit, etc.).
  - writes a placeholder `tool_result` back to claude's stdin and closes
    the stream so the session terminates cleanly and the next turn can
    `--resume` against the same `contextId`.
  - sets an `emittedAskUserQuestion` flag that suppresses any further
    assistant text / `tool_use` events from claude, preventing the retry
    loop where claude re-invokes `AskUserQuestion` upon receiving the
    placeholder.

  No A2A `ask-user-question` artifact is emitted — the terminal
  `input-required` frame is the single source of truth for the multi-turn
  contract. Plain claude tasks that never hit `AskUserQuestion` are
  unaffected.

- c23b243: Add a new `vicoop-codex` bridge client backend that delegates each A2A
  task to the local `vicoop-codex call` CLI (#225).

  `--backend vicoop-codex` (or `"backend": "vicoop-codex"` in
  `config.json`) is now a first-class backend kind alongside `echo`,
  `openclaw`, `claude`, and `codex`. The backend reuses the existing
  4-field openai-compat A2A extension schema
  (`system` / `tools` / `tool_choice` / `tool_call_history`) — no new
  metadata keys, CLI flags, or config knobs are introduced. The
  canonical agent card is published on both the server and the client
  (`packages/{server,client}/cards/vicoop-codex.json`) and the server
  maps the new `backendKind` to it via `card-resolver.ts`.

  Request mapping:

  | A2A metadata (`OPENAI_COMPAT_EXTENSION_URI`) | `vicoop-codex call` body                           |
  | -------------------------------------------- | -------------------------------------------------- |
  | `system`                                     | first entry of `messages` (role `system`)          |
  | `tool_call_history`                          | replayed as `assistant` + `tool` messages in order |
  | `message.parts` (text / data)                | last entry of `messages` (role `user`)             |
  | `tools`                                      | `tools` (verbatim)                                 |
  | `tool_choice`                                | `tool_choice` (verbatim)                           |

  Response mapping:

  - `choices[0].message.content` → `task.artifact` (`text` part)
  - `choices[0].message.tool_calls` → `task.artifact` (`data` part:
    `{ tool_calls: [...] }`, `extensions: [OPENAI_COMPAT_EXTENSION_URI]`)
  - `task.complete.status.message.metadata[OPENAI_COMPAT_EXTENSION_URI]`
    carries `usage` (with `total = prompt + completion` enforced) plus a
    `chat_completion` echo (`id`, `object`, `created`, `model`,
    `choices`, `usage`).

  Exit code → A2A error code:

  | `vicoop-codex` exit | `task.fail.error.code` |
  | ------------------- | ---------------------- |
  | `2`                 | `invalid_input`        |
  | `3`                 | `login_required`       |
  | `4`                 | `upstream_error`       |
  | `5`                 | `network_error`        |
  | other               | `vicoop_codex_failed`  |

  Plus backend-internal codes: `empty_prompt`, `serialize_failed`,
  `spawn_failed`, `parse_failed`.

  The other backends are unchanged.

## 0.18.0

### Minor Changes

- f6f9b66: Add `vicoop-client agent` and `vicoop-client auth` command groups as the
  operator-facing primary surfaces (#218, #224, follow-up to server-side
  unification in #219).

  New commands:

  - `vicoop-client agent register --name NAME --agent-id ID [--caller PRINCIPAL ...]`
    — register an agent and persist daemon credentials. Replaces the older
    `setup --client-name N --agent-ids ID1` shape with singular agent-first
    flags. The stderr success block surfaces `agent_id`, `name`, and
    `AGENT_TOKEN` (the operator-supplied id, not the server's registration
    UUID).
  - `vicoop-client agent list [--connected]` — list agent registrations
    under this owner. Renders a whitespace-padded table with columns
    `AGENT_ID`, `NAME`, `CONNECTED`, `REVOKED`, `REGISTERED_AT`. The legacy
    `client_id` UUID is omitted from the human view (it remains in `--json`
    for backward-compat scripts). `--connected` filters to agents whose
    daemon is currently live; without it, every registration (including
    disconnected/revoked ones) is shown.
  - `vicoop-client agent revoke AGENT_ID` — revoke an agent. The argument
    resolves against the agent id, the legacy registration id, or a unique
    registration name (same server-side resolver as the previous
    `revoke-client`).
  - `vicoop-client agent callers {list,add,remove}` — manage an agent's
    allowed-callers list.
  - `vicoop-client auth login` — owner-session sign-in (Google OAuth device
    flow); identical behavior to the legacy `login`.
  - `vicoop-client auth logout` — revoke the owner-session bearer
    server-side (RFC 7009) and delete the local copy. `--local-only` and
    `--keep-local` still split the two effects.
  - `vicoop-client auth whoami` — print the agent's A2A identity (mention /
    acct / WebFinger URL); also supports `--verify`.

  The older flat aliases (`setup`, `login`, `logout`, `whoami`,
  `list-agents`, `list-clients`, `revoke-client`, `add-caller`,
  `remove-caller`, `list-callers`) keep working but now print a one-line
  deprecation warning to stderr pointing at their `agent <sub>` /
  `auth <sub>` replacement. `setup` additionally retains its client-first
  stderr vocabulary (`client_id`, `client_name`, `CLIENT_TOKEN`) so scripts
  that parse it are unaffected. All will be removed in a future release.

  The wire contracts and `--json` payload shape are unchanged: `agent
register` calls the same `registerClient` GraphQL mutation as `setup`
  and returns the same response fields (`client_id`, `client_token`,
  `client_name`, `allowed_agent_ids`); `agent list` calls the same
  `/admin-api/clients` endpoint (now backed by the unified `agents` table
  from #219, which already returns `agent_id`); `agent revoke` calls the
  same `DELETE /admin-api/clients/<target>`. No server-side changes ship
  in this changeset.

- e9ef3d8: claude backend: replace the JSON-text envelope dispatch (#208) with native
  MCP dispatch for openai-compat caller tools (#213). Claude analog of
  codex's `dynamicTools` switch (#212).

  When the openai-compat extension is active on a task AND carries `tools`,
  the backend stands up a per-task in-process MCP server (`caller-tools-mcp`)
  exposing each tool as a native MCP tool. claude discovers them via
  `tools/list` and invokes them through its normal `tool_use` surface — no
  JSON-text envelope contract, no parser. When the model invokes one, the
  bridge:

  - emits a `tool_calls` data artifact on the A2A task (byte-equivalent
    wire shape to what the legacy envelope path emitted — downstream
    gateways see no difference)
  - returns a short structured-error ack to claude (`isError: true`) so
    the model treats the call as captured and stops, matching the
    system-prompt directive `buildOpenAICompatNativeSystemPrompt` installs
  - suppresses any wrap-up text from `status.message.parts` on completion
    (same #200/#212 invariant: the `tool_calls` artifact is the complete
    output for this turn)
  - passes `--max-turns 1` to the spawned `claude` so the model emits
    exactly one round of tool calls (parallel `tool_use` blocks in a
    single assistant message are allowed) and the bridge never pays for
    sentinel-driven chains across multiple model turns. Claude's
    resulting `exit code 1` is mapped to `task.complete state=completed`
    when a tool call was actually captured (matching codex backend's
    `interrupted → completed` mapping under #212); real startup failures
    with no capture still surface as `task.fail`.

  The follow-up A2A turn carrying `tool_call_history` flows through the
  existing `formatToolCallHistory` text-prepend path. claude has no
  native equivalent of codex's `thread/inject_items`, so the history
  block remains the source of truth across resume turns.

  **No opt-in, no fallback.** The envelope-text path (#208) was the
  original target of #213 because it never actually worked reliably under
  load (#207). With native dispatch in place there is no reason to keep
  the envelope path runnable from claude — it's removed wholesale. The
  helpers `buildOpenAICompatSystemPrompt` and `tryParseToolCallsEnvelope`
  remain exported from `claude.ts` because openclaw still uses them; on
  the claude backend itself, every openai-compat caller-tools task now
  takes the native MCP path. Plain claude tasks (no openai-compat
  metadata, or metadata without `tools`) are unaffected — they keep
  their full agentic toolset and don't pay any native-dispatch overhead.

  **Stateless session model.** openai-compat is stateless by design (every
  OpenAI Chat Completions request carries its own full message history),
  so openai-compat tasks now skip the session-reuse map entirely and
  always spawn claude with a fresh `--session-id` instead of `--resume`.
  This removes the source-of-truth conflict between claude's session
  memory (containing the sentinel "captured by bridge" result from the
  MCP `onInvoke` of the prior turn) and the user message's prepended
  `tool_call_history` block, and lets the system prompt drop both the
  "stop after invoking" directive (`--max-turns 1` enforces it) and the
  verbose history-disambiguation paragraph. Plain (non-openai-compat)
  A2A tasks keep their existing contextId → session reuse behaviour.

  The two MCP servers (`vicoop-bridge` for `send_file`, `caller-tools`
  for caller-supplied tools) coexist on the same spawn under a single
  `--mcp-config` argv.

- 4fc566d: codex backend: dispatch openai-compat caller tools natively via
  `thread/start.dynamicTools` + `item/tool/call` server requests instead of the
  PR #208 JSON-text envelope (#209).

  When the openai-compat extension carries `tools`, the codex backend now
  maps each tool to a `DynamicToolSpec` and registers it natively in the
  model's tool registry. When the model invokes one, codex sends the client
  an `item/tool/call` JSON-RPC server request and the bridge:

  - emits a `tool_calls` data artifact on the A2A task (byte-equivalent wire
    shape to the legacy envelope path — callers see no difference)
  - issues `turn/interrupt` so codex unwinds the turn
  - surfaces the task as `completed` (not `canceled`), matching OpenAI Chat
    Completions' `finish_reason: "tool_calls"` semantics

  The follow-up A2A turn carrying `tool_call_history` flows through the
  existing `historyToInjectItems` path unchanged. `environments: []` and the
  `config.features.*: false` wall are kept (they prevent codex from
  satisfying the caller's request via built-in shell instead of routing
  through the caller's tools).

  Eliminates the failure modes the envelope text path exhibited under
  batched / long tool calls: prose-prefixed envelopes, malformed JSON
  across multiple calls, "step-2 narration without follow-through" where
  the model declared a write and ended the turn.

  claude / openclaw backends are unchanged — they continue to use the
  envelope path, which remains the only option for backends without a
  native function-call surface.

## 0.17.0

### Minor Changes

- f58110d: Add `vicoop-client logout`, symmetric with `vicoop-client login`. By default it
  invalidates the operator's owner-session bearer server-side via the bridge's
  new RFC 7009 `POST /oauth/revoke` endpoint and then removes
  `~/.vicoop/owner-session.json`. Two flags split the two effects:

  - `--local-only` skips the network call and just deletes the local file —
    useful when the bridge is unreachable.
  - `--keep-local` revokes server-side but leaves the file in place — useful
    for inspection / debugging.

  The server call is best-effort: a non-200 reply prints a warning but the local
  file is still deleted (the local hygiene win shouldn't depend on the bridge
  being up). A missing local session is reported, not an error.

  This closes the credential-hygiene gap where the only way to invalidate a
  leaked / shared-machine owner-session bearer was to wait out its 90-day TTL.
  The corresponding server endpoint is shipped at the same time.

### Patch Changes

- 5e00516: Fix openai-compat envelope being duplicated on `task.complete.status.message.parts`
  in addition to the `data` artifact (issue #200).

  When the `openai-compat/v1` extension is active and the model emits a
  `{"tool_calls":[…]}` envelope, the codex, claude, and openclaw backends
  correctly route it as a `data` part on a `task.artifact`. They also used to
  re-stamp the raw envelope JSON as a `text` part on the terminal
  `task.complete.status.message`. Per A2A spec §3.7 — "Messages SHOULD NOT be
  used to deliver task outputs" — that mirror is a spec violation, and the
  upstream `oai2a2a` gateway re-parsed the text part as `tool_calls` and emitted
  them a second time on the OpenAI streaming response. OpenAI clients
  concatenate `tool_calls[].function.arguments` by index, so the duplicate
  emission produced invalid JSON like `{…}{…}` and silently broke tool-calling
  clients (root cause of planetarium/oai2a2a#50, #51).

  All three backends now omit the envelope text from `status.message.parts` when
  it has already been routed via a data artifact. The `usage` metadata path on
  `status.message.metadata` is unchanged, so per-spec usage delivery still
  works.

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
