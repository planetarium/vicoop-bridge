# Install vicoop-bridge-client

Onboarding guide for connecting a local A2A backend (OpenClaw, Claude Code, or
Codex CLI; `echo` is available for testing) to a deployed vicoop-bridge server. The
first target is a verified foreground `vicoop-client` process on your host
that bridges inbound A2A traffic at `POST <bridge>/agents/<your-agent-id>` to
your local backend. Persistent service setup is optional once the foreground
run works.

Custom backends are described in `docs/design.md` §5. The released client
currently registers `echo`, `openclaw`, `claude`, and `codex`.

This doc covers the **post-release install path** (the `install.sh`
one-liner fetching a published `@vicoop-bridge/client@*` bundle). Contrast with:

- [`local-testing.md`](./local-testing.md) — running both bridge and client
  from source against a local Postgres, using `psql` for setup.
- [`remote-testing.md`](./remote-testing.md) — end-to-end verification of a
  deployed bridge using the echo backend. Covers the raw-curl SIWE path
  that the "alternative" sections here link to.

## Audience

- A human operator (or an agent acting on their behalf) standing up a
  brand-new client that will connect to a bridge they do not operate.
- The operator has a Google account; that account becomes the owner of the
  resulting client and agent policy. For wallet-based (SIWE) onboarding,
  see [`remote-testing.md`](./remote-testing.md) — out of scope here.

## Prerequisites

- Node.js 20 or newer (`node -v`).
- `curl`, `tar`, and one of `sha256sum` / `shasum`.
- A reachable bridge URL. The public deployment is
  `https://vicoop-bridge-server.fly.dev`; substitute your own below if you
  run the server yourself.
- A browser on **any** device you can open URLs in. The CLI doesn't need
  to run on the same machine as the browser — device flow is designed for
  exactly that case (e.g. headless server + laptop browser).
- A Google account. No wallet, `a2a-wallet`, or seed phrase required.
- For the OpenClaw backend specifically: an OpenClaw gateway running
  locally at `ws://127.0.0.1:18789` (override via `OPENCLAW_GATEWAY_URL`).
  Streaming (per-message A2A artifact cadence) requires OpenClaw
  **v2026.3.22 or newer** — the `sessions.messages.subscribe` RPC that
  drives it was introduced in that release. On older gateways the client
  probes at startup, logs a downgrade warning, and advertises
  `capabilities.streaming: false` on its agent card so A2A callers don't
  request `message/stream` against a backend that can't deliver it;
  task execution still works via the terminal-artifact fallback.
- For the Claude backend specifically: the local `claude` CLI installed and
  authenticated (`claude --version` should succeed).
- For the Codex backend specifically: the local `codex` CLI installed and
  authenticated (`codex --version` should succeed).

## Step 1 — Install the client bundle

The one-liner downloads the latest `@vicoop-bridge/client@*` release, verifies
its `.sha256`, and extracts into `$INSTALL_DIR`:

```sh
curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh \
  | INSTALL_DIR="$HOME/vicoop-bridge-client" sh
```

The env assignment has to sit on the `sh` side of the pipe — prefixing the
`curl` call would scope `INSTALL_DIR` to curl's process only, and `install.sh`
would still default to `/data/vicoop-bridge-client`.

| Env | Default | Purpose |
|---|---|---|
| `INSTALL_DIR` | `/data/vicoop-bridge-client` | Target directory. Pick a writable path on a volume that survives restarts. |
| `VERSION` | latest `@vicoop-bridge/client@*` | Pin a specific tag, e.g. `@vicoop-bridge/client@0.1.1`. |
| `FORCE` | `0` | If `1`, overwrite a non-empty `INSTALL_DIR`. |
| `INSTALL_SKIP_SERVICE` | `0` | If `1`, skip the optional systemd unit + env template even on systemd hosts. |
| `INSTALL_SERVICE_SCOPE` | `auto` | Force `user`, `system`, or `none` instead of auto-detecting by `id -u`. `system` requires root; an explicit `system` without root is refused with a warning. |

What you get after extraction:

```
$INSTALL_DIR/
├── bin/vicoop-client        # bash wrapper that execs node dist/cli.js
├── dist/                    # compiled JS
├── cards/openclaw.json      # OpenClaw example card
├── cards/claude.json        # Claude Code example card
├── cards/codex.json         # Codex CLI example card
├── cards/echo.json          # Echo test card
├── node_modules/            # pruned prod deps
└── package.json
```

The script targets Linux (Fly.io persistent volumes are the original target
deployment); on macOS it prints a warning and proceeds. See #17 / #21 for
background.

