# Remote E2E testing

Walkthrough for exercising the A2A caller auth paths end-to-end against a
**deployed** bridge (e.g. `https://vicoop-bridge-server.fly.dev`) from a local
workstation, using only public HTTP and the admin agent — **no direct DB
access** and **no admin wallet** required.

This is the shortest path and matches the intended production flow:

1. Sign SIWE with any EOA → exchange for an opaque caller token
2. Register a client via the public GraphQL mutation → receive a raw client token
3. Run a local echo backend connected over WSS
4. Grant a principal on the auto-created agent policy via `add_caller` (admin
   agent, RLS-owner-gated, not admin-only)
5. Dispatch to `/agents/:id` with an opaque token matching that principal

Two dispatch-side variants are covered:

- **Default (eth principal)** — caller uses the SIWE-issued opaque token
  directly. Good for integrators whose callers are wallets.
- **Google-authenticated caller** — principal is `google:email:*` /
  `google:domain:*` / `google:sub:*`; the caller acquires a long-lived opaque
  token via the OAuth device flow and uses that for dispatch. Setup (steps
  1-3) still requires SIWE because `register_client` and `add_caller`
  demand an eth-authenticated session.

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

We run the signing script via stdin from the admin-ui workspace directory
so Node resolves `siwe` / `viem` from its `node_modules` without writing
anything under `packages/`.

```bash
(cd packages/admin-ui && node --input-type=module > /tmp/siwe.json) <<'JS'
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
  // Server TTL = min(7d, expirationTime - now). Change this to extend.
  expirationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});
const message = msg.prepareMessage();
const signature = await account.signMessage({ message });
console.log(JSON.stringify({ message, signature }));
JS
# stderr prints the wallet: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (Anvil #0)

CALLER_TOKEN=$(curl -sX POST "$BRIDGE_URL/auth/siwe/exchange" \
  -H 'Content-Type: application/json' \
  --data @/tmp/siwe.json | jq -r .access_token)
echo "$CALLER_TOKEN"
# vbc_caller_...  (valid ~60 min because the SIWE message sets
# expirationTime to now + 1h; server caps at 7 days)
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
CLIENT_PID=$!
# logs: [client] connected, sending hello
```

`$CLIENT_PID` is the subshell wrapping tsx; killing it signals the child
on every supported platform. We use this in the cleanup step instead of
`pkill -f` to avoid matching unrelated processes that happen to share the
agent-id substring.

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
`add_caller`, `remove_caller`, `list_active_agents`, `list_callers`,
`list_caller_tokens`, `revoke_caller_token`. It requires
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

# wrong bearer → 401 "Invalid bearer token: Caller token not found"
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H 'Authorization: Bearer vbc_caller_WRONG' \
  -H 'Content-Type: application/json' -d "$BODY"

# raw SIWE signature → 401 "Invalid bearer token: expected vbc_caller_* prefix. Acquire one via /auth/siwe/exchange (SIWE) or /oauth/token (device flow)."
SIG=$(jq -r .signature /tmp/siwe.json)
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $SIG" \
  -H 'Content-Type: application/json' -d "$BODY"

# valid opaque token → 200 "echo: final test"
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $CALLER_TOKEN" \
  -H 'Content-Type: application/json' -d "$BODY"
```

## Variant — Google-authenticated callers

For validating that a deployed bridge accepts Google-issued opaque tokens,
replace Steps 5-6 with the variant below. Steps 1-4 (SIWE exchange,
registerClient, echo client) stay identical — Google callers have `google:*`
principals and cannot call `register_client` or modify their own
`agent_policies`, so setup must be done by an eth-authenticated wallet first.

### Step 5a — `add_caller` with a Google principal

```bash
# Choose one:
GOOGLE_PRINCIPAL="google:email:you@company.com"   # matches on verified email equality
# GOOGLE_PRINCIPAL="google:domain:company.com"    # any verified Workspace account at this domain
# GOOGLE_PRINCIPAL="google:sub:123456789"         # stable Google subject id (if known)

curl -s -X POST "$BRIDGE_URL/" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"messageId\":\"acg\",\"role\":\"user\",\"kind\":\"message\",\"parts\":[{\"kind\":\"text\",\"text\":\"Use the add_caller tool to add principal '${GOOGLE_PRINCIPAL}' to agent '${AGENT_ID}'.\"}]}}}" \
  | jq -r '.result.status.message.parts[0].text'
