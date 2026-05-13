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
- The operator has either a Google account (used throughout) or an Ethereum
  EOA they control. Either becomes the owner of the resulting client and
  agent policy.

## Prerequisites

- Node.js 20 or newer (`node -v`).
- `curl`, `tar`, and one of `sha256sum` / `shasum`. `jq` is recommended for
  the optional SIWE alternative path; the default Google flow doesn't need
  it.
- A reachable bridge URL. The public deployment is
  `https://vicoop-bridge-server.fly.dev`; substitute your own below if you
  run the server yourself.
- A browser on **any** device you can open URLs in. The CLI doesn't need
  to run on the same machine as the browser — device flow is designed for
  exactly that case (e.g. headless server + laptop browser).
- A Google account. No wallet, `a2a-wallet`, or seed phrase required.
- (Optional, alternative path) For wallet-based onboarding instead of
  Google, [`a2a-wallet`](https://github.com/planetarium/a2a-x402-wallet)
  CLI with an imported wallet — see "Alternative: SIWE onboarding" near
  the end of this doc.
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
`~/.vicoop/config.json` (mode 600 — see #137 for the consolidated config
layout). On success it prints something like:

```text
Wrote /home/you/.vicoop/config.json (mode 600).
```

`config.json` is the canonical place the daemon looks for `server_url`,
`server_token`, `agent_id`, and any backend defaults. The location is
resolved as `$VICOOP_HOME > $XDG_CONFIG_HOME/vicoop > ~/.vicoop` (existing
`~/.vicoop` installs are honored even when `$XDG_CONFIG_HOME` is set).

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

### Optional: also write a systemd `EnvironmentFile=`

If you plan to launch the daemon under a systemd unit that uses
`EnvironmentFile=` (the layout `install.sh` generates), pass
`--write-env-file <path>` to also drop an `export KEY='value'` file
alongside `config.json`. The two are kept in sync by `setup`; either one
on its own is enough to run the daemon. The env file's `export` prefix
plus single-quoted values mean `. "$INSTALL_DIR/vicoop-client.env"`
propagates safely even when an agent id contains shell metacharacters.

```sh
"$INSTALL_DIR/bin/vicoop-client" setup \
  --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" \
  --caller "eth:0x<40-hex>" \
  --write-env-file "$INSTALL_DIR/vicoop-client.env"
```

For setup scripting, drop `--write-env-file` and pass `--json` instead if you want to compose
with shell tooling:

```sh
"$INSTALL_DIR/bin/vicoop-client" setup \
  --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" \
  --caller "eth:0x<40-hex>" --json \
  | tee /tmp/vicoop-setup.json
CLIENT_TOKEN=$(jq -r .client_token /tmp/vicoop-setup.json)
```

`--write-env-file` replaces the older `--env-file` spelling. The old alias is
still accepted by current bundles, but avoid it on Node 24 or newer unless the
bundle wrapper has been updated to invoke `node -- dist/cli.js`; otherwise
Node may consume `--env-file` before the CLI sees it.

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
   allowed_agent_ids}`, and writes the client env file. It never sees a
   `vbc_caller_*` token.

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

If you also wrote a systemd `EnvironmentFile=` via `--write-env-file` in
Step 4, source it instead of relying on `config.json`:

```sh
. "$INSTALL_DIR/vicoop-client.env"

BACKEND=openclaw \
  "$INSTALL_DIR/bin/vicoop-client"
```

Precedence at startup is CLI flag > env var > `--config <path>` > canonical
`config.json`, so the two layers compose freely — e.g. a systemd unit can
keep `SERVER_TOKEN` in `EnvironmentFile=` while letting backend defaults
(`CLAUDE_SETTINGS_JSON`, openclaw gateway URL, etc.) live in `config.json`.

On success you'll see a `[client] connected, sending hello` log. After that:

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
| `OPENCLAW_TASK_TIMEOUT_MS` | backend default | Per-task timeout |

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

Both knobs can also live in `~/.vicoop/config.json` under `backends.claude`
(`cwd`, `settings`) so the foreground command shrinks to just
`"$INSTALL_DIR/bin/vicoop-client"`; the env vars still win when set, mirroring
the daemon-level precedence (Step 6 intro).

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

Both `cwd` and `sandbox_mode` can also live in `~/.vicoop/config.json` under
`backends.codex` so the foreground command can shrink to just
`"$INSTALL_DIR/bin/vicoop-client"`. Env vars still win when set.

`CODEX_CWD` defaults to the current working directory of the client process.
The v1 backend accepts text plus inline image `file.bytes` inputs and returns
text output. `CODEX_SANDBOX_MODE` is optional and accepts `read-only`,
`workspace-write`, or `danger-full-access`; the client passes it to Codex as
`-c sandbox_mode="<mode>"` so the same setting applies to fresh and resumed
Codex sessions.

## Optional: persistence

Only set up persistence after the foreground run connects and the agent
endpoint responds. For local Claude/OpenClaw onboarding, a foreground process
is often enough for first success.

On systemd hosts where `install.sh` wrote a unit, populate the generated
`EnvironmentFile=` with the credentials the daemon needs. The unit reads
this file directly (DynamicUser can't reach `~/.vicoop/config.json` in the
caller's home), so copy the values out of `~/.vicoop/config.json` — or
rerun `setup --write-env-file <path>` pointing at the systemd path to sync
both in one step — and fill in `BACKEND` to match the foreground run:

```sh
SERVER_URL=wss://vicoop-bridge-server.fly.dev
SERVER_TOKEN=<copy from ~/.vicoop/config.json>
AGENT_ID=<your agent id>
BACKEND=openclaw
```

Then reload and start the service using the exact commands printed by the
installer, for example:

```sh
systemctl --user daemon-reload
systemctl --user enable --now vicoop-client
```

For macOS or ad hoc local testing, run the foreground command above directly,
or wrap it in a detached session if you want it to survive the terminal
closing. The bridge does not require systemd; it only needs one live
`vicoop-client` process connected for the agent id.

`nohup … &` tends to lose stdout/stderr on macOS; prefer `screen` or `tmux`
with explicit log redirection so failures are recoverable:

```sh
mkdir -p "$INSTALL_DIR/logs"
screen -dmS vicoop-client bash -lc "BACKEND=claude \"$INSTALL_DIR/bin/vicoop-client\" \
  >> \"$INSTALL_DIR/logs/client.log\" 2>&1"

