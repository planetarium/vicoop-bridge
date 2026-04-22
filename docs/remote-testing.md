# Remote E2E testing

Walkthrough for exercising the A2A caller auth paths end-to-end against a
**deployed** bridge (e.g. `https://vicoop-bridge-server.fly.dev`) from a local
workstation, using only public HTTP and the admin agent — **no direct DB
access** and **no admin wallet** required.

This is the shortest path and matches the intended production flow:

1. Sign SIWE with any EOA → exchange for an opaque caller token
2. Register a client via the public GraphQL mutation → receive a raw client token
3. Run a local echo backend connected over WSS
4. Grant your wallet on the auto-created agent policy via `add_caller` (admin
   agent, RLS-owner-gated, not admin-only)
5. Dispatch to `/agents/:id` with the same opaque token

Contrast with [`local-testing.md`](./local-testing.md): that doc runs both
server and client locally and uses `psql` to write `clients` /
`agent_policies`. This doc does neither, and the flow exercised here mirrors
what a real integrator would do against a production bridge.

## Prerequisites

- Node 20+, pnpm 9
- This repo checked out locally (for running the echo client)
- A throwaway EOA private key — the example uses Anvil account #0, which has
  no mainnet balance and is safe to paste into scripts
- A reachable bridge URL served over HTTPS with:
  - server-side `DATABASE_URL`, `PUBLIC_URL`
  - `ANTHROPIC_API_KEY` (the admin agent routes via Claude to reach tools)

You do **not** need your wallet in `ADMIN_WALLET_ADDRESSES`. Every step below
works for non-admin callers:

- `register_client()` defaults `owner_wallet` to the caller's SIWE address
  (explicit `ownerWallet` is admin-only, but the default is what we want).
- `agent_policies_update` RLS is `owner OR is_admin`, and the auto-created
  policy's owner is your wallet.
- The admin agent at `POST /` gates only on "caller token has `eth:*`
  principal", not on admin membership.

## Env

```bash
export BRIDGE_URL="https://vicoop-bridge-server.fly.dev"
export BRIDGE_WS_URL="wss://vicoop-bridge-server.fly.dev"
# Must match the server's PUBLIC_URL hostname — the exchange endpoint enforces
# domain match against siweDomain derived from PUBLIC_URL. Mismatch → 401
# invalid_grant on exchange.
export SIWE_DOMAIN="vicoop-bridge-server.fly.dev"
export SIWE_URI="$BRIDGE_URL"
```

## One-time setup

```bash
pnpm install --filter @vicoop-bridge/client... --filter @vicoop-bridge/admin-ui...
pnpm --filter @vicoop-bridge/protocol build
```

The client workspace imports `@vicoop-bridge/protocol` as a compiled package,
so the protocol must be built once.

## Step 1 — SIWE exchange

```bash
cat > packages/admin-ui/gen-siwe.mjs <<'JS'
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';

const DOMAIN = process.env.SIWE_DOMAIN ?? 'localhost';
const URI = process.env.SIWE_URI ?? 'http://localhost:8787';
// Anvil account #0 — public test key, DO NOT use for anything real.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const account = privateKeyToAccount(PRIVATE_KEY);
console.error(`# wallet: ${account.address}`);
const nonce = crypto.randomUUID().replace(/-/g, '');
const msg = new SiweMessage({
  domain: DOMAIN,
  address: account.address,
  statement: 'Remote e2e test',
  uri: URI,
  version: '1',
  chainId: 1,
  nonce,
  issuedAt: new Date().toISOString(),
  expirationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});
const message = msg.prepareMessage();
const signature = await account.signMessage({ message });
console.log(JSON.stringify({ message, signature }));
JS

(cd packages/admin-ui && node gen-siwe.mjs) > /tmp/siwe.json
# stderr prints the wallet: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (Anvil #0)

CALLER_TOKEN=$(curl -sX POST "$BRIDGE_URL/auth/siwe/exchange" \
  -H 'Content-Type: application/json' \
  --data @/tmp/siwe.json | jq -r .access_token)
echo "$CALLER_TOKEN"
# vbc_caller_...  (valid ~60 min)
```

If you change the EOA, remember to update the wallet address used in Step 5.

## Step 2 — Register a client

```bash
AGENT_ID="echo-e2e-$(date +%s)"   # avoid collisions with other tenants
echo "agent_id=$AGENT_ID"