When systemd is the host init, `install.sh` may also write an optional
`vicoop-client.service` unit plus a `vicoop-client.env` template (scope
auto-detected: `system` as root, `user` otherwise). It does not enable or
start the service. Use the foreground run in Step 6 first; enable the service
later only if this host should keep the client online unattended. Opt out with
`INSTALL_SKIP_SERVICE=1`, or force a scope with
`INSTALL_SERVICE_SCOPE=user|system|none`.

## Step 2 — Verify the installed bundle

If `$INSTALL_DIR` already existed before Step 1, `install.sh` refuses to
overwrite it unless you pass `FORCE=1`. That's intentional: an existing
directory may contain a working client, saved env file, or an older bundle
you don't want clobbered by accident.

If you do want to replace a non-empty install directory, rerun Step 1 with
`FORCE=1`:

```sh
curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh \
  | INSTALL_DIR="$HOME/vicoop-bridge-client" FORCE=1 sh
```

If you'd rather keep the old install around, pick a different
`INSTALL_DIR` (for example `~/vicoop-bridge-client-0.5.0`) and install the
new bundle there instead.

Before continuing, verify that the installed bundle is recent enough to
include the `login` command used in Step 4:

```sh
"$INSTALL_DIR/bin/vicoop-client" -v
"$INSTALL_DIR/bin/vicoop-client" login --help
```

If `login --help` prints usage, you're on a current bundle. If it instead
fails with the daemon usage (`--server`, `--token`, `--agentId`, `--backend`)
or doesn't recognize `login`, you're still on an older pre-device-flow
release and should reinstall into a fresh directory or rerun Step 1 with
`FORCE=1`.

## Step 3 — Pick an agent id

The agent id is the routing key external A2A callers use to reach your
client. Pick something unlikely to collide across operators:

```sh
export BRIDGE_URL=https://vicoop-bridge-server.fly.dev

# By hostname
AGENT_ID="openclaw-$(hostname | cut -d. -f1)"

# Or random
AGENT_ID="$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-8)-openclaw"

echo "$AGENT_ID"
```

`registerClient` (called for you by `vicoop-client setup` in Step 4) does
not pre-validate availability; collisions surface only at WS connect time.
If you want to probe ahead, hit `agentIdAvailable(agentId)` GraphQL after
login — it's a SECURITY DEFINER probe that returns boolean availability
across every owner without leaking `owner_principal`. Most operators just
pick a hostname/uuid prefix and skip the probe.

## Step 4 — Login and set up your client

`vicoop-client login` only signs you in as the client owner and saves an
owner-session bearer to `~/.vicoop/owner-session.json`. It does **not** create
a bridge client. `vicoop-client setup` then uses that saved owner-session to
call `registerClient` and mint a one-time `CLIENT_TOKEN`. No wallet or SIWE
required.

```sh
HOSTNAME=$(hostname)
CLIENT_NAME="openclaw on ${HOSTNAME%%.*}"

"$INSTALL_DIR/bin/vicoop-client" login --bridge "$BRIDGE_URL"

"$INSTALL_DIR/bin/vicoop-client" setup \
  --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" \
  --caller "eth:0x<40-hex>"
```

`login` prints a verification URL to stderr — open it in **any** browser
(the same machine, or your laptop while running the CLI on a headless host)
and authorize with your Google account. `setup` registers the client, configures
any `--caller` allowlist entries, and persists the daemon credentials to
the resolved vicoop config dir (`~/.vicoop/config.json` by default; see the
resolution order below for `$VICOOP_HOME` / `$XDG_CONFIG_HOME` cases), mode
600 — see #137 for the consolidated config layout. The success output looks
like:

```text
  client_id        <uuid>
  owner_principal  google:sub:<sub>
  client_name      openclaw on my-host
  allowed_agents   openclaw-my-host

The CLIENT_TOKEN is one-time — the bridge cannot reissue it.
  setup persists it to the canonical config below; --json prints it to
  stdout instead. Back up that file before rotating hosts.
  To also stash it in a systemd EnvironmentFile, pass --write-env-file
  on this same setup invocation — rerunning setup later would call
  registerClient again and mint a NEW CLIENT_TOKEN, invalidating this
  one. To populate an env file from an already-issued token, copy
  SERVER_URL / SERVER_TOKEN / AGENT_ID out of config.json by hand.

Wrote /home/you/.vicoop/config.json (mode 600).
```

Verify it landed where you expect (matters when `$VICOOP_HOME` or
`$XDG_CONFIG_HOME` is set):

```sh
ls -l ~/.vicoop/config.json   # or "$VICOOP_HOME/config.json" / "$XDG_CONFIG_HOME/vicoop/config.json"
```