# tail the log
tail -f "$INSTALL_DIR/logs/client.log"

# stop
screen -S vicoop-client -X quit
```

`launchd` is the persistent option if you want the client to start at login;
write a plist under `~/Library/LaunchAgents/` and load it with
`launchctl load -w`.

### Recommended: restrict who can call your agent

If Step 4 setup did not include `--caller`, the policy has empty
`allowed_callers`, which the dispatcher treats as "public". For normal use, pass
`--caller` during initial setup, or add an allowlist entry afterward with the
`vicoop-client` subcommands (deterministic, scriptable) or a natural-language
request to the admin agent. These paths require an **owner-session token**
(`vbc_owner_*`). Step 4 login saves one locally; you only need to rerun `login`
if that file is missing or expired. Admin scope
(`is_admin()`) is wallet-only and gates only the cross-owner tools.

#### Option A: `vicoop-client` subcommands (recommended for scripts)

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

The `server_token` Step 4 setup writes into `~/.vicoop/config.json` is a
**client** credential and is **not** accepted by these admin commands —
they only accept an owner-session bearer (the separate `~/.vicoop/owner-session.json`
that `login` writes). If the saved bearer is missing or expired, refresh
it without registering a new client:

```sh
"$INSTALL_DIR/bin/vicoop-client" login --bridge "$BRIDGE_URL"
```

These talk to the bridge's `/admin-api/*` routes — same logic the admin
agent's tools run, but without an LLM round-trip per call.

#### Option B: natural-language admin agent

```sh
# $OWNER_TOKEN: vbc_owner_* token from /auth/siwe/exchange or
# /oauth/device/code with intent=owner_session. See "Alternative: SIWE
# onboarding" below for the SIWE path.
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
  authenticated functions. Re-run `vicoop-client login` (or the SIWE
  exchange in the alternative section below) to refresh.

- **`SIWE message has already expired`** — the `expirationTime` was in the
  past when the bridge verified it. Increase `--ttl` or check host clock
  skew.

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
  `clients` row (and cascading `agent_policies`) can be cleaned up via
  the admin agent's CRUD mutations (#29).

## Alternative: SIWE onboarding

If you'd rather own your client identity with an Ethereum EOA than a
Google account, replace Step 4 with the two-step SIWE path:

1. Sign a SIWE message and exchange it at `POST /auth/siwe/exchange` for a
   `vbc_owner_*` session token. SIWE exchange defaults to
   `intent=owner_session`, which is what you want here. See
   [`remote-testing.md` §1](./remote-testing.md) for the full snippet, or
   use `a2a-wallet siwe auth` if the CLI is installed.
2. Call the `registerClient` GraphQL mutation with that owner-session
   token to mint a `CLIENT_TOKEN`:

```sh
OWNER_TOKEN=...   # vbc_owner_* from POST /auth/siwe/exchange

REG=$(curl -sX POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation{registerClient(input:{clientName:\\\"$CLIENT_NAME\\\",allowedAgentIds:[\\\"$AGENT_ID\\\"]}){clientWithToken{id token ownerPrincipal allowedAgentIds}}}\"}")

CLIENT_TOKEN=$(echo "$REG" | jq -r .data.registerClient.clientWithToken.token)
```

The resulting `CLIENT_TOKEN` is identical in shape to the device-flow one;
it just owns the row under an `eth:0x…` principal instead of
`google:sub:…`. After that, Steps 5-6 (agent card, run) are the same as
the Google path.

The same `OWNER_TOKEN` is what you'd present to the admin agent at
`POST /` for managing `allowed_callers` (see "Restrict who can call your
agent" above). Google operators get an equivalent `vbc_owner_*` from the
device flow and can use the admin agent the same way; admin **scope**
(visibility into all owners' rows) remains wallet-only.

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
