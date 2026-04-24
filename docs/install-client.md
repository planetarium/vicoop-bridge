# Install vicoop-bridge-client

Onboarding guide for connecting a local A2A backend (OpenClaw, Claude Code,
with `echo` available for testing) to a deployed vicoop-bridge server. The
end state is a long-running `vicoop-client` process on your host that bridges
inbound A2A traffic at `POST <bridge>/agents/<your-agent-id>` to your local
backend.

The published client bundle currently ships `echo`, `openclaw`, and
`claude` backends. Codex and other future backends are still described in
`docs/design.md` §5 as design targets rather than released bundle features.

This doc covers the **post-release install path** (the `install.sh`
one-liner fetching a published `client-v*` bundle). Contrast with:

- [`local-testing.md`](./local-testing.md) — running both bridge and client
  from source against a local Postgres, using `psql` for setup.
- [`remote-testing.md`](./remote-testing.md) — end-to-end verification of a
  deployed bridge using the echo backend. Covers the raw-curl SIWE path
  that the "alternative" sections here link to.

## Audience

- A human operator (or an agent acting on their behalf) standing up a
  brand-new client that will connect to a bridge they do not operate.
- The operator has an Ethereum EOA they control; that wallet becomes the
  owner of the resulting agent policy and must sign SIWE to obtain tokens.

## Prerequisites

- Node.js 20 or newer (`node -v`).
- `curl`, `tar`, `jq`, `base64` (usually part of `coreutils` / `busybox`),
  and one of `sha256sum` / `shasum`. `jq` is used by the token-extraction
  snippets in Steps 2–3; `base64` is used for the SIWE-token decode in
  Step 2.
- A reachable bridge URL. The public deployment is
  `https://vicoop-bridge-server.fly.dev`; substitute your own below if you
  run the server yourself.
