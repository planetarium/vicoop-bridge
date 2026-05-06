# Install vicoop-bridge-client

Onboarding guide for connecting a local A2A backend (OpenClaw, Claude Code,
with `echo` available for testing) to a deployed vicoop-bridge server. The
first target is a verified foreground `vicoop-client` process on your host
that bridges inbound A2A traffic at `POST <bridge>/agents/<your-agent-id>` to
your local backend. Persistent service setup is optional once the foreground
run works.

Additional backends (Codex, ...) are described in `docs/design.md` §5 but are
not in the published client bundle yet. The released client currently
registers `echo`, `openclaw`, and `claude`.

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
| `INSTALL_SKIP_SERVICE` | `0` | If `1`, skip the optional systemd unit + env template even on systemd hosts. |
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
fails with the daemon usage (`--server`, `--token`, `--agentId`, `--card`)
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

`registerClient` (called for you by `vicoop-client login` in Step 4) does
not pre-validate availability; collisions surface only at WS connect time.
If you want to probe ahead, hit `agentIdAvailable(agentId)` GraphQL after
login — it's a SECURITY DEFINER probe that returns boolean availability
across every owner without leaking `owner_principal`. Most operators just
pick a hostname/uuid prefix and skip the probe.

## Step 4 — Login and register your client (device flow)

`vicoop-client login` drives Google OAuth device flow against the bridge
to register a fresh client and hand you a one-time `CLIENT_TOKEN`. No
wallet, no SIWE, no GraphQL calls.

```sh
HOSTNAME=$(hostname)
CLIENT_NAME="openclaw on ${HOSTNAME%%.*}"

"$INSTALL_DIR/bin/vicoop-client" login \
  --bridge "$BRIDGE_URL" \
  --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" \
  --write-env-file "$INSTALL_DIR/vicoop-client.env"
```

The CLI prints a verification URL to stderr — open it in **any** browser
(the same machine, or your laptop while running the CLI on a headless
host) and authorize with your Google account. The CLI polls the bridge in
the background and writes the resulting env block to
`vicoop-client.env` (mode 600) on success:

```text
SERVER_URL=wss://vicoop-bridge-server.fly.dev
SERVER_TOKEN=<64-hex CLIENT_TOKEN — shown ONLY here>
AGENT_ID=<your agent id>
```

> ⚠ The `CLIENT_TOKEN` is unrecoverable after this single output. The env
> file is the only place it persists; back it up if you need to rotate
> hosts. To rotate the token later, use the `rotateClientToken` GraphQL
> mutation (requires a fresh `vbc_owner_*` session token from
> `/auth/siwe/exchange?intent=owner_session` or device flow with
> `intent=owner_session` — the rotation surfaces a new CLIENT_TOKEN, also
> one-time).

Drop `--write-env-file` and pass `--json` instead if you want to compose
with shell tooling:

```sh
"$INSTALL_DIR/bin/vicoop-client" login \
  --bridge "$BRIDGE_URL" --client-name "$CLIENT_NAME" \
  --agent-ids "$AGENT_ID" --json \
  | tee /tmp/vicoop-login.json
CLIENT_TOKEN=$(jq -r .client_token /tmp/vicoop-login.json)
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

### What login does on the server

1. `POST /oauth/device/code` with `intent=client_register` + `client_name`
   + `allowed_agent_ids` — the bridge stores these on a `device_sessions`
   row and returns a one-time `device_code` + 8-char user code.
2. Operator opens the verification URL, signs in with Google, and the
   approval page shows exactly what's being authorized
   ("Register a bridge client `<name>` … with allowed agent ids …").
3. CLI polls `POST /oauth/token`. Once status flips to `approved`, the
   bridge calls `register_client()` on behalf of the Google principal,
   stamps `clients.owner_email` for admin readability, and returns
   `{client_id, client_token, owner_principal, allowed_agent_ids}`.
4. The CLI never sees a `vbc_caller_*` token — `client_register` issues
   the long-lived `CLIENT_TOKEN` directly. No `callers` row is created.

This means a Google-only operator can stand up a bridge client without
ever holding a wallet or seed phrase. Owner is recorded as
`google:sub:<sub>` (stable id, not the email).

## Step 5 — Prepare the agent card

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

## Step 6 — Run the client

Run the client in the foreground first. All flags also accept env vars, so the
file written by Step 4 can be loaded directly:

```sh
. "$INSTALL_DIR/vicoop-client.env"

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

If you're running the Claude backend, point the client at the bundled
Claude card and optionally set `CLAUDE_CWD` so Claude works against a
different repository than the directory where `vicoop-client` itself was
started:

```sh
SERVER_URL="$SERVER_URL" \
SERVER_TOKEN="$CLIENT_TOKEN" \
AGENT_ID="$AGENT_ID" \
AGENT_CARD="$INSTALL_DIR/cards/claude.json" \
BACKEND=claude \
CLAUDE_CWD="$HOME/vicoop-bridge" \
  "$INSTALL_DIR/bin/vicoop-client"
```

If you used `--write-env-file` in Step 4, load it first and omit the
already-populated `SERVER_URL`, `SERVER_TOKEN`, and `AGENT_ID` assignments:

```sh
. "$INSTALL_DIR/vicoop-client.env"

AGENT_CARD="$INSTALL_DIR/cards/claude.json" \
BACKEND=claude \
CLAUDE_CWD="$HOME/vicoop-bridge" \
  "$INSTALL_DIR/bin/vicoop-client"
```

`CLAUDE_CWD` defaults to the current working directory of the client
process. Set it when the released bundle lives outside the repository you
want Claude to edit.

## Optional: persistence

Only set up persistence after the foreground run connects and the agent
endpoint responds. For local Claude/OpenClaw onboarding, a foreground process
is often enough for first success.

On systemd hosts where `install.sh` wrote a unit, update the generated env
file with the same values used for the foreground run:

```sh
AGENT_CARD="$INSTALL_DIR/cards/openclaw.json"
BACKEND=openclaw
```

Then reload and start the service using the exact commands printed by the
installer, for example:

```sh
systemctl --user daemon-reload
systemctl --user enable --now vicoop-client
```

For macOS or ad hoc local testing, use the foreground command above or your
normal process supervisor. The bridge does not require systemd; it only needs
one live `vicoop-client` process connected for the agent id.

### Restrict who can call your agent

By default the policy has empty `allowed_callers`, which the dispatcher
treats as "public". To lock it down, use the admin agent's `add_caller`
tool. The admin agent at `POST /` accepts any **owner-session token**
(`vbc_owner_*`) — wallet (SIWE) or Google (device flow with
`intent=owner_session`). Admin scope (`is_admin()`) is wallet-only and
gates only the cross-owner tools.

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

The change hot-reloads via `registry.updateAllowedCallers` — no client
restart needed.

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
  `--backend openclaw`, `--backend claude`, or `--backend echo` with a
  matching card. Codex and other future backends are still described in
  `docs/design.md` §5 but are not shipped yet.
- **Audit/revoke access**: the admin agent exposes `list_caller_tokens`,
  `list_callers`, and `revoke_caller_token` tools; see the tool list in
  `packages/server/src/admin.ts`.
