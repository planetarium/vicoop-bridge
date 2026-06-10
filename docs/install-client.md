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

- `curl` and one of `sha256sum` / `shasum`. `jq` is also required when
  `install.sh` resolves the latest release for you (skip-able by pinning
  `VERSION` to the exact tag).
- The released client is a self-contained native binary — **no Node.js
  runtime on the host**. Supported platforms: macOS arm64/x64, Linux
  arm64/x64. Windows operators: a PowerShell installer is tracked in
  issue #188; in the meantime download `vicoop-client-<version>-windows-x64.exe`
  from the release page by hand and skip Step 1.
- A reachable bridge URL. The public deployment is
  `https://vicoop-bridge-server.fly.dev`; substitute your own below if you
  run the server yourself.
- A browser on **any** device you can open URLs in. The CLI doesn't need
  to run on the same machine as the browser — device flow is designed for
  exactly that case (e.g. headless server + laptop browser).
- A Google account. No wallet, `a2a-wallet`, or seed phrase required.
- For the OpenClaw backend specifically: an OpenClaw gateway running
  locally at `ws://127.0.0.1:18789` (override via `--openclaw-gateway`
  or `backends.openclaw.gateway_url`).
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

## Step 1 — Install the client binary

The one-liner detects your OS/arch, downloads the matching
`vicoop-client-<version>-<os>-<arch>[.exe]` asset, verifies its `.sha256`,
and installs it as `$INSTALL_DIR/vicoop-client`:

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
| `VERSION` | latest `@vicoop-bridge/client@*` | Pin a specific tag, e.g. `@vicoop-bridge/client@0.1.1`. With `VERSION` set, `jq` is no longer required. |
| `FORCE` | `0` | If `1`, overwrite a non-empty `INSTALL_DIR`. |
| `NO_MODIFY_PATH` | `0` | If `1`, skip the shell-rc PATH edit described in [Step 1b](#step-1b--add-vicoop-client-to-path). Useful on NixOS, immutable OSes, or when a dotfile manager (chezmoi, etc.) owns your rc files. |

What you get after install:

```
$INSTALL_DIR/
└── vicoop-client        # self-contained native binary (Bun --compile)
```

The released binary embeds everything the daemon needs — there are no
sidecar files. Operator-managed state (`~/.vicoop/config.json`,
`~/.vicoop/owner-session.json`, any operator-authored agent cards) lives
outside `$INSTALL_DIR` so the upgrade flow can replace the binary without
touching it.

On macOS, `install.sh` strips the `com.apple.quarantine` xattr right after
the download so first launch isn't Gatekeeper-blocked. Developer ID
signing + notarization are planned (issue #188 follow-up); until then this
keeps `curl | sh` a true one-liner.

> The installer no longer generates an always-on service unit. For
> background operation without a service manager, `start --detach` (Step
> 6b) backgrounds the daemon under a pidfile managed by `stop` / `status`.
> A reboot/crash-persistent service tier (systemd `--user` / launchd via a
> `service install` subcommand) is still being designed — issue #190 tracks
> it. Until then `--detach` is the no-supervisor-available option and the
> foreground run in Step 6 is the supervised one.

## Step 1b — Add `vicoop-client` to PATH

`install.sh` detects your login shell from `$SHELL` and appends one line to
the matching rc file so `vicoop-client` works from any new terminal:

| Shell | File edited | Line appended |
|---|---|---|
| `zsh` | `${ZDOTDIR:-$HOME}/.zshrc` | `export PATH="$INSTALL_DIR:$PATH"` |
| `bash` (macOS) | `~/.bash_profile` | `export PATH="$INSTALL_DIR:$PATH"` |
| `bash` (Linux) | `~/.bashrc` | `export PATH="$INSTALL_DIR:$PATH"` |
| `fish` | `${XDG_CONFIG_HOME:-~/.config}/fish/config.fish` | `fish_add_path $INSTALL_DIR` |

Each entry is prefixed with a `# vicoop-bridge-client (vicoop-client)`
marker comment. Re-running `install.sh` (including with `FORCE=1` or with
a different `$INSTALL_DIR`) strips the existing marker block and
re-appends it with the current target so the rc file never accumulates
duplicates or stale paths. If `$INSTALL_DIR` sits under `$HOME`, the
appended line is written with a literal `$HOME/...` prefix so it stays
portable across machines for the same operator.

To pick the change up in the shell where you just ran `install.sh`, either
open a new terminal or `source` the rc file the installer prints in its
post-install summary:

```sh
source ~/.zshrc           # or ~/.bash_profile, ~/.bashrc, ~/.config/fish/config.fish
vicoop-client --version   # sanity-check
```

The rest of this doc uses bare `vicoop-client` everywhere. If you opted out
of this step with `NO_MODIFY_PATH=1` (see below), prefix every example
with `"$INSTALL_DIR/"` — e.g. `"$INSTALL_DIR/vicoop-client" --version`.

### Opting out

Set `NO_MODIFY_PATH=1` on the same `install.sh` invocation if you'd rather
manage `PATH` yourself — recommended on NixOS, immutable OSes, or when a
dotfile manager (chezmoi, yadm, etc.) owns your shell rc files. The
installer prints both the exact line it would have appended **and** the
shell-specific rc file it would have appended to, so you can route the
line wherever your dotfile setup expects:

```sh
curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh \
  | INSTALL_DIR="$HOME/vicoop-bridge-client" NO_MODIFY_PATH=1 sh
```

Operators on tcsh / ksh / other shells `install.sh` can't auto-detect get
the same printed instructions automatically — no need to set
`NO_MODIFY_PATH=1` explicitly.

## Step 2 — Verify the installed bundle

If `$INSTALL_DIR` already existed before Step 1, `install.sh` refuses to
overwrite it unless you pass `FORCE=1`. That's intentional: an existing
directory may contain a working client binary or operator-authored files
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
include the `auth login` command used in Step 4:

```sh
vicoop-client -v
vicoop-client auth login --help
```

If `auth login --help` prints usage, you're on a current binary and can
move on. The flat `login` alias still works on current binaries but emits a
`[deprecated] Use auth login` notice to stderr — see the legacy aliases
note in Step 4.

## Step 3 — Pick an agent id

The agent id is the routing key external A2A callers use to reach your
client. Pick something unlikely to collide across operators:

```sh
# By hostname
AGENT_ID="openclaw-$(hostname | cut -d. -f1)"

# Or random
AGENT_ID="$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-8)-openclaw"

echo "$AGENT_ID"
```

> **Self-hosting the bridge.** `login` / `agent register` / the daemon all
> default to the public bridge at `https://vicoop-bridge-server.fly.dev`
> (HTTPS for `login` / `agent register` / admin commands; `wss://…` for the
> daemon). If you
> run your own bridge, pass `--server <https://your-bridge>` to `auth login` and
> `--server <wss://your-bridge>` to the daemon (or persist `server_url`
> in `config.json`). Every example below uses the public defaults; the
> self-host overrides are the only place the URL has to change.

`registerClient` (called for you by `vicoop-client agent register` in
Step 4) does not pre-validate availability; collisions surface only at WS
connect time.
If you want to probe ahead, hit `agentIdAvailable(agentId)` GraphQL after
login — it's a SECURITY DEFINER probe that returns boolean availability
across every owner without leaking `owner_principal`. Most operators just
pick a hostname/uuid prefix and skip the probe.

## Step 4 — Login and register your agent

`vicoop-client auth login` only signs you in as the agent owner and saves
an owner-session bearer to `~/.vicoop/owner-session.json`. It does **not**
create an agent registration. `vicoop-client agent register` then uses that
saved owner-session to call `registerClient` and mint a one-time
`AGENT_TOKEN`. No wallet or SIWE required.

```sh
vicoop-client auth login

vicoop-client agent register \
  --agent-id "$AGENT_ID" \
  --caller "eth:0x<40-hex>"
```

(Self-hosting? Pass `--server https://<your-bridge>` to `auth login`.)

`login` prints a verification URL to stderr — open it in **any** browser
(the same machine, or your laptop while running the CLI on a headless host)
and authorize with your Google account. `agent register` calls the bridge's
`registerClient` mutation, configures any `--caller` allowlist entries, and
persists the daemon credentials to the resolved vicoop config dir
(`~/.vicoop/config.json` by default; see the resolution order below for
`$VICOOP_HOME` / `$XDG_CONFIG_HOME` cases), mode 600 — see #137 for the
consolidated config layout. The success output looks like:

```text
  agent_id         openclaw-my-host
  owner_principal  google:sub:<sub>

The AGENT_TOKEN is one-time — the bridge cannot reissue it.
  agent register persists it to the canonical config below; --json prints it to
  stdout instead. Back up that file before rotating hosts.
  To also stash it in a shell-sourceable env file, pass --write-env-file
  on this same agent register invocation — rerunning agent register later would call
  registerClient again and mint a NEW AGENT_TOKEN, invalidating this
  one. To populate an env file from an already-issued token, copy
  SERVER_URL / SERVER_TOKEN / AGENT_ID out of config.json by hand.

Wrote /home/you/.vicoop/config.json (mode 600).
```

> **Legacy flat aliases.** The flat `setup` / `login` / `logout` / `whoami`
> commands still work (with the same flags as their umbrella replacements)
> but now print a one-line deprecation warning to stderr pointing at their
> `agent register` / `auth login` / `auth logout` / `auth whoami` form.
> `setup` additionally keeps its old `--client-name` / `--agent-ids` flags
> and the `CLIENT_TOKEN` / `client_id` / `client_name` vocabulary on
> stderr for script back-compat. All four will be removed in a future
> release.

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

`agent register` only writes the three credentials above; backend defaults
are hand-edited into the same file. The common shape (every field optional —
omit what you don't need) is:

```json
{
  "server_url": "wss://vicoop-bridge-server.fly.dev",
  "server_token": "<written by agent register>",
  "agent_id": "<written by agent register>",
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

The schema also accepts a top-level `card` mirroring the `--card` flag
(rarely needed: the bridge already publishes a canonical card per backend
— see Step 5).

Daemon precedence is **CLI flag > `--config <path>` > canonical
`config.json` > built-in default**. Env vars are not consulted for
runtime config (#189 §5) — secrets and overrides live in `config.json`
(mode 600) or in flags. `agent register` only ever touches `server_url`,
`server_token`, and `agent_id` — hand-edits to the other fields survive
re-runs.

> **Top-level vs `backends.*` parity.** Every operator-tunable knob is
> reachable as a CLI flag and as a `config.json` field — pick whichever
> surface fits the deployment. Top-level fields (`server_url`,
> `server_token`, `agent_id`, `backend`, `card`) map to `--server`,
> `--token`, `--agentId`, `--backend`, `--card`. Per-backend `cwd` /
> `runtime` keys under `backends.<active>.*` map to the unified
> `--cwd` / `--runtime` flags (scoped to whichever backend `--backend`
> selected). Backend-specific fields map to `--claude-settings-file`,
> `--codex-sandbox`, `--openclaw-gateway`, `--openclaw-gateway-token`,
> `--openclaw-agent`, `--openclaw-openai-compat-agent`,
> `--openclaw-task-timeout-ms`.

> **Env vars are out of the runtime-config chain.** Past releases also
> consulted `SERVER_URL` / `SERVER_TOKEN` / `AGENT_ID` / `BACKEND` /
> `CLAUDE_*` / `CODEX_*` / `OPENCLAW_*` between the flag and config
> layers. Those reads were removed in this release per #189 §5: env at
> that position adds no expressive power that `--config <path>` doesn't
> already provide, but it adds invisible state (shell rc files, CI env
> bleed, stale exports). Existing operators with env-only setups need to
> either run `agent register` (which persists `server_url` / `server_token` /
> `agent_id` into `config.json`) or pass the equivalent CLI flags.
>
> Env vars the client still reads (different category — they pick *where*
> config lives, not *what's in* it): `VICOOP_HOME`, `XDG_CONFIG_HOME`,
> `HOME` (config-dir resolution), `VICOOP_BRIDGE` / `VICOOP_OWNER_TOKEN`
> (admin-command owner-session bootstrap, same role as `KUBECONFIG`),
> `VICOOP_CLIENT_LOG_LEVEL` (logging diagnostic).

If you omit `--caller`, `agent register` does **not** leave the agent public.
Instead it auto-mints a static API key for the agent and prints the secret
**once**, so the agent is immediately callable only by holders of that key:

```text
Minted an API key for <agent-id> (no --caller was given, so the agent
is restricted to this key instead of being left public):
  key_id      Ab3-_xYz12
  principal   apikey:Ab3-_xYz12
  expires_at  2027-06-01T00:00:00.000Z

  API key (shown once — store it now, it cannot be recovered):
    vbc_caller_…
```

Callers present it as `Authorization: Bearer <api_key>`. Keys are unified with
the regular caller surface: list them with `vicoop-client agent callers list`
(shown as TYPE=apikey) and revoke with
`vicoop-client agent callers remove <agent-id> apikey:<key-id>` (this drops the
principal **and** kills the token), or add interactive (Google/SIWE) callers
with `vicoop-client agent callers add`. With `--json`, the key rides along in
the register payload under an `api_keys` array. If key minting fails (an older
bridge without the apikeys route, or a transient error), the command falls back
to the legacy public-agent warning so you can lock it down by hand. The
deprecated `setup` alias keeps the old warning behavior unchanged.

> `--caller` / auto-minted API keys require a bridge server version that
> stores caller allowlists on registered agents. If you are testing against
> your own deployment, deploy the matching server/schema before this step.

> ⚠ The `AGENT_TOKEN` is unrecoverable after this single output.
> `config.json` is the only place it persists; back it up if you need to
> rotate hosts. To rotate the token later, use the `rotateClientToken`
> GraphQL mutation (requires a `vbc_owner_*` session token; the default
> login flow saves one locally for you). Rotation surfaces a new
> AGENT_TOKEN, also one-time.

For scripting, pass `--json` instead of writing `config.json` if you want to
compose with shell tooling (no disk side effects, raw response on stdout):

```sh
vicoop-client agent register \
  --agent-id "$AGENT_ID" \
  --caller "eth:0x<40-hex>" --json \
  | tee /tmp/vicoop-agent.json
AGENT_TOKEN=$(jq -r .client_token /tmp/vicoop-agent.json)
```

`--json` keeps the `registerClient` response shape (`client_id`,
`client_token`, `client_name`, `allowed_agent_ids`) for back-compat with
existing scripts. New scripts can read `allowed_agent_ids[0]` as the
agent id and `client_token` as the agent token.

The bridge's server model is 1:1 (#219): one `agent register` call creates
one agent registration with one id. To change that id later, use the
`updateClientAllowedAgents` GraphQL compatibility mutation (backed by
`update_client_allowed_agents()` in `schema.sql`) without issuing a new
token.

### What login and agent register do

1. `login` calls `POST /oauth/device/code` with `intent=owner_session`; the bridge stores
   a `device_sessions` row and returns a one-time `device_code` + 8-char user
   code.
2. Operator opens the verification URL, signs in with Google, and the
   approval page authorizes an owner-session login for bridge management.
3. CLI polls `POST /oauth/token`. Once status flips to `approved`, the
   bridge returns a `vbc_owner_*` bearer, and `login` saves it to
   `~/.vicoop/owner-session.json` (mode 600).
4. `agent register` calls the authenticated GraphQL `registerClient` mutation
   with that bearer, receives `{client_id, client_token, owner_principal,
   allowed_agent_ids}`, and writes the daemon credentials into
   `~/.vicoop/config.json` (mode 600). With `--write-env-file <path>` it
   additionally emits a shell-sourceable env file at that path — useful as
   a credentials audit/backup record, though the daemon no longer reads
   those env vars (#189 §5); it always sources runtime config from
   `config.json` or `--config <path>`. It never sees a `vbc_caller_*`
   token.

This means a Google-only operator can stand up a bridge client without
ever holding a wallet or seed phrase. Owner is recorded as
`google:sub:<sub>` (stable id, not the email).

## Step 5 — Choose a backend and optional agent card

Pick the local backend this client should drive (selected by
`--backend <name>` or `"backend": "<name>"` in `config.json`):

- `openclaw` — OpenClaw gateway (default `ws://127.0.0.1:18789`)
- `claude` — local Claude Code CLI
- `codex` — local Codex CLI
- `echo` — smoke-test backend

For these built-in backends, you normally do **not** pass an agent card file.
The client sends the selected backend name as `backendKind`, and the bridge
server publishes the canonical card for that backend at
`GET <bridge>/agents/<agent_id>/.well-known/agent-card.json`. That keeps
metadata/capability fixes on the faster server deploy path instead of
requiring every operator to upgrade their client bundle.

Starter cards for the built-in backends (`openclaw.json`, `claude.json`,
`codex.json`, `echo.json`) live in the source tree under
[`packages/client/cards/`](https://github.com/planetarium/vicoop-bridge/tree/main/packages/client/cards) —
download whichever one you want to base an override on. The native binary
itself doesn't ship them on disk (the bridge already publishes the
canonical card per backend, and the daemon only reads cards from disk when
you explicitly pass `--card`). Pass `--card <path>` (or set `"card"` in
`config.json`) only when you intentionally want to override the server
card, for example to:

- Rename `name` to something meaningful (it defaults to `openclaw`).
- Tighten `description` to what this specific instance actually does.
- Adjust `skills[]` if you've customized the backend.

To see what the bridge currently advertises for this agent (before deciding
whether to override), connect the client once and `curl` the `a2a card` URL
that `vicoop-client auth whoami` prints — see ["Check your agent's mention /
acct"](#check-your-agents-mention--acct-any-backend) in Step 6.

Schema reference: `packages/protocol/src/index.ts` (`AgentCard` Zod schema,
validated by the client at startup when `--card` is set — invalid cards
exit with a Zod error).

For custom backends, write a fresh card anywhere on disk and point
`--card` (or `"card"` in `config.json`) at it. The single-file binary
keeps `$INSTALL_DIR` clean for upgrades, so the conventional spot is
under your vicoop config dir, e.g. `~/.vicoop/cards/my-agent.json`:

```sh
mkdir -p ~/.vicoop/cards
cat > ~/.vicoop/cards/my-agent.json <<'JSON'
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

Run the client in the foreground first. The daemon entrypoint is the
explicit `start` subcommand. With `config.json` written by Step 4 the
daemon picks up `server_url`, `server_token`, and `agent_id` on its own;
pick the backend with `--backend`:

```sh
vicoop-client start --backend openclaw
```

Precedence at startup is **CLI flag > `--config <path>` > canonical
`config.json` > built-in default**. Env vars are not consulted for
runtime config (#189 §5). With `"backend": "openclaw"` persisted in
`config.json`, the daemon needs no flags at all:
`vicoop-client start`.

> Bare `vicoop-client` (no subcommand) prints the top-level help and
> exits 0; it no longer starts the daemon. Earlier releases booted the
> daemon on empty argv, which made an operator who just wanted to see
> the help inadvertently open the WS. The flags-only form
> (`vicoop-client --backend ...`) is rejected with a parse error now —
> use `vicoop-client start --backend ...` instead.

On success you'll see a `[client] connected, sending hello` log followed
by an identity block — same data `vicoop-client auth whoami` would print, so
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

- The bridge loads the `allowed_callers` list for your agent. If Step 4 (the
  `agent register` call) included `--caller`, that allowlist is already in
  place; otherwise `agent register` auto-minted an API key (printed once) and
  added its `apikey:<key-id>` principal to `allowed_callers`, so the agent is
  restricted to that key rather than being publicly callable.
- `POST $BRIDGE_URL/agents/$AGENT_ID` with a JSON-RPC `message/send` payload
  reaches your backend and the reply is returned inline.

## Step 6b — Run unattended (`--detach`)

Once the foreground run is healthy, background it with `--detach`:

```sh
vicoop-client start --detach --backend openclaw
vicoop-client status        # running (pid …, up …, logs …)
vicoop-client stop          # SIGTERM → grace → SIGKILL
```

`--detach` re-execs the daemon as a new **session / process-group leader**
and returns immediately. Unlike `nohup vicoop-client … &` — which only
ignores SIGHUP and stays in the launching shell's process group — the
detached daemon survives the session/pgrp teardown that agent-driven exec
sandboxes (e.g. Codex `exec_command`) send when a shell turn ends. It writes
a pidfile (`vicoop.pid`) and redirects stdout+stderr to a log
(`vicoop.log`, override with `--log-file`) under the canonical home dir; both
`stop` and `status` read that pidfile.

- `status` exit codes: **0** running, **3** stopped (no pidfile), **1** stale
  (pidfile present but no live `vicoop-client` daemon behind it — `stop`
  cleans it up). `stop` / `status` refuse to act on a recycled PID: they
  confirm the live process is the same one recorded (by its OS start identity)
  before signaling it.
- A second `start --detach` while one is already running is **rejected** (the
  pidfile is claimed atomically, so this holds even under a concurrent
  double-launch). This is deliberate, not just tidiness: two daemons sharing
  the same client token **don't coexist** — the bridge keeps only the newest
  connection and evicts the other with close code **4009**, so the pair would
  *ping-pong* (each reconnect kicking the other) with no server-side
  resolution, leaving you to hunt down and kill the duplicate by hand. The
  `--detach` lock prevents that duplicate-process state at the source; `stop`
  the running daemon first if you really mean to restart it.

> **Scope caveat.** `--detach` survives **session / process-group** reaping,
> which is what the agent-sandbox case needs. It does **not** survive
> **cgroup / container** teardown (an environment that kills the whole cgroup
> at turn end) or a reboot — for those you need an out-of-cgroup supervisor
> (systemd `--user` / launchd). That persistence tier is tracked in issue
> #190. The detached lifecycle (`start --detach` / `stop` / `status`) is
> POSIX-only and refused as a unit on Windows (the detach mechanism, the
> PID-reuse guard, and signal semantics all differ there) — on Windows run
> `vicoop-client start` in the foreground under a Windows service manager
> (e.g. NSSM) instead.

### OpenClaw-specific knobs

The OpenClaw backend connects outbound to a local OpenClaw gateway over a
second WS. Override if yours isn't on the default — each knob takes the
usual flag > `backends.openclaw.*` precedence:

| Flag | `backends.openclaw.*` | Default |
|---|---|---|
| `--openclaw-gateway` | `gateway_url` | `ws://127.0.0.1:18789` |
| `--openclaw-gateway-token` | `gateway_token` | *(none)* |
| `--openclaw-agent` | `agent` | `main` |
| `--openclaw-openai-compat-agent` | `openai_compat_agent` | *(unset, single-agent mode)* |
| `--openclaw-task-timeout-ms` | `task_timeout_ms` | backend default |

`--openclaw-openai-compat-agent` (and its config equivalent) names a
secondary OpenClaw agent dedicated to tasks carrying the A2A openai-compat
extension metadata. When set, the bridge routes those tasks via
`agent:<this>:<contextId>` sessionKeys; non-extension tasks keep using the
primary `--openclaw-agent`. Pairs with a `tools.deny=["*"]` `agents.list`
entry on the OpenClaw side — see the box below.

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
> Then set `--openclaw-openai-compat-agent oai` (or
> `backends.openclaw.openai_compat_agent: "oai"` in `config.json`)
> on the vicoop-client side. Pilot measurement on
> `anthropic/claude-sonnet-4-6` saw envelope-contract compliance
> rise from 5/10 (single-agent baseline, full tools) to 10/10 with
> this split. Leave the flag unset and you get today's single-agent
> behavior on every task.

### Claude-specific knobs

For the Claude backend, pass `--backend claude` (or persist
`"backend": "claude"` in `config.json`) and optionally point Claude at a
different repository than the one `vicoop-client` itself runs in:

```sh
vicoop-client start \
  --backend claude \
  --cwd "$HOME/vicoop-bridge" \
  --claude-model claude-opus-4-8 \
  --claude-supported-models claude-sonnet-4-6,claude-haiku-4-5
```

These knobs can also live in the canonical `config.json` (resolved per Step
4 — `~/.vicoop/config.json` by default) under `backends.claude`
(`cwd`, `settings`, `model`, `supported_models`) so the foreground command shrinks to
just `vicoop-client start`; the flag wins over config, mirroring
the daemon-level precedence (Step 6 intro).

| Flag | `backends.claude.*` |
|---|---|
| `--cwd` | `cwd` |
| `--claude-settings-file` | `settings` (JSON object) |
| `--claude-model` | `model` |
| `--claude-supported-models` | `supported_models` (string array) |

> **Picking a model.** `--claude-model <id>` (e.g. `claude-opus-4-8`) is
> folded into Claude `--settings` as its `model` field, so it composes with
> the sandbox default and any `--claude-settings-file` you supply rather than
> replacing them. Leave it unset to let `claude` resolve its own model
> (project / user `settings.json`, `ANTHROPIC_MODEL`, built-in default). A
> per-request openai-compat `model` still overrides it. The flag is
> claude-only — pairing it with another `--backend` exits non-zero.

> **Serving more than one model.** Claude Code has no headless "list
> models" interface, so by default the bridge advertises (and accepts
> per-request `model` overrides for) only the single default model —
> the `--claude-model` pin or the startup-probed id. To open up more,
> declare them: `--claude-supported-models claude-sonnet-4-6,claude-haiku-4-5`
> (comma-separated) or `backends.claude.supported_models` in `config.json`. Declared
> ids are advertised on the agent card's openai-compat `params.models[]`
> after the default, and a per-request openai-compat `model` matching one
> rides to the spawned `claude` as `--model <id>`. The list is **not
> validated against your account** — a declared model your plan can't
> access fails at task time with Claude's own `model_not_found` error, so
> only declare models you've confirmed work in your local `claude`. The
> flag is claude-only, same as `--claude-model`.

> **Sandbox-on by default.** When neither `--claude-settings-file` nor
> `backends.claude.settings` is set, the backend forwards
> `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true}}'` to every
> spawned `claude`. The OS-level sandbox (Seatbelt on macOS, bubblewrap on
> Linux) is on; `failIfUnavailable: true` means a host that can't enable it
> exits at startup instead of silently running with full host access. To
> widen the policy (extra `allowedDomains`, `allowWrite`, etc.) supply a
> complete `settings` object — it replaces the default entirely. To run
> without a sandbox, pass `{ "sandbox": { "enabled": false } }`.

`--cwd` defaults to the current working directory of the client
process. Set it when the released bundle lives outside the repository you
want Claude to edit. (Same flag is shared with the Codex backend; it's
scoped to whichever backend `--backend` selects.)

The Claude backend also injects a small `--append-system-prompt` on every
spawned `claude` telling it its own A2A mention (`@<agentId>@<host>`) so
the model recognises self-references in user messages and doesn't try to
a2a-call its own address (see #128). No configuration required — it's
derived from `--agentId` and the host part of `--server`.

> **Note on host derivation.** The injected mention uses the server URL's
> host (e.g. `wss://bridge.example.com/ws` → `bridge.example.com`). The
> bridge's canonical Mentionable/WebFinger domain comes from `PUBLIC_URL`
> on the server side. If the two differ (e.g. a custom domain in front of
> a Fly hostname), the model is taught a mention that doesn't match what
> users see via WebFinger and self-reference detection won't fire. Run
> `vicoop-client auth whoami --verify` to confirm the WebFinger lookup actually
> resolves the agent under the derived host; align `--server` with
> `PUBLIC_URL`'s host if it doesn't.

### Check your agent's mention / acct (any backend)

After the first `connected` log, run `vicoop-client auth whoami` to surface every
identifier external callers will see for this agent — the WebFinger acct, the
`@<agentId>@<host>` mention, the JSON-RPC endpoint, and the agent-card URL.

```sh
vicoop-client auth whoami
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
   it into the other agent's `allowed_callers` (via `agent callers add` or
   the admin agent) so it can call you. Same value goes into the **OpenClaw gateway
   persona** if you want self-reference recognition on the OpenClaw backend
   (configured via `openclaw config set ...` since `chat.send` has no
   per-message system field). `a2a` is the JSON-RPC endpoint another caller
   would POST to (e.g. `a2a-wallet a2a stream <a2a> "..."`).
2. **Confirm which card the bridge advertises.** `curl` the `a2a card` URL —
   that's the canonical card external callers receive, which is the
   server-published default for the selected backend unless you pass
   `--card <path>` (or `"card"` in `config.json`) to override it (see Step 5). If the
   response doesn't match what you expect, that's the cue to override.

   ```sh
   CARD_URL=$(vicoop-client auth whoami --json | jq -r .a2aCardUrl)
   curl -sf "$CARD_URL" | jq .
   ```
3. **Verify WebFinger actually resolves the acct.** `auth whoami --verify`
   additionally fetches the WebFinger URL and reports whether the bridge
   resolves this agent's acct under the derived host. This catches the
   client server URL host vs bridge `PUBLIC_URL` mismatch flagged in the
   Claude-specific note above; if `--verify` fails, align the two before
   trusting self-reference detection or external mentions.

`--json` emits a machine-readable record of all the same fields for scripts.

### Codex-specific knobs

For the Codex backend, pass `--backend codex` (or persist
`"backend": "codex"` in `config.json`) and optionally point Codex at a
different repository / loosen the sandbox:

```sh
vicoop-client start \
  --backend codex \
  --cwd "$HOME/vicoop-bridge" \
  --codex-sandbox workspace-write
```

Both knobs can also live in the canonical `config.json` (resolved per Step
4 — `~/.vicoop/config.json` by default) under `backends.codex` so the
foreground command can shrink to just `vicoop-client start`.
The flag wins over config.

| Flag | `backends.codex.*` |
|---|---|
| `--cwd` | `cwd` |
| `--codex-sandbox` | `sandbox_mode` |

`--cwd` defaults to the current working directory of the client
process (shared with the Claude backend; scoped to whichever backend
`--backend` selects). The v1 backend accepts text plus inline image
`file.bytes` inputs and returns text output. `--codex-sandbox` is
optional and accepts `read-only`, `workspace-write`, or
`danger-full-access`; the client passes it to Codex as
`-c sandbox_mode="<mode>"` so the same setting applies to fresh and
resumed Codex sessions.

> **Sandbox-on by default.** With neither `--codex-sandbox` nor
> `backends.codex.sandbox_mode` set, the backend passes
> `-c sandbox_mode="read-only"` explicitly — the same default Codex CLI
> applies, but stamped into argv so the posture is visible in `ps` /
> audit logs and survives any future change to Codex's own default.

> **`cwd` need not be a git repository.** The Codex backend speaks
> `codex app-server` over stdio JSON-RPC and does not require a
> git-trusted directory the way `codex exec` did (#147). Sandboxing is
> unchanged — the cwd-trust check was a CLI ergonomics gate, not part
> of `sandbox_mode`.

> **Approval prompts.** When codex sends a server-initiated approval
> request (`execCommandApproval` / `applyPatchApproval`) the backend
> answers with `decline` by default — safe even under
> `workspace-write`. Operators that want auto-accept set
> `backends.codex.approval_decision` to `accept` or `acceptForSession`
> in `config.json`.

## Manage caller allowlists

If Step 4 `agent register` did not include `--caller`, it auto-minted a static
API key and seeded `allowed_callers` with that key's principal, so the agent is
restricted to the key rather than "public" (an empty `allowed_callers` is what
the dispatcher treats as public). To broaden access, pass `--caller` during
initial registration, or add an allowlist entry afterward with the
`vicoop-client` subcommands (deterministic, scriptable) or a natural-language
request to the admin agent. These paths require an
**owner-session token** (`vbc_owner_*`). Step 4 login saves one locally;
you only need to rerun `login` if that file is missing or expired. Admin
scope (`is_admin()`) is wallet-only and gates only the cross-owner tools.

### Option A: `vicoop-client` subcommands (recommended for scripts)

Check that you're on a current release before using the admin subcommands
below — `upgrade --check` reports the live version against the latest
published release:

```sh
vicoop-client -v
vicoop-client upgrade --check   # report latest vs current
vicoop-client upgrade           # upgrade in place if behind
```

```sh
# Step 4 login saves the owner-session bearer, so these work without re-authenticating:
vicoop-client agent register \
  --agent-id "$AGENT_ID" \
  --caller "eth:0x<40-hex>"
vicoop-client agent list --connected
vicoop-client agent callers list "$AGENT_ID" --json
vicoop-client agent callers add "$AGENT_ID" "eth:0x<40-hex>"
vicoop-client agent callers remove "$AGENT_ID" "google:email:caller@example.com"

# Pass --json for machine-readable output, or --server / --token to override
# the saved session for one call. VICOOP_BRIDGE / VICOOP_OWNER_TOKEN env vars
# work too (handy for CI).
```

The `server_token` Step 4 `agent register` writes into the canonical
`config.json` is the per-**agent** credential and is **not** accepted by
these admin commands — they only accept an owner-session bearer (the
separate `owner-session.json` that `login` writes alongside it). If the
saved bearer is missing or expired, refresh it without re-registering:

```sh
vicoop-client auth login
```

(Self-hosting? Pass `--server https://<your-bridge>`.)

These talk to the bridge's `/admin-api/*` routes — same logic the admin
agent's tools run, but without an LLM round-trip per call.

### Option B: natural-language admin agent

```sh
# $OWNER_TOKEN: vbc_owner_* token from /oauth/device/code with
# intent=owner_session (the bearer Step 4 login saved into
# ~/.vicoop/owner-session.json works directly).
# Self-hosting? Swap the URL for your own bridge.
BRIDGE_URL=https://vicoop-bridge-server.fly.dev
WALLET_PRINCIPAL="eth:$(a2a-wallet status | awk '/Address/{print tolower($2)}')"

curl -sX POST "$BRIDGE_URL/" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"messageId\":\"ac\",\"role\":\"user\",\"kind\":\"message\",\"parts\":[{\"kind\":\"text\",\"text\":\"Use add_caller to add '${WALLET_PRINCIPAL}' to agent '${AGENT_ID}'.\"}]}}}" \
  | jq -r '.result.status.message.parts[0].text'
```

Either path hot-reloads via `registry.updateAllowedCallers` — no client
restart needed.

### Static API keys (non-interactive callers)

`eth:`, `google:sub:`, `google:email:`, and `google:domain:` callers all
authenticate through an interactive login (a wallet signature or a Google
OAuth flow). For callers that can't do that — a CI job, a backend service, a
script — mint a **static API key** instead. The key is a long-lived
`vbc_caller_*` bearer whose `apikey:<key-id>` principal is auto-added to the
agent's `allowed_callers`, so issuing it both creates the credential and
authorizes it in one step:

Minting is the only key-specific command; everything else is the regular
caller surface (a key is just "a caller the bridge issued a secret for"):

```sh
# Mint a key (the raw secret is printed exactly once — store it now):
vicoop-client agent callers issue-api-key "$AGENT_ID" --label ci-deploy
# Optional: override the default 365-day lifetime
vicoop-client agent callers issue-api-key "$AGENT_ID" --ttl-days 30 --json

# List / revoke through the unified caller commands:
vicoop-client agent callers list "$AGENT_ID"                      # apikey rows show TYPE=apikey
vicoop-client agent callers remove "$AGENT_ID" "apikey:<key-id>"  # drops principal AND revokes token
```

The caller then presents the key as a normal bearer:
`Authorization: Bearer vbc_caller_…` against
`POST $BRIDGE_URL/agents/$AGENT_ID`. Removing the `apikey:<key-id>` principal
both de-authorizes it and revokes the underlying token; it takes effect within
~60s. Minting hits `POST /admin-api/agents/:id/apikeys` and listing/removal hit
`/admin-api/agents/:id/callers` — all owner-authenticated like the commands
above.

## Updating the client

Once installed, the client updates itself — do not re-run `install.sh`. The
installer's `FORCE=1` path is destructive (it `rm -rf`s `$INSTALL_DIR`) and
is reserved for bootstrapping.

```sh
vicoop-client upgrade --check      # report latest vs current
vicoop-client upgrade              # upgrade to latest @vicoop-bridge/client@*
vicoop-client upgrade --version 0.2.0   # pin / downgrade (bare version, v0.2.0, or @vicoop-bridge/client@0.2.0 all accepted)
vicoop-client upgrade --force      # reinstall the resolved target even if already on it
```

The upgrade command:

1. Queries GitHub releases for the latest `@vicoop-bridge/client@*` tag (or
   the `--version` you pin) and resolves the per-platform asset name from
   `process.platform` / `process.arch` (must match this host).
2. Downloads `vicoop-client-<version>-<os>-<arch>[.exe]` + its `.sha256`
   into `$INSTALL_DIR` as `vicoop-client.new`, verifies the checksum, and
   chmods +x.
3. Runs `$INSTALL_DIR/vicoop-client.new --version` as a healthcheck. If it
   exits non-zero or reports the wrong version, `.new` is deleted and the
   upgrade aborts with no change to the live binary.
4. Atomically swaps: `$INSTALL_DIR/vicoop-client` → `vicoop-client.prev`,
   `vicoop-client.new` → `vicoop-client`. A failure mid-swap restores the
   original. On unix the running daemon keeps executing from the unlinked
   inode — the file swap is safe under load (see "Manual restart" below).
5. Keeps `vicoop-client.prev` around for manual rollback (`mv` it back over
   `vicoop-client` if needed). Delete it once the new version is proven.

**Permissions**: for a system-scope install (root-owned `$INSTALL_DIR`),
run the upgrade via `sudo`. The command checks write access up front and
fails fast with a clear error otherwise.

**Operator-owned state is not touched by `upgrade`.** The binary swap
only ever moves three filenames inside `$INSTALL_DIR` (`vicoop-client`,
`vicoop-client.new`, `vicoop-client.prev`). Anything else you've left
under `$INSTALL_DIR` (operator-authored cards, notes, scratch files) is
preserved automatically. Outside `$INSTALL_DIR`, your canonical
`~/.vicoop/config.json` (Step 4) and `~/.vicoop/owner-session.json`
(`login`) are out of scope for upgrades entirely. `FORCE=1` on
`install.sh` deletes everything under `$INSTALL_DIR` first — back up any
operator-added files before running it.

**Manual restart after upgrade.** The atomic swap leaves your running
client process attached to the previous bundle. Stop it and start it again
with your usual command (foreground / screen / tmux) so the new version
takes effect — `upgrade` cannot signal a process it didn't start. To check
for stragglers, run `pgrep -fl vicoop-client` and kill any
old process before starting the new one. Multiple client processes
connecting with the **same `SERVER_TOKEN`** for one `AGENT_ID` collide and
the older WS is closed with code 4009 (harmless but noisy); see the Gotchas
section of `docs/local-testing.md` for the same note.

## Troubleshooting

- **`agent id owned by a different principal`** (WS register) — your
  principal is not the `owner_principal` on the existing agent registration.
  Pick a different `agent_id`, or sign in from the original owner before
  changing that registration. Re-run Step 4 only if you intentionally want a
  new client/token.

- **`permission denied for function register_client`** (or similar) on
  GraphQL — the caller token was missing, malformed, or expired, so the
  request fell back to the `app_anonymous` Postgres role (see
  `packages/server/src/postgraphile.ts`) which has no EXECUTE on
  authenticated functions. Re-run `vicoop-client auth login` to refresh.

- **Device flow timed out** — the `vicoop-client auth login` deadline matches
  the bridge's `device_sessions.expires_at` (10 min by default). If the
  browser approval is delayed past that, re-run `login`; the previous
  device code is invalidated automatically.

- **Client reconnects but `/agents/:id` returns 404** — the agent
  registration exists but no WS session is live. Check the client log;
  dispatch requires an active session.

- **Lost the `AGENT_TOKEN`** (formerly surfaced as `CLIENT_TOKEN`) — the
  raw value is unrecoverable, but you don't need to create a new agent
  identity. Rotate the token in place via the `rotateClientToken` GraphQL
  mutation (backed by `rotate_client_token()` in `schema.sql`): it mints a
  fresh raw token for the existing agent registration and invalidates the
  old hash, so your agent id and caller allowlist carry over. Re-run Step
  4 only if you intentionally want a new agent identity; in that case the
  old registration can be revoked from the CLI — see
  [Inspecting and revoking your agents](#inspecting-and-revoking-your-agents).

## Inspecting and revoking your agents

`vicoop-client agent list --connected` only shows *currently connected*
agents. To see every agent registered under your owner principal — including
orphans left behind by an aborted `agent register`, an exited daemon, or a
leaked `AGENT_TOKEN` — drop the flag:

```bash
vicoop-client agent list
```

The table columns are `AGENT_ID`, `NAME`, `CONNECTED`, `REVOKED`, and
`REGISTERED_AT`. The `connected` flag reflects in-memory registry state, so a
row with `connected: false` is exactly the kind of orphan you want to clean
up. (`--json` additionally returns the legacy `client_id` UUID for scripts
that still reference it.)

To revoke an agent — and disconnect its live WebSocket if one is bound —
pass the agent id, the legacy registration id, or a unique registration
name:

```bash
vicoop-client agent revoke <agent-id-or-name>
```

- A revoked agent's compatibility row is kept (`revoked = true`) so audit
  history survives.
- A unique name resolves automatically; an ambiguous name exits non-zero
  with a list of matching ids so you can retry with the id.
- If the daemon is alive at the moment of revocation, its WebSocket is
  closed with code **4014 "client revoked"** and the daemon exits
  non-zero without reconnecting.
- If the daemon is **relaunched** with the same token after revocation
  (rather than already being live), the bridge's WS auth path rejects
  the hello with **close code 4005 "bad token"** — the daemon treats
  4005 as terminal too (same `onFatal` path as 4014), so it exits
  non-zero on the first reconnect attempt rather than reconnect-loop
  indefinitely against a permanently-rejected token. The same 4005
  branch catches plain mis-typed / wrong tokens at first launch.
- Propagation is **synchronous from the next auth attempt**: client-token
  verification queries the unified `agents` table directly on every WS
  register with no cache, so there is no equivalent of the 60s `callers`
  LRU window.

Both subcommands use the same owner-session bearer as `agent callers add`
/ `remove`; no SIWE re-sign required.

> **Deprecated flat aliases.** The older `list-agents`, `list-clients`,
> `revoke-client`, `add-caller`, `remove-caller`, and `list-callers`
> commands still work but print a one-line deprecation warning to stderr
> pointing at their `agent <sub>` replacement. They will be removed in a
> future release.

## What's next

- **Bind more agents to the same token**: amend the existing client's
  allowlist via the `updateClientAllowedAgents` GraphQL mutation (e.g. to
  `["openclaw-a", "openclaw-b", ...]`) and run one `vicoop-client` per id.
  No token rotation needed.
- **Different backends**: in the published bundle today, pass
  `--backend openclaw`, `--backend claude`, `--backend codex`, or `--backend echo`. Set
  `--card` (or `"card"` in `config.json`) only when you need to override the server's
  canonical card. Custom/future backends are still described in
  `docs/design.md` §5 but are not shipped yet.
- **Audit/revoke access**: the admin agent exposes `list_caller_tokens`,
  `list_callers`, and `revoke_caller_token` tools; see the tool list in
  `packages/server/src/admin.ts`.