REG=$(curl -s -X POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation{registerClient(input:{clientName:\\\"e2e-${AGENT_ID}\\\",allowedAgentIds:[\\\"${AGENT_ID}\\\"]}){clientWithToken{id token}}}\"}")
CLIENT_ID=$(echo "$REG" | jq -r .data.registerClient.clientWithToken.id)
CLIENT_TOKEN=$(echo "$REG" | jq -r .data.registerClient.clientWithToken.token)
echo "client_id=$CLIENT_ID"
echo "client_token=$CLIENT_TOKEN"   # raw 64-hex token — record it, never retrievable again
```

Owner defaults to your SIWE wallet. `ownerWallet` can be passed explicitly,
but only admins may actually override it; non-admin attempts are silently
replaced with the caller's own wallet (`register_client` in `schema.sql`).

## Step 3 — Run the echo client against WSS

```bash
cat > /tmp/echo-card.json <<'JSON'
{
  "name": "echo",
  "description": "Echo backend for e2e testing",
  "version": "0.0.1",
  "protocolVersion": "0.3.0",
  "capabilities": { "streaming": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{ "id": "echo", "name": "echo", "description": "Echo back", "tags": ["echo"] }]
}
JSON

(cd packages/client && ../../node_modules/.bin/tsx src/cli.ts \
  --server "$BRIDGE_WS_URL" \
  --token "$CLIENT_TOKEN" \
  --agentId "$AGENT_ID" \
  --card /tmp/echo-card.json \
  --backend echo) &
# logs: [client] connected, sending hello
```

On WS registration, `agent_policies` auto-inserts a row keyed by `agent_id`
with `owner_wallet=<your wallet>` and empty `allowed_callers` (publicly
callable).

## Step 4 — Public sanity check

```bash
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"m0","role":"user","kind":"message","parts":[{"kind":"text","text":"hello public"}]}}}'
# → 200, artifacts[0].parts[0].text == "echo: hello public"
```

## Step 5 — Restrict with `add_caller`

`POST /` is the admin agent — a Claude-backed A2A endpoint with tools like
`add_caller`, `remove_caller`, `list_agents`, `list_caller_tokens`. It requires
an `eth:*` caller token (not admin membership); tool execution runs under RLS
with your wallet as the authenticated principal, so mutations on agents you
own are authorized.

```bash
WALLET_PRINCIPAL=eth:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266   # lowercase

curl -s -X POST "$BRIDGE_URL/" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"messageId\":\"ac\",\"role\":\"user\",\"kind\":\"message\",\"parts\":[{\"kind\":\"text\",\"text\":\"Use the add_caller tool to add principal '${WALLET_PRINCIPAL}' to agent '${AGENT_ID}'.\"}]}}}" \
  | jq -r '.result.status.message.parts[0].text'
```

Two side effects on success:

1. `UPDATE agent_policies SET allowed_callers = array_append(...)` — RLS
   permits you because you own the policy row.
2. `registry.updateAllowedCallers(agent_id, callers)` — in-memory hot-reload.
   Unlike raw-SQL updates (see `local-testing.md` gotchas), no client restart
   is required.

## Step 6 — Auth matrix

```bash
BODY='{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"m","role":"user","kind":"message","parts":[{"kind":"text","text":"final test"}]}}}'

# no bearer → 401 "Authentication required (Bearer vbc_caller_* token)"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H 'Content-Type: application/json' -d "$BODY"

# wrong bearer → 401 "Caller token not found"
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H 'Authorization: Bearer vbc_caller_WRONG' \
  -H 'Content-Type: application/json' -d "$BODY"

# raw SIWE signature → 401 "expected vbc_caller_* prefix"
SIG=$(jq -r .signature /tmp/siwe.json)
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $SIG" \
  -H 'Content-Type: application/json' -d "$BODY"

# valid opaque token → 200 "echo: final test"
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $CALLER_TOKEN" \
  -H 'Content-Type: application/json' -d "$BODY"
```

## Cleanup

```bash
pkill -f "tsx.*cli.ts.*$AGENT_ID"

curl -s -X POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation{deleteClientById(input:{id:\\\"${CLIENT_ID}\\\"}){deletedClientId}}\"}"
# ON DELETE CASCADE on agent_policies.client_id drops the policy row too.

rm /tmp/siwe.json /tmp/echo-card.json packages/admin-ui/gen-siwe.mjs
```

The `callers` row backing your opaque token expires on its own (default ~60
min from issuance). Self-revoke is not exposed; only `ADMIN_WALLET_ADDRESSES`
callers can invoke `revoke_caller_token`.

## Gotchas

- **`agent_id` collisions** — `agent_policies.agent_id` is PRIMARY KEY. If
  another tenant already claimed your id on the target deployment, the WS
  handshake will fail. Use a suffix unique to you (timestamp, wallet prefix).
- **Admin agent calls burn Claude tokens** — every `POST /` spends the
  server's `ANTHROPIC_API_KEY` budget. Keep admin-agent interactions outside
  hot loops and prefer direct GraphQL for anything exposed there.
- **`SIWE_DOMAIN` must match server's `PUBLIC_URL` hostname** — not the URL
  bar, not the CDN edge host. Mismatch → 401 `invalid_grant`.
- **`ws://` will not upgrade** — Fly forces HTTPS at the edge; use `wss://`
  for `--server`.
- **Caller token verification cache is 60s** — admin-triggered
  `revoke_caller_token` propagates after the window. For an immediate kill
  switch, the server has to be restarted.

## When to use this vs `local-testing.md`

- This doc: validating a deployed bridge, integration-test harness against a
  staging URL, exercising the "real" SIWE → registerClient → add_caller →
  dispatch path exactly as an external integrator would.
- `local-testing.md`: iterating on server code, testing Google device flow
  end-to-end (requires local server because redirect URI points to
  `localhost:8787`), running unit tests that hit the DB directly, or reproducing
  DB-level gotchas (LRU cache, allowed_callers non-hot-reload via raw SQL).