`config.json` is the canonical place the daemon looks for `server_url`,
`server_token`, `agent_id`, and any backend defaults. The directory is
resolved as `$VICOOP_HOME > (existing) ~/.vicoop > $XDG_CONFIG_HOME/vicoop
> ~/.vicoop`. The "(existing) `~/.vicoop`" branch wins over XDG so prior
installs that already store `owner-session.json` there aren't orphaned
when `$XDG_CONFIG_HOME` gets set later; fresh installs with `$XDG_CONFIG_HOME`
set land under `$XDG_CONFIG_HOME/vicoop`.

`setup` only writes the three credentials above; backend defaults are
hand-edited into the same file. The common shape (every field optional —
omit what you don't need) is:

```json
{
  "server_url": "wss://vicoop-bridge-server.fly.dev",
  "server_token": "<written by setup>",
  "agent_id": "<written by setup>",
  "backend": "claude",
  "backends": {
    "claude": {
      "cwd": "/srv/agent-work",
      "settings": {
        "sandbox": { "enabled": true, "failIfUnavailable": true }
      }
    },
    "codex": {
      "cwd": "/srv/agent-work",
      "sandbox_mode": "workspace-write"
    },
    "openclaw": {
      "gateway_url": "ws://127.0.0.1:18789",
      "gateway_token": "<gateway-token-if-required>",
      "agent": "main",
      "openai_compat_agent": "oai",
      "task_timeout_ms": 600000
    }
  }
}
```

The schema also accepts a top-level `card` mirroring the `--card` flag /
`AGENT_CARD` env var (rarely needed: the bridge already publishes a
canonical card per backend — see Step 5).

Daemon precedence is **CLI flag > env var > `--config <path>` > canonical
`config.json`**, so env values still win (handy for systemd `EnvironmentFile=`
or CI overrides). `setup` only ever touches `server_url`, `server_token`, and
`agent_id` — hand-edits to the other fields survive `setup` re-runs.

> **Top-level vs `backends.*` parity.** The five top-level fields above
> (`server_url`, `server_token`, `agent_id`, `backend`, `card`) all have
> matching CLI flags (`--server`, `--token`, `--agentId`, `--backend`,
> `--card`) and env vars. The `backends.*` map is config + env only —
> there's no per-backend CLI flag. The backend-specific env vars
> (`CLAUDE_CWD`, `CLAUDE_SETTINGS_JSON`, `CODEX_CWD`,
> `CODEX_SANDBOX_MODE`, `OPENCLAW_GATEWAY_URL` /
> `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_AGENT` /
> `OPENCLAW_OAI_COMPAT_AGENT` / `OPENCLAW_TASK_TIMEOUT_MS`) still
> override the corresponding config values.

If you omit `--caller`, `setup` succeeds but prints a warning that the
agent will be public until you restrict callers:

> `setup --caller` requires a bridge server version that can pre-create
> `agent_policies` for registered client agent ids. If you are testing against
> your own deployment, deploy the matching server/schema before this step.

> ⚠ The `CLIENT_TOKEN` is unrecoverable after this single output.
> `config.json` is the only place it persists; back it up if you need to
> rotate hosts. To rotate the token later, use the `rotateClientToken`
> GraphQL mutation (requires a `vbc_owner_*` session token; the default
> login flow saves one locally for you). Rotation surfaces a new
> CLIENT_TOKEN, also one-time.

For setup scripting, pass `--json` instead of writing `config.json` if you
want to compose with shell tooling (no disk side effects, raw response on
stdout):

```sh
"$INSTALL_DIR/bin/vicoop-client" setup \
  --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" \
  --caller "eth:0x<40-hex>" --json \
  | tee /tmp/vicoop-setup.json
CLIENT_TOKEN=$(jq -r .client_token /tmp/vicoop-setup.json)
```

`--agent-ids` is a comma-separated allowlist. Include every id you plan to
run under this single token if you know them up front; amend later via
the `updateClientAllowedAgents` GraphQL mutation (backed by
`update_client_allowed_agents()` in `schema.sql`) without issuing a new
token.

### What login and setup do

1. `login` calls `POST /oauth/device/code` with `intent=owner_session`; the bridge stores
   a `device_sessions` row and returns a one-time `device_code` + 8-char user
   code.
2. Operator opens the verification URL, signs in with Google, and the
   approval page authorizes an owner-session login for bridge management.
3. CLI polls `POST /oauth/token`. Once status flips to `approved`, the
   bridge returns a `vbc_owner_*` bearer, and `login` saves it to
   `~/.vicoop/owner-session.json` (mode 600).
4. `setup` calls the authenticated GraphQL `registerClient` mutation with
   that bearer, receives `{client_id, client_token, owner_principal,
   allowed_agent_ids}`, and writes the daemon credentials into
   `~/.vicoop/config.json` (mode 600). With `--write-env-file <path>` it
   additionally emits a systemd-shaped env file at that path. It never
   sees a `vbc_caller_*` token.

This means a Google-only operator can stand up a bridge client without
ever holding a wallet or seed phrase. Owner is recorded as
`google:sub:<sub>` (stable id, not the email).

## Step 5 — Choose a backend and optional agent card

Pick the local backend this client should drive:

- `openclaw` — OpenClaw gateway at `OPENCLAW_GATEWAY_URL`
- `claude` — local Claude Code CLI
- `codex` — local Codex CLI
- `echo` — smoke-test backend

For these built-in backends, you normally do **not** pass an agent card file.
The client sends `BACKEND` as `backendKind`, and the bridge server publishes
the canonical card for that backend at
`GET <bridge>/agents/<agent_id>/.well-known/agent-card.json`. That keeps
metadata/capability fixes on the faster server deploy path instead of
requiring every operator to upgrade their client bundle.

The bundle still ships backend-specific starter cards under
`$INSTALL_DIR/cards/` (`openclaw.json`, `claude.json`, `codex.json`, `echo.json`) for
operator overrides and compatibility with older bridge servers. Set
`AGENT_CARD` only when you intentionally want to override the server card,
for example to:

- Rename `name` to something meaningful (it defaults to `openclaw`).
- Tighten `description` to what this specific instance actually does.
- Adjust `skills[]` if you've customized the backend.

To see what the bridge currently advertises for this agent (before deciding
whether to override), connect the client once and `curl` the `a2a card` URL
that `vicoop-client whoami` prints — see ["Check your agent's mention /
acct"](#check-your-agents-mention--acct-any-backend) in Step 6.

Schema reference: `packages/protocol/src/index.ts` (`AgentCard` Zod schema,
validated by the client at startup when `AGENT_CARD` is set — invalid cards
exit with a Zod error).

For custom backends, write a fresh card:

```sh
cat > "$INSTALL_DIR/cards/my-agent.json" <<'JSON'
{
  "name": "my-agent",
  "description": "...",
  "version": "0.0.1",
  "protocolVersion": "0.3.0",
  "capabilities": { "streaming": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    { "id": "chat", "name": "chat", "description": "...", "tags": ["chat"] }
  ]
}
JSON
```

## Step 6 — Run the client

Run the client in the foreground first. With `config.json` written by Step 4,
the daemon picks up `server_url`, `server_token`, and `agent_id` on its own:

```sh
BACKEND=openclaw \
  "$INSTALL_DIR/bin/vicoop-client"
```

Precedence at startup is **CLI flag > env var > `--config <path>` > canonical
`config.json`**, so the layers compose freely — env values still override
`config.json` when both set the same key.

On success you'll see a `[client] connected, sending hello` log followed
by an identity block — same data `vicoop-client whoami` would print, so
you can copy the mention / acct / agent-card URL from here directly:

```text
[client] connected, sending hello
[client] agentId:    openclaw-mac
[client] mention:    @openclaw-mac@vicoop-bridge-server.fly.dev
[client] acct:       acct:openclaw-mac@vicoop-bridge-server.fly.dev
[client] a2a:        https://vicoop-bridge-server.fly.dev/agents/openclaw-mac
[client] a2a card:   https://vicoop-bridge-server.fly.dev/agents/openclaw-mac/.well-known/agent-card.json
[client] webfinger:  https://vicoop-bridge-server.fly.dev/.well-known/webfinger?resource=acct%3A...
```

After that:

- The bridge loads the `agent_policies` row for your agent. If Step 4 setup
  included `--caller`, that allowlist is already in place; otherwise
  `allowed_callers` is empty, meaning **publicly callable** until you restrict it.
- `POST $BRIDGE_URL/agents/$AGENT_ID` with a JSON-RPC `message/send` payload
  reaches your backend and the reply is returned inline.

### OpenClaw-specific env

The OpenClaw backend connects outbound to a local OpenClaw gateway over a
second WS. Override if yours isn't on the default:

| Env | Default | |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Local gateway endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | *(none)* | If your gateway requires auth |
| `OPENCLAW_AGENT` | `main` | Agent name inside OpenClaw |
| `OPENCLAW_OAI_COMPAT_AGENT` | *(unset, single-agent mode)* | Optional secondary OpenClaw agent name dedicated to tasks carrying the A2A openai-compat extension metadata. When set, the bridge routes those tasks via `agent:<this>:<contextId>` sessionKeys; non-extension tasks keep using `OPENCLAW_AGENT`. Pairs with a `tools.deny=["*"]` `agents.list` entry on the OpenClaw side — see the box below. |
| `OPENCLAW_TASK_TIMEOUT_MS` | backend default | Per-task timeout |

> **Recommended dual-agent setup for the openai-compat extension.**
> If you advertise the `…/openai-compat/v1` extension on the OpenClaw
> card (it ships advertised by default) and expect OpenAI-shaped
> callers to actually hit it, configure two OpenClaw agents instead
> of one. The default `main` agent keeps its full toolset for normal
> natural-language traffic; a secondary `oai` agent runs with native
> tools disabled so the host model can't satisfy a tool-call prompt
> with its own Bash / browser / weather skill and ignore the
> envelope contract the bridge text-injects into the user message.
>
> Add this to the OpenClaw gateway config (`~/.openclaw/openclaw.json`
> on the host running OpenClaw):
> ```json
> {
>   "agents": {
>     "list": [
>       { "id": "main" },
>       { "id": "oai", "tools": { "profile": "minimal", "deny": ["*"] } }
>     ]
>   }
> }
> ```
> Then set `OPENCLAW_OAI_COMPAT_AGENT=oai` (or
> `backends.openclaw.openai_compat_agent: "oai"` in `config.json`)
> on the vicoop-client side. Pilot measurement on
> `anthropic/claude-sonnet-4-6` saw envelope-contract compliance
> rise from 5/10 (single-agent baseline, full tools) to 10/10 with
> this split. Leave `OPENCLAW_OAI_COMPAT_AGENT` unset and you get
> today's single-agent behavior on every task.

### Claude-specific env

If you're running the Claude backend, set `BACKEND=claude` and optionally set
`CLAUDE_CWD` so Claude works against a different repository than the directory
where `vicoop-client` itself was started. With Step 4's `config.json` already
holding the daemon credentials, the foreground command is just:

```sh
BACKEND=claude \
CLAUDE_CWD="$HOME/vicoop-bridge" \
  "$INSTALL_DIR/bin/vicoop-client"
```

Both knobs can also live in the canonical `config.json` (resolved per Step
4 — `~/.vicoop/config.json` by default) under `backends.claude`
(`cwd`, `settings`) so the foreground command shrinks to just
`"$INSTALL_DIR/bin/vicoop-client"`; the env vars still win when set, mirroring
the daemon-level precedence (Step 6 intro).

> **Sandbox-on by default.** When neither `CLAUDE_SETTINGS_JSON` nor
> `backends.claude.settings` is set, the backend forwards
> `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}'` to every
> spawned `claude`. The OS-level sandbox (Seatbelt on macOS, bubblewrap on
> Linux) is on; `failIfUnavailable: true` means a host that can't enable it
> exits at startup instead of silently running with full host access. To
> widen the policy (extra `allowedDomains`, `allowWrite`, etc.) supply a
> complete `settings` object — it replaces the default entirely. To run
> without a sandbox, pass `{ "sandbox": { "enabled": false } }`.

`CLAUDE_CWD` defaults to the current working directory of the client
process. Set it when the released bundle lives outside the repository you
want Claude to edit.

The Claude backend also injects a small `--append-system-prompt` on every
spawned `claude` telling it its own A2A mention (`@<agentId>@<host>`) so
the model recognises self-references in user messages and doesn't try to
a2a-call its own address (see #128). No configuration required — it's
derived from `AGENT_ID` and the host part of `SERVER_URL`.

> **Note on host derivation.** The injected mention uses `SERVER_URL`'s
> host (e.g. `wss://bridge.example.com/ws` → `bridge.example.com`). The
> bridge's canonical Mentionable/WebFinger domain comes from `PUBLIC_URL`
> on the server side. If the two differ (e.g. a custom domain in front of
> a Fly hostname), the model is taught a mention that doesn't match what
> users see via WebFinger and self-reference detection won't fire. Run
> `vicoop-client whoami --verify` to confirm the WebFinger lookup actually
> resolves the agent under the derived host; align `SERVER_URL` with
> `PUBLIC_URL`'s host if it doesn't.

### Check your agent's mention / acct (any backend)

After the first `connected` log, run `vicoop-client whoami` to surface every
identifier external callers will see for this agent — the WebFinger acct, the
`@<agentId>@<host>` mention, the JSON-RPC endpoint, and the agent-card URL.

```sh
"$INSTALL_DIR/bin/vicoop-client" whoami
# agentId:    my-agent
# host:       bridge.example.com
# mention:    @my-agent@bridge.example.com
# acct:       acct:my-agent@bridge.example.com
# a2a:        https://bridge.example.com/agents/my-agent
# a2a card:   https://bridge.example.com/agents/my-agent/.well-known/agent-card.json
# webfinger:  https://bridge.example.com/.well-known/webfinger?resource=acct%3A...
```

Typical follow-ups from this output:

1. **Hand the mention to another agent.** Copy the `mention:` line and paste
   it into the other agent's `allowed_callers` (via `add-caller` or the admin
   agent) so it can call you. Same value goes into the **OpenClaw gateway
   persona** if you want self-reference recognition on the OpenClaw backend
   (configured via `openclaw config set ...` since `chat.send` has no
   per-message system field). `a2a` is the JSON-RPC endpoint another caller
   would POST to (e.g. `a2a-wallet a2a stream <a2a> "..."`).
2. **Confirm which card the bridge advertises.** `curl` the `a2a card` URL —
   that's the canonical card external callers receive, which is the
   server-published default for `BACKEND` unless you set `AGENT_CARD` to
   override it (see Step 5). If the response doesn't match what you expect,
   that's the cue to override.

   ```sh
   CARD_URL=$("$INSTALL_DIR/bin/vicoop-client" whoami --json | jq -r .a2aCardUrl)
   curl -sf "$CARD_URL" | jq .
   ```
3. **Verify WebFinger actually resolves the acct.** `whoami --verify`
   additionally fetches the WebFinger URL and reports whether the bridge
   resolves this agent's acct under the derived host. This catches the
   `SERVER_URL` host vs bridge `PUBLIC_URL` mismatch flagged in the
   Claude-specific note above; if `--verify` fails, align the two before
   trusting self-reference detection or external mentions.

`--json` emits a machine-readable record of all the same fields for scripts.

### Codex-specific env

If you're running the Codex backend, set `BACKEND=codex` and optionally set
`CODEX_CWD` so Codex works against a different repository than the directory
where `vicoop-client` itself was started. With Step 4's `config.json` in place
the foreground command is just:

```sh
BACKEND=codex \
CODEX_CWD="$HOME/vicoop-bridge" \
CODEX_SANDBOX_MODE=workspace-write \
  "$INSTALL_DIR/bin/vicoop-client"
```

Both `cwd` and `sandbox_mode` can also live in the canonical `config.json`
(resolved per Step 4 — `~/.vicoop/config.json` by default) under
`backends.codex` so the foreground command can shrink to just
`"$INSTALL_DIR/bin/vicoop-client"`. Env vars still win when set.

`CODEX_CWD` defaults to the current working directory of the client process.
The v1 backend accepts text plus inline image `file.bytes` inputs and returns
text output. `CODEX_SANDBOX_MODE` is optional and accepts `read-only`,
`workspace-write`, or `danger-full-access`; the client passes it to Codex as
`-c sandbox_mode="<mode>"` so the same setting applies to fresh and resumed
Codex sessions.

> **Sandbox-on by default.** With neither `CODEX_SANDBOX_MODE` nor
> `backends.codex.sandbox_mode` set, the backend passes
> `-c sandbox_mode="read-only"` explicitly — the same default Codex CLI
> applies, but stamped into argv so the posture is visible in `ps` / audit
> logs and survives any future change to Codex's own default.

> **`cwd` need not be a git repository.** `codex exec` refuses by default
> to run outside a trusted directory, exiting non-zero in ~200 ms (#147).
> The Codex backend always passes `--skip-git-repo-check` to keep the
> CLI usable from an operator-chosen `cwd` (an agent's working tree is
> often not a git repo). Sandboxing is unchanged — the cwd-trust check
> is a CLI ergonomics gate, not part of `sandbox_mode`. The flag is
> deduplicated when also listed in `backends.codex.extra_args`.

## Manage caller allowlists

If Step 4 setup did not include `--caller`, the policy has empty
`allowed_callers`, which the dispatcher treats as "public". For normal use,
pass `--caller` during initial setup, or add an allowlist entry afterward
with the `vicoop-client` subcommands (deterministic, scriptable) or a
natural-language request to the admin agent. These paths require an
**owner-session token** (`vbc_owner_*`). Step 4 login saves one locally;
you only need to rerun `login` if that file is missing or expired. Admin
scope (`is_admin()`) is wallet-only and gates only the cross-owner tools.

### Option A: `vicoop-client` subcommands (recommended for scripts)

These subcommands require **bundle version 0.8.0 or newer**. Older
installs only know the daemon flags; check before using and upgrade if
needed:

```sh
"$INSTALL_DIR/bin/vicoop-client" -v
"$INSTALL_DIR/bin/vicoop-client" upgrade --check   # report latest vs current
"$INSTALL_DIR/bin/vicoop-client" upgrade           # upgrade in place if behind
```

```sh
# Step 4 login saves the owner-session bearer, so these work without re-authenticating:
"$INSTALL_DIR/bin/vicoop-client" setup \
  --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" \
  --caller "eth:0x<40-hex>"
"$INSTALL_DIR/bin/vicoop-client" list-agents
"$INSTALL_DIR/bin/vicoop-client" list-callers "$AGENT_ID" --json
"$INSTALL_DIR/bin/vicoop-client" add-caller "$AGENT_ID" "eth:0x<40-hex>"
"$INSTALL_DIR/bin/vicoop-client" remove-caller "$AGENT_ID" "google:email:caller@example.com"

# Pass --json for machine-readable output, or --bridge / --token to override
# the saved session for one call. VICOOP_BRIDGE / VICOOP_OWNER_TOKEN env vars
# work too (handy for CI).
```

The `server_token` Step 4 setup writes into the canonical `config.json`
is a **client** credential and is **not** accepted by these admin commands —
they only accept an owner-session bearer (the separate `owner-session.json`
that `login` writes alongside it). If the saved bearer is missing or expired,
refresh it without registering a new client:

```sh
"$INSTALL_DIR/bin/vicoop-client" login --bridge "$BRIDGE_URL"
```

These talk to the bridge's `/admin-api/*` routes — same logic the admin
agent's tools run, but without an LLM round-trip per call.

### Option B: natural-language admin agent

```sh
# $OWNER_TOKEN: vbc_owner_* token from /oauth/device/code with
# intent=owner_session (the bearer Step 4 login saved into
# ~/.vicoop/owner-session.json works directly).
WALLET_PRINCIPAL="eth:$(a2a-wallet status | awk '/Address/{print tolower($2)}')"

curl -sX POST "$BRIDGE_URL/" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"messageId\":\"ac\",\"role\":\"user\",\"kind\":\"message\",\"parts\":[{\"kind\":\"text\",\"text\":\"Use add_caller to add '${WALLET_PRINCIPAL}' to agent '${AGENT_ID}'.\"}]}}}" \
  | jq -r '.result.status.message.parts[0].text'
```

Either path hot-reloads via `registry.updateAllowedCallers` — no client
restart needed.

## Updating the client

Once installed, the client updates itself — do not re-run `install.sh`. The
installer's `FORCE=1` path is destructive (it `rm -rf`s `$INSTALL_DIR` and
wipes any operator-added cards / files), so it's reserved for bootstrapping.

```sh
"$INSTALL_DIR/bin/vicoop-client" upgrade --check      # report latest vs current
"$INSTALL_DIR/bin/vicoop-client" upgrade              # upgrade to latest @vicoop-bridge/client@*
"$INSTALL_DIR/bin/vicoop-client" upgrade --version 0.2.0   # pin / downgrade (bare version, v0.2.0, or @vicoop-bridge/client@0.2.0 all accepted)
"$INSTALL_DIR/bin/vicoop-client" upgrade --force      # reinstall the resolved target even if already on it
```

The upgrade command:

1. Queries GitHub releases for the latest `@vicoop-bridge/client@*` tag (or
   the `--version` you pin).
2. Downloads `.tgz` + `.sha256` to a temp directory and verifies the checksum.
3. Extracts into `$INSTALL_DIR.new/` (sibling of the current install).
4. Copies operator files that don't ship with the bundle — notably any
   `cards/*.json` you added or files placed directly under `$INSTALL_DIR`.
   Shipped cards (`openclaw.json`, `echo.json`, `claude.json`, `codex.json`) are kept for
   optional overrides and older server compatibility; they are always
   replaced with the new release's versions.
5. Runs `node $INSTALL_DIR.new/dist/cli.js --version` as a healthcheck. If it
   exits non-zero or reports the wrong version, `$INSTALL_DIR.new` is deleted
   and the upgrade aborts with no change to the live install.
6. Atomically swaps: `$INSTALL_DIR` → `$INSTALL_DIR.prev`,
   `$INSTALL_DIR.new` → `$INSTALL_DIR`. A failure mid-swap restores the
   original.
7. Detects a matching `vicoop-client.service` unit (system or user scope) and
   runs `systemctl [--user] try-restart vicoop-client.service`. If no unit
   exists, prints a reminder to restart the client yourself.
8. Keeps `$INSTALL_DIR.prev` around for manual rollback (`mv` it back into
   place if needed). Delete it once you've confirmed the new version works.

**Permissions**: for a system-scope install (root-owned `$INSTALL_DIR`),
run the upgrade via `sudo`. The command checks write access up front and
fails fast with a clear error otherwise.

**Operator-owned state is not touched by `upgrade`.** That covers
`~/.vicoop/config.json` (the canonical daemon config — Step 4),
`~/.vicoop/owner-session.json` (the owner bearer — `login`), and
`/etc/vicoop-client.env` plus the systemd unit file (written by
`install.sh` only). If a release ever changes the unit layout, re-run
`install.sh` once to refresh the scaffolding. Note that `FORCE=1` deletes
everything under `$INSTALL_DIR` first — back up any operator-added cards or
files before running it.

**Manual restart on non-systemd hosts.** The atomic swap leaves your running
client process attached to the previous bundle. Stop it and start it again
with your usual command (foreground / screen / tmux / launchd) so the new
version takes effect — `upgrade` cannot signal a process it didn't start.
To check for stragglers, run `pgrep -fl 'vicoop-client|dist/cli\.js'` and kill
any old process before starting the new one. Multiple client processes
connecting with the **same `SERVER_TOKEN`** for one `AGENT_ID` collide and
the older WS is closed with code 4009 (harmless but noisy); see the Gotchas
section of `docs/local-testing.md` for the same note.

## Troubleshooting

- **`agent id owned by a different principal`** (WS register) — your
  principal is not the `owner_principal` on the existing `agent_policies`
  row. Pick a different `agent_id`, amend the existing client's allowlist
  via `updateClientAllowedAgents` (no token rotation), and restart
  `vicoop-client` with the new `AGENT_ID`. Re-run Step 4 only if you
  intentionally want a new client/token; otherwise sign in from the
  original owner.

- **`permission denied for function register_client`** (or similar) on
  GraphQL — the caller token was missing, malformed, or expired, so the
  request fell back to the `app_anonymous` Postgres role (see
  `packages/server/src/postgraphile.ts`) which has no EXECUTE on
  authenticated functions. Re-run `vicoop-client login` to refresh.

- **Device flow timed out** — the `vicoop-client login` deadline matches
  the bridge's `device_sessions.expires_at` (10 min by default). If the
  browser approval is delayed past that, re-run `login`; the previous
  device code is invalidated automatically.

- **Client reconnects but `/agents/:id` returns 404** — the
  `agent_policies` row exists but no WS session is live. Check the client
  log; the row is re-used on reconnect but dispatch requires an active
  session.

- **Lost the `CLIENT_TOKEN`** — the raw value is unrecoverable, but you
  don't need to create a new client identity. Rotate the token in place
  via the `rotateClientToken` GraphQL mutation (backed by
  `rotate_client_token()` in `schema.sql`): it mints a fresh raw token for
  the existing `clients` row and invalidates the old hash, so your
  `allowedAgentIds` and `agent_policies` carry over. Re-run Step 4 only if
  you intentionally want a new client identity; in that case the old
  `clients` row can be revoked from the CLI — see
  [Inspecting and revoking your clients](#inspecting-and-revoking-your-clients).

## Inspecting and revoking your clients

`vicoop-client list-agents` only shows *currently connected* agents. To see
every `clients` row registered under your owner principal — including
orphans left behind by an aborted `setup`, an exited daemon, or a leaked
`CLIENT_TOKEN` — use:

```bash
vicoop-client list-clients
```

Columns are `client_id`, `client_name`, `allowed_agent_ids`, `revoked`,
`connected`, `created_at`. The `connected` flag reflects in-memory
registry state, so a row with `connected: false` is exactly the kind of
orphan you want to clean up.

To revoke a client — and disconnect its live WebSocket if one is bound —
use either the UUID `client_id` or a unique `client_name`:

```bash
vicoop-client revoke-client <client-id-or-name>
```

- A revoked client's row is kept (`revoked = true`) so audit history
  survives; existing `agent_policies` cascade-deleted only when the
  underlying row is later hard-deleted.
- A unique name resolves automatically; an ambiguous name exits non-zero
  with a list of matching `client_id`s so you can retry with the id.
- If the daemon is alive at the moment of revocation, its WebSocket is
  closed with code **4014 "client revoked"** and the daemon exits
  non-zero without reconnecting. The bridge's WS auth path also rejects
  the token on the next register attempt, so a daemon launched again with
  the same token will fail with **close code 4005 "bad token"** rather
  than reconnect-loop indefinitely.
- Propagation is **synchronous from the next auth attempt**: client-token
  verification queries `clients` directly on every WS register with no
  cache, so there is no equivalent of the 60s `callers` LRU window.

Both subcommands use the same owner-session bearer as `add-caller` /
`remove-caller`; no SIWE re-sign required.

## What's next

- **Bind more agents to the same token**: amend the existing client's
  allowlist via the `updateClientAllowedAgents` GraphQL mutation (e.g. to
  `["openclaw-a", "openclaw-b", ...]`) and run one `vicoop-client` per id.
  No token rotation needed.
- **Different backends**: in the published bundle today, pass
  `--backend openclaw`, `--backend claude`, `--backend codex`, or `--backend echo`. Set
  `--card`/`AGENT_CARD` only when you need to override the server's
  canonical card. Custom/future backends are still described in
  `docs/design.md` §5 but are not shipped yet.
- **Audit/revoke access**: the admin agent exposes `list_caller_tokens`,
  `list_callers`, and `revoke_caller_token` tools; see the tool list in
  `packages/server/src/admin.ts`.