- An operator EOA. Either:
  - [`a2a-wallet`](https://github.com/planetarium/a2a-x402-wallet) CLI with a
    local wallet imported — this is the shortest path, used throughout.
  - Or the raw-curl path from `remote-testing.md` §1-2 if you prefer
    scripting SIWE yourself.
- For the OpenClaw backend specifically: an OpenClaw gateway running
  locally at `ws://127.0.0.1:18789` (override via `OPENCLAW_GATEWAY_URL`).
- For the Claude backend specifically: the local `claude` CLI installed and
  authenticated (`claude --version` should succeed).

## Step 1 — Install the client bundle

The one-liner downloads the latest `client-v*` release, verifies its
`.sha256`, and extracts into `$INSTALL_DIR`:

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
| `VERSION` | latest `client-v*` | Pin a specific tag, e.g. `client-v0.1.1`. |
| `FORCE` | `0` | If `1`, overwrite a non-empty `INSTALL_DIR`. |
| `INSTALL_SKIP_SERVICE` | `0` | If `1`, skip the systemd unit + env template even on systemd hosts. |
| `INSTALL_SERVICE_SCOPE` | `auto` | Force `user`, `system`, or `none` instead of auto-detecting by `id -u`. `system` requires root; an explicit `system` without root is refused with a warning. |

What you get after extraction:

```
$INSTALL_DIR/
├── bin/vicoop-client        # bash wrapper that execs node dist/cli.js
├── dist/                    # compiled JS
├── cards/openclaw.json      # OpenClaw example card
├── cards/claude.json        # Claude Code example card
├── cards/echo.json          # Echo test card
├── node_modules/            # pruned prod deps
└── package.json
```

The script targets Linux (Fly.io persistent volumes are the original target
deployment); on macOS it prints a warning and proceeds. See #17 / #21 for
background.

When systemd is the host init, `install.sh` also writes a
`vicoop-client.service` unit plus a `vicoop-client.env` template (scope
auto-detected: `system` as root, `user` otherwise). It does not enable or
start the service — env values are populated by Steps 2-4 below, and the
operator runs the `systemctl enable --now` command from the installer's
output once they're filled in. Opt out with `INSTALL_SKIP_SERVICE=1`, or
force a scope with `INSTALL_SERVICE_SCOPE=user|system|none`.

## Step 2 — Obtain a caller token (SIWE)

A caller token (`vbc_caller_*`) is the opaque session token you present to
the bridge's admin endpoints. It is minted by signing a SIWE message at
`POST /auth/siwe/exchange` (see `packages/server/src/auth/siwe-exchange.ts`
for the exchange, `schema.sql` `used_siwe_nonces` for single-use-nonce
enforcement). TTL equals the SIWE `expirationTime`, capped at 7 days.

### Using `a2a-wallet`

```sh
export BRIDGE_URL=https://vicoop-bridge-server.fly.dev

# The server compares the SIWE `domain` field against PUBLIC_URL's hostname
# exactly, so derive the bare hostname via URL parsing — a naïve
# ${BRIDGE_URL#https://} breaks on http:// or trailing paths/slashes.
BRIDGE_HOSTNAME=$(BRIDGE_URL="$BRIDGE_URL" node -p 'new URL(process.env.BRIDGE_URL).hostname')

# Generate, sign, and encode a SIWE token in one step with your local wallet.
TOKEN=$(a2a-wallet siwe auth \
  --wallet <wallet-name> \
  --domain "$BRIDGE_HOSTNAME" \
  --uri "$BRIDGE_URL" \
  --ttl 1h \
  --json | jq -r .token)

# The CLI's token is base64url(JSON({message, signature})). Decode and pipe
# the {message, signature} JSON straight into the exchange endpoint — never
# write the signed payload to disk where another local user could read it
# off /tmp before we delete it. GNU base64 uses -d, BSD/macOS uses -D.
PAD=$(printf '%*s' $(( (4 - ${#TOKEN} % 4) % 4 )) '' | tr ' ' '=')
if printf '' | base64 -d >/dev/null 2>&1; then B64DEC='base64 -d'; else B64DEC='base64 -D'; fi

CALLER_TOKEN=$(echo "${TOKEN}${PAD}" | tr '_-' '/+' | $B64DEC \
  | curl -sX POST "$BRIDGE_URL/auth/siwe/exchange" \
      -H 'Content-Type: application/json' --data-binary @- \
  | jq -r .access_token)

echo "$CALLER_TOKEN"  # vbc_caller_...
```

Replace `<wallet-name>` with the label from `a2a-wallet wallet list`. The
default wallet is used if you omit `--wallet`.

The `a2a-wallet siwe` subcommand is marked deprecated (its tokens are
CLI-wallet-scoped and not shareable with a Web UI) but is the correct tool
here — the bridge's exchange endpoint explicitly wants a wallet-signed
SIWE message.

### Alternative: raw curl

If you'd rather not depend on `a2a-wallet`, follow
[`remote-testing.md` §1 (SIWE exchange)](./remote-testing.md) — it builds
the SIWE message in Node with `viem` + `siwe` and POSTs to the same
endpoint. The resulting `CALLER_TOKEN` is interchangeable with the one
produced above.

## Step 3 — Register the client

Call the `registerClient` GraphQL mutation with your caller token. This
creates a `clients` row scoped to your wallet and issues a raw
`CLIENT_TOKEN` (64-hex). **Save it immediately — it is unrecoverable.**

```sh
AGENT_ID=openclaw-local     # see "Choosing an agent_id" below
HOSTNAME=$(hostname)
CLIENT_NAME="openclaw on ${HOSTNAME%%.*}"

REG=$(curl -sX POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation{registerClient(input:{clientName:\\\"$CLIENT_NAME\\\",allowedAgentIds:[\\\"$AGENT_ID\\\"]}){clientWithToken{id token ownerWallet allowedAgentIds}}}\"}")

echo "$REG" | jq .
CLIENT_TOKEN=$(echo "$REG" | jq -r .data.registerClient.clientWithToken.token)
```

`allowedAgentIds` is a whitelist — the client may only register as one of
these agent IDs at WS connect time. Include every ID you plan to run under
this single token if you know them up front; you can also amend the
allowlist later via the `updateClientAllowedAgents` GraphQL mutation
(backed by `update_client_allowed_agents()` in `schema.sql`) without
issuing a new token. Re-registration is only required if you intentionally
want a new client with a fresh token.

### Choosing an agent_id

Before calling `registerClient`, probe the id with the
`agentIdAvailable(agentId)` GraphQL query. It's a `SECURITY DEFINER`
function (`packages/server/schema.sql`) that returns a plain boolean
across every owner — no `owner_wallet` leaks — and raises
`invalid_parameter_value` on empty input. Requires your caller token.

```sh
AGENT_ID=openclaw-local    # or one of the patterns below

AVAILABLE=$(curl -sX POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"query\":\"{agentIdAvailable(agentId:\\\"$AGENT_ID\\\")}\"}" \
  | jq -r .data.agentIdAvailable)
[ "$AVAILABLE" = "true" ] || { echo "agent_id '$AGENT_ID' is taken"; exit 1; }
```

`true` means no `agent_policies` row exists for that id yet, so your first
WS register in Step 5 will claim ownership. `false` means another wallet
already owns it — pick a different id. A small race window exists between
this probe and your WS register; if another wallet claims the id in
between, Step 5 emits `'agent id owned by a different wallet'` and you can
fall back to the recovery path in "Troubleshooting".

Even with the probe, prefer names unlikely to collide across operators.
Pick one:

```sh
# By hostname
AGENT_ID="openclaw-$(hostname | cut -d. -f1)"

# By wallet prefix — derive WALLET from a2a-wallet status (same format used
# later for add_caller); strip the 0x and take the first 6 hex chars
WALLET=$(a2a-wallet status | awk '/Address/{print tolower($2)}')
AGENT_ID="openclaw-$(printf '%s' "${WALLET#0x}" | cut -c1-6)"

# Random
AGENT_ID="$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-8)-openclaw"
```

On reinstalls, `agentIdAvailable` reports `false` for an id you yourself
already registered. To distinguish "mine" from "somebody else's", also
query `agentPolicyByAgentId` — RLS returns a non-null row only when *you*
are the owner:

```sh
curl -sX POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"query\":\"{agentPolicyByAgentId(agentId:\\\"$AGENT_ID\\\"){agentId ownerWallet}}\"}" | jq .
```

A non-null response means you own it and a reinstall will reuse the
existing policy; null after `agentIdAvailable=false` means someone else
owns it.

## Step 4 — Prepare the agent card

The bundle ships backend-specific starter cards under `$INSTALL_DIR/cards/`
(`openclaw.json`, `claude.json`, `echo.json`). Agent cards are published at
`GET <bridge>/agents/<agent_id>/.well-known/agent-card.json` and describe
what callers can expect. At minimum you usually want to:

- Rename `name` to something meaningful (it defaults to `openclaw`).
- Tighten `description` to what this specific instance actually does.
- Adjust `skills[]` if you've customized the backend.

Schema reference: `packages/protocol/src/index.ts` (`AgentCard` Zod schema,
validated by the client at startup — invalid cards exit with a Zod error).

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

## Step 5 — Run the client

All flags also accept env vars, which is usually cleaner for long-running
services:

```sh
# The client appends /connect to SERVER_URL, so it must be a bare origin
# (scheme+host+port only, no path). Derive via URL parsing and map the
# scheme to its WS counterpart.
SERVER_URL=$(BRIDGE_URL="$BRIDGE_URL" node -p '
  const u = new URL(process.env.BRIDGE_URL);
  (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host
')

SERVER_URL="$SERVER_URL" \
SERVER_TOKEN="$CLIENT_TOKEN" \
AGENT_ID="$AGENT_ID" \
AGENT_CARD="$INSTALL_DIR/cards/openclaw.json" \
BACKEND=openclaw \
  "$INSTALL_DIR/bin/vicoop-client"
```

On success you'll see a `[client] connected, sending hello` log. After that:

- The bridge auto-creates an `agent_policies` row owned by your wallet with
  empty `allowed_callers` — meaning **publicly callable** until you restrict it.
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

The Claude backend shells out to the local `claude` binary once per task and
uses the bundled `cards/claude.json` as the default agent card:

```sh
SERVER_URL="$SERVER_URL" \
SERVER_TOKEN="$CLIENT_TOKEN" \
AGENT_ID="$AGENT_ID" \
AGENT_CARD="$INSTALL_DIR/cards/claude.json" \
BACKEND=claude \
  "$INSTALL_DIR/bin/vicoop-client"
```

Requirements:

- `claude` must be present on `PATH`
- the local Claude CLI session must already be authenticated

The current backend does not require extra env vars beyond the standard
client settings above.

### Restrict who can call your agent

By default the policy has empty `allowed_callers`, which the dispatcher
treats as "public". To lock it down, use the admin agent's `add_caller`
tool — this is the same flow as
[`remote-testing.md` §5](./remote-testing.md). Example for gating to your
own wallet only:

```sh
WALLET_PRINCIPAL="eth:$(a2a-wallet status | awk '/Address/{print tolower($2)}')"

curl -sX POST "$BRIDGE_URL/" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"messageId\":\"ac\",\"role\":\"user\",\"kind\":\"message\",\"parts\":[{\"kind\":\"text\",\"text\":\"Use add_caller to add '${WALLET_PRINCIPAL}' to agent '${AGENT_ID}'.\"}]}}}" \
  | jq -r '.result.status.message.parts[0].text'
```

The change hot-reloads via `registry.updateAllowedCallers` — no client
restart needed.

## Step 6 — Run persistently

`vicoop-client` does not daemonize. Pick whichever supervisor fits your host.

### Linux — systemd (automatic, recommended)

On systemd hosts `install.sh` already dropped the unit and an env template
(see Step 1). The exact paths and the reload/enable commands are printed
at the end of `install.sh` — prefer those over the examples below if they
differ (`XDG_CONFIG_HOME`, non-default `$HOME`, etc.). You can also ask
systemd directly with `systemctl --user cat vicoop-client`.

```sh
# user-scope (default for non-root). If XDG_CONFIG_HOME is set, swap in
# that prefix for ~/.config/ below.
"${EDITOR:-vi}" "${XDG_CONFIG_HOME:-$HOME/.config}/vicoop-client.env"
systemctl --user daemon-reload                # pick up regenerated unit after reinstall
systemctl --user enable --now vicoop-client
journalctl --user -u vicoop-client -f         # watch logs
```

For a system-scope install (installer ran as root) swap to
`/etc/vicoop-client.env`, then reload + enable. On minimal images where
the installer ran as root and `sudo` may not exist, drop the `sudo`
prefix:

```sh
# already root (minimal images, Fly.io containers)
systemctl daemon-reload
systemctl enable --now vicoop-client

# non-root operator with sudo
sudo systemctl daemon-reload
sudo systemctl enable --now vicoop-client
```

The unit restarts on failure (`Restart=on-failure`, 5s backoff).

The `daemon-reload` is only strictly needed after a reinstall/upgrade that
rewrote the unit file (new `INSTALL_DIR`, new absolute node path, new
`VERSION`); first-time installs can skip it. It never hurts to run.

**Headless hosts / user scope**: the user-scope manager is tied to your
login session by default, so the client stops when you log out. For true
24/7 operation either enable lingering:

```sh
sudo loginctl enable-linger "$USER"
```

or rerun the installer as root with `INSTALL_SERVICE_SCOPE=system` to get
a system-wide unit instead.

### macOS — `launchd`

Create `~/Library/LaunchAgents/com.local.vicoop-client.plist` with
`KeepAlive=true`, point `ProgramArguments` at
`$INSTALL_DIR/bin/vicoop-client`, and put your env into
`EnvironmentVariables`. Load with `launchctl load -w <plist>`.

### Linux — systemd user unit (manual)

If you ran `install.sh` with `INSTALL_SKIP_SERVICE=1` or the scope
auto-detection skipped (non-systemd host), write the unit yourself:

```ini
# ~/.config/systemd/user/vicoop-client.service
[Unit]
Description=vicoop-bridge-client
# network-online.target is a system-instance unit; the user manager does
# not know about it, so intentionally omit the After=/Wants= line here.

[Service]
Type=simple
EnvironmentFile=%h/.config/vicoop-client.env
ExecStart=%h/vicoop-bridge-client/bin/vicoop-client
Restart=on-failure
RestartSec=5s
NoNewPrivileges=yes

[Install]
WantedBy=default.target
```

Put `SERVER_URL=...`, `SERVER_TOKEN=...`, etc. in
`~/.config/vicoop-client.env` (mode `0600`), then
`systemctl --user enable --now vicoop-client`.

### Tmux (interactive hosts)

```sh
# Swap the hardcoded path if you installed elsewhere. The inner sh is
# spawned fresh by tmux, so don't rely on $INSTALL_DIR being exported here.
tmux new -d -s vbc 'sh -c "set -a; . \"$HOME/.config/vicoop-client.env\"; set +a; exec \"$HOME/vicoop-bridge-client/bin/vicoop-client\""'
tmux attach -t vbc   # to watch logs
```

Using `set -a` + `.` keeps secrets out of the process-listing line and
tolerates quoted values / comment lines in the env file, which the
`env $(xargs)` pattern does not.

## Updating the client

Once installed, the client updates itself — do not re-run `install.sh`. The
installer's `FORCE=1` path is destructive (it `rm -rf`s `$INSTALL_DIR` and
wipes any operator-added cards / files), so it's reserved for bootstrapping.