```

Add the caller **before** running the device flow. On device-flow
completion the server persists `principal_id` (`google:<sub>`) and the
verified `email` into the `callers` row; `hostedDomain` is read from the
ID token but not stored. At dispatch, `verifyCallerToken` reads this row
and `matchPrincipal` (see `packages/server/src/auth/principal.ts`) checks
each `allowed_callers` entry against that snapshot — Google is not queried
again:

- `google:sub:<sub>` — exact `principal_id` equality.
- `google:email:<addr>` — case-insensitive equality against the email
  captured at issuance time (which was verified by Google then).
- `google:domain:<d>` — matches when the captured email ends in `@<d>`.
  (The `hd` claim branch in `matchPrincipal` is dead for device-flow
  tokens because `hostedDomain` isn't persisted.)

### Step 5b — Device flow

```bash
DEV=$(curl -sX POST "$BRIDGE_URL/oauth/device/code")
echo "$DEV" | jq
DEVICE_CODE=$(echo "$DEV" | jq -r .device_code)
VERIFY_URL=$(echo "$DEV" | jq -r .verification_uri_complete)
echo "Open in browser: $VERIFY_URL"
```

The user opens `$VERIFY_URL`, signs in with Google, and approves. The
consent-screen page shows `Approved as <email>` on success. Any of these
stops the flow cold:

- account not listed as a test user on the OAuth consent screen (unless the
  app has been fully verified) → `access_denied`
- app is configured for `Internal` user type on a Workspace account → only
  same-workspace accounts can approve; personal Gmail accounts fail
- user_code expired (10 min) → start over

### Step 5c — Poll for the token

`/oauth/token` returns HTTP 400 with `{"error":"authorization_pending"}`
while the user is still on the consent screen, then HTTP 200 with the token
once they approve. Loop until you get an `access_token` or a non-pending
error.

```bash
GOOGLE_TOKEN=""
while :; do
  RESP=$(curl -sX POST "$BRIDGE_URL/oauth/token" \
    -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
    --data-urlencode "device_code=$DEVICE_CODE")
  TOK=$(echo "$RESP" | jq -r '.access_token // empty')
  if [ -n "$TOK" ]; then
    GOOGLE_TOKEN="$TOK"; break
  fi
  ERR=$(echo "$RESP" | jq -r '.error // empty')
  if [ "$ERR" != "authorization_pending" ] && [ "$ERR" != "slow_down" ]; then
    echo "device flow aborted: $RESP" >&2; exit 1
  fi
  sleep 5
done
echo "$GOOGLE_TOKEN"
# vbc_caller_...  (expires_in ≈ 90 days)
```

On approval the response is
`{"access_token":"vbc_caller_...","token_type":"Bearer","expires_in":...}`.
Terminal errors like `access_denied`, `expired_token`, or `invalid_grant`
should stop the loop rather than retry.

### Step 6' — Auth matrix (Google variant)

```bash
BODY='{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"m","role":"user","kind":"message","parts":[{"kind":"text","text":"google test"}]}}}'

# no bearer → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H 'Content-Type: application/json' -d "$BODY"

# SIWE/eth opaque token — 403 "Caller not authorized for this agent"
# Token is valid, but eth:* principal is not in allowed_callers.
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $CALLER_TOKEN" \
  -H 'Content-Type: application/json' -d "$BODY"

# Google-issued token → 200 "echo: google test"
curl -s -X POST "$BRIDGE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $GOOGLE_TOKEN" \
  -H 'Content-Type: application/json' -d "$BODY"
```

The `eth: vs google:` 403 is a useful assertion that the bridge
discriminates provider-scoped principals correctly — a bare "token valid =
access granted" bug would show up here as an unexpected 200.

## Cleanup

```bash
kill "$CLIENT_PID" 2>/dev/null || true

curl -s -X POST "$BRIDGE_URL/graphql" \
  -H "Authorization: Bearer $CALLER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation{deleteClientById(input:{id:\\\"${CLIENT_ID}\\\"}){deletedClientId}}\"}"
# ON DELETE CASCADE on agent_policies.client_id drops the policy row too.

rm /tmp/siwe.json /tmp/echo-card.json
```

The `callers` row backing your opaque token expires on its own. For
SIWE-issued tokens, `expires_in` is inherited from the SIWE message's
`expirationTime` (clamped to a 7-day server maximum, see
`MAX_TOKEN_TTL_MS` in `packages/server/src/siwe-token.ts`); the ~60 min
you saw above comes from the SIWE script setting `expirationTime` to
`now + 1h` — extend that to get a longer token. Self-revoke is not
exposed; only `ADMIN_WALLET_ADDRESSES` callers can invoke
`revoke_caller_token`.

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
- **(Path B) OAuth consent test-user gating** — a just-deployed bridge with a
  non-verified Google OAuth app will reject any approver not listed as a test
  user on the consent screen. Check this before blaming code.
- **(Path B) Workspace-only deployments** — if the OAuth app is configured
  `Internal`, only same-Workspace accounts can complete the flow. Personal
  Gmail accounts fail with `access_denied` even if added as test users.
- **(Path B) `google:email:*` binds to the email captured at issuance** —
  the email is snapshotted into the `callers` row when the device flow
  completes; Google is not re-queried on dispatch. Consequences: (a) if the
  Google user later changes their primary email, existing caller tokens
  keep working against the old address until they expire or are revoked;
  (b) the allowlist entry is an email string, not an account identity — if
  a different Google account ever gets issued the same verified address and
  completes a device flow, its token will also match. Use `google:sub:*`
  for a per-account binding.
- **Token lifetimes differ by issuance path** — Google device-flow tokens
  have a fixed ~90-day `expires_in`. SIWE-exchange tokens inherit
  `expires_in` from the SIWE message's `expirationTime` (capped at 7
  days); in this walkthrough the SIWE script sets +1 h, which is why the
  returned `expires_in` is ~3595 s. Treat both as durable secrets in
  tests; don't commit them.

## When to use this vs `local-testing.md`

- This doc: validating a deployed bridge, integration-test harness against a
  staging URL, exercising the "real" SIWE → registerClient → add_caller →
  dispatch path exactly as an external integrator would.
- `local-testing.md`: iterating on server code, testing Google device flow
  end-to-end (requires local server because redirect URI points to
  `localhost:8787`), running unit tests that hit the DB directly, or reproducing
  DB-level gotchas (LRU cache, allowed_callers non-hot-reload via raw SQL).
