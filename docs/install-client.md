# Install vicoop-bridge-client

Onboarding guide for connecting a local A2A backend (OpenClaw, with `echo`
available for testing) to a deployed vicoop-bridge server. The end state is
a long-running `vicoop-client` process on your host that bridges inbound A2A
traffic at `POST <bridge>/agents/<your-agent-id>` to your local backend.

Additional backends (Claude Code, Codex, ...) are described in
`docs/design.md` §5 but are not in the published client bundle yet —
`packages/client/src/cli.ts` currently only registers `echo` and `openclaw`.

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
- `curl`, `tar`, `jq`, and one of `sha256sum` / `shasum`. (`jq` is used by
  the token-extraction snippets in Steps 2–3.)
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

## Step 1 — Install the client bundle

The one-liner downloads the latest `client-v*` release, verifies its
`.sha256`, and extracts into `$INSTALL_DIR`:

```sh
INSTALL_DIR="$HOME/vicoop-bridge-client" \
  curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh | sh
```

| Env | Default | Purpose |
|---|---|---|
| `INSTALL_DIR` | `/data/vicoop-bridge-client` | Target directory. Pick a writable path on a volume that survives restarts. |
| `VERSION` | latest `client-v*` | Pin a specific tag, e.g. `client-v0.1.1`. |
| `FORCE` | `0` | If `1`, overwrite a non-empty `INSTALL_DIR`. |

What you get after extraction:

```
$INSTALL_DIR/
├── bin/vicoop-client        # node wrapper
├── dist/                    # compiled JS
├── cards/openclaw.json      # example agent card
├── node_modules/            # pruned prod deps
└── package.json
```

The script targets Linux (Fly.io persistent volumes are the original target
deployment); on macOS it prints a warning and proceeds. See #17 / #21 for
background.

`install.sh` prints next-step instructions, but parts of that output are
outdated and should be ignored in favor of Steps 2-3 below:

- It references `$INSTALL_DIR/card.json` as the card path — the bundle does
  not ship that file; it ships `cards/openclaw.json` as a starting
  template. This doc points `--card` (and `AGENT_CARD`) at the shipped
  template directly; if you'd rather keep the printed path, copy the
  template to `$INSTALL_DIR/card.json` first.
- It suggests obtaining a token via a `register_client` tool on the admin
  agent. Today the flow goes through the PostGraphile-exposed
  `registerClient` GraphQL mutation (Step 3), gated by a SIWE caller token
  (Step 2). The admin A2A agent itself does not carry a
  `register_client` tool with that name.

## Step 2 — Obtain a caller token (SIWE)

A caller token (`vbc_caller_*`) is the opaque session token you present to
the bridge's admin endpoints. It is minted by signing a SIWE message at
`POST /auth/siwe/exchange` (see `packages/server/src/auth/siwe-exchange.ts`
for the exchange, `schema.sql` `used_siwe_nonces` for single-use-nonce
enforcement). TTL equals the SIWE `expirationTime`, capped at 7 days.

### Using `a2a-wallet`

```sh
export BRIDGE_URL=https://vicoop-bridge-server.fly.dev

# Generate, sign, and encode a SIWE token in one step with your local wallet.
TOKEN=$(a2a-wallet siwe auth \
  --wallet <wallet-name> \
  --domain "${BRIDGE_URL#https://}" \
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

Even with the probe, prefer names unlikely to collide across operators:

```sh
AGENT_ID="openclaw-$(hostname | cut -d. -f1)"
AGENT_ID="openclaw-$(printf '%s' "${WALLET#0x}" | cut -c1-6)"   # first 6 hex chars of your EOA
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

The bundle ships `$INSTALL_DIR/cards/openclaw.json` as a starting template.
Agent cards are published at `GET <bridge>/agents/<agent_id>/.well-known/agent-card.json`
and describe what callers can expect. At minimum you usually want to:

- Rename `name` to something meaningful (it defaults to `openclaw`).
- Tighten `description` to what this specific instance actually does.
- Adjust `skills[]` if you've customized the backend.

Schema reference: `packages/protocol/src/index.ts` (`AgentCard` Zod schema,
validated by the client at startup — invalid cards exit with a Zod error).

For other backends, write a fresh card:

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
SERVER_URL="wss://${BRIDGE_URL#https://}" \
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

### macOS — `launchd`

Create `~/Library/LaunchAgents/com.local.vicoop-client.plist` with
`KeepAlive=true`, point `ProgramArguments` at
`$INSTALL_DIR/bin/vicoop-client`, and put your env into
`EnvironmentVariables`. Load with `launchctl load -w <plist>`.

### Linux — systemd user unit

```ini
# ~/.config/systemd/user/vicoop-client.service
[Unit]
Description=vicoop-bridge-client
After=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/vicoop-client.env
ExecStart=%h/vicoop-bridge-client/bin/vicoop-client
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
```

Put `SERVER_URL=...`, `SERVER_TOKEN=...`, etc. in
`~/.config/vicoop-client.env` (mode `0600`), then
`systemctl --user enable --now vicoop-client`.

### Tmux (interactive hosts)

```sh
tmux new -d -s vbc 'sh -c "set -a; . \"$HOME/.config/vicoop-client.env\"; set +a; exec \"$INSTALL_DIR/bin/vicoop-client\""'
tmux attach -t vbc   # to watch logs
```

Using `set -a` + `.` keeps secrets out of the process-listing line and
tolerates quoted values / comment lines in the env file, which the
`env $(xargs)` pattern does not.

Automatic restart on crash is tracked in #18.

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

- **Lost the `CLIENT_TOKEN`** — it's unrecoverable. Re-run Step 3 to issue
  a new one. The old `clients` row (and any cascading `agent_policies`)
  can be cleaned up via the admin agent's CRUD mutations (#29).

## What's next

- **Bind more agents to the same token**: amend the existing client's
  allowlist via the `updateClientAllowedAgents` GraphQL mutation (e.g. to
  `["openclaw-a", "openclaw-b", ...]`) and run one `vicoop-client` per id.
  No token rotation needed.
- **Different backends**: in the published bundle today, pass
  `--backend openclaw` or `--backend echo` with a matching card.
  `claude-cli` / `codex` are described in `docs/design.md` §5 but are not
  shipped yet.
- **Audit/revoke access**: the admin agent exposes `list_caller_tokens`,
  `list_callers`, and `revoke_caller_token` tools; see the tool list in
  `packages/server/src/admin.ts`.