```sh
"$INSTALL_DIR/bin/vicoop-client" upgrade --check      # report latest vs current
"$INSTALL_DIR/bin/vicoop-client" upgrade              # upgrade to latest client-v*
"$INSTALL_DIR/bin/vicoop-client" upgrade --version client-v0.2.0   # pin / downgrade
"$INSTALL_DIR/bin/vicoop-client" upgrade --force      # reinstall the resolved target even if already on it
```

The upgrade command:

1. Queries GitHub releases for the latest `client-v*` tag (or the `--version`
   you pin).
2. Downloads `.tgz` + `.sha256` to a temp directory and verifies the checksum.
3. Extracts into `$INSTALL_DIR.new/` (sibling of the current install).
4. Copies operator files that don't ship with the bundle — notably any
   `cards/*.json` you added or files placed directly under `$INSTALL_DIR`.
   Shipped cards (`openclaw.json`, `echo.json`, `claude.json`) are always
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

**`/etc/vicoop-client.env` and the systemd unit file are not touched.** Those
belong to `install.sh`; if a release ever changes the unit layout, re-run
`install.sh` once to refresh the scaffolding. Note that `FORCE=1` deletes
everything under `$INSTALL_DIR` first — back up any operator-added cards or
files before running it.

## Troubleshooting

- **`agent id owned by a different wallet`** (WS register) — your wallet is
  not the `owner_wallet` on the existing `agent_policies` row. Pick a
  different `agent_id`, amend the existing client's allowlist via
  `updateClientAllowedAgents` (no token rotation), and restart
  `vicoop-client` with the new `AGENT_ID`. Re-run Step 3 only if you
  intentionally want a new client/token; otherwise sign in from the
  original owner's wallet.

- **`permission denied for function register_client`** (or similar) on
  GraphQL — the caller token was missing, malformed, or expired, so the
  request fell back to the `app_anonymous` Postgres role (see
  `packages/server/src/postgraphile.ts`) which has no EXECUTE on
  authenticated functions. Send a valid `Bearer vbc_caller_*` token; if
  expired, re-run Step 2 to refresh via the SIWE exchange. SIWE nonces are
  single-use, so every exchange needs a freshly signed message.

- **`SIWE message has already expired`** — the `expirationTime` was in the
  past when the bridge verified it. Increase `--ttl` or check host clock
  skew.

- **Client reconnects but `/agents/:id` returns 404** — the
  `agent_policies` row exists but no WS session is live. Check the client
  log; the row is re-used on reconnect but dispatch requires an active
  session.

- **Lost the `CLIENT_TOKEN`** — the raw value is unrecoverable, but you
  don't need to create a new client identity. Rotate the token in place
  via the `rotateClientToken` GraphQL mutation (backed by
  `rotate_client_token()` in `schema.sql`): it mints a fresh raw token for
  the existing `clients` row and invalidates the old hash, so your
  `allowedAgentIds` and `agent_policies` carry over. Re-run Step 3 only if
  you intentionally want a new client identity; in that case the old
  `clients` row (and cascading `agent_policies`) can be cleaned up via
  the admin agent's CRUD mutations (#29).

## What's next

- **Bind more agents to the same token**: amend the existing client's
  allowlist via the `updateClientAllowedAgents` GraphQL mutation (e.g. to
  `["openclaw-a", "openclaw-b", ...]`) and run one `vicoop-client` per id.
  No token rotation needed.
- **Different backends**: in the published bundle today, pass
  `--backend openclaw`, `--backend claude`, or `--backend echo` with a
  matching card. Codex and other future backends are still described in
  `docs/design.md` §5 but are not shipped yet.
- **Audit/revoke access**: the admin agent exposes `list_caller_tokens`,
  `list_callers`, and `revoke_caller_token` tools; see the tool list in
  `packages/server/src/admin.ts`.
