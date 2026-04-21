# Local E2E testing

Walkthroughs for exercising the A2A caller auth paths end-to-end against a
local server + echo client. After #31 all paths converge on opaque caller
tokens (`vbc_caller_*`); they differ only in how the token is **issued**:
direct DB insert (Path A — smoke test), Google device flow (Path B), or SIWE
exchange (Path C).

## Prerequisites

- PostgreSQL 15+ running locally
- Node 20+, pnpm 9
- (Path B only) Google Cloud OAuth 2.0 Client ID, type **Web application**,
  authorized redirect URI `http://localhost:8787/oauth/google/callback`, with
  your Google account added to the consent screen's test users
- (SIWE regression only) a throwaway EOA private key — see script below

## Env layout

Minimum (Path A, no Google):

```bash
export DATABASE_URL="postgres://$USER@localhost:5432/vicoop_bridge_dev"
export DB_SETUP_URL="$DATABASE_URL"
export ANTHROPIC_API_KEY="sk-ant-..."                              # admin agent
export PUBLIC_URL="http://localhost:8787"
export ADMIN_WALLET_ADDRESSES="0x0000000000000000000000000000000000000001"
export PORT=8787
export POSTGRAPHILE_PORT=5433
```

Add for Path B (Google device flow):

```bash
export GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-..."
export DEVICE_FLOW_STATE_SECRET="$(openssl rand -hex 32)"
```

All four of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DEVICE_FLOW_STATE_SECRET`,
`PUBLIC_URL` must be set together or not at all — `cli.ts` fails fast otherwise.
When unset, the `/oauth/*` routes are **not mounted** (returns 404).

## DB bootstrap

```bash
createdb vicoop_bridge_dev
psql vicoop_bridge_dev -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
# schema.sql is applied automatically on server startup via ensureSchema().
```

## Bring up server

```bash
pnpm --filter @vicoop-bridge/server dev
# look for:
#   [server] schema ensured
#   [server] listening on :8787
#   [server] PostGraphile listening on :5433
```

## Bring up an echo client

Creates a `clients` row directly via SQL (bypasses SIWE admin UI), then runs
`vicoop-client` with the `echo` backend so we have a real connected agent to
route requests to.

```bash
# 1. Pick a raw token and insert the hashed form into clients.
TOKEN=dev-client-token-raw-12345
psql vicoop_bridge_dev <<SQL
INSERT INTO clients (owner_wallet, client_name, token_hash, allowed_agent_ids)
VALUES (
  '0x0000000000000000000000000000000000000001',
  'dev-echo-client',
  encode(digest('$TOKEN', 'sha256'), 'hex'),
  ARRAY['echo-agent']
) ON CONFLICT (token_hash) DO NOTHING;
SQL

# 2. Write an agent card.
cat > /tmp/echo-card.json <<'JSON'
{
  "name": "echo",
  "description": "Echo backend for dispatch testing",
  "version": "0.0.1",
  "protocolVersion": "0.3.0",
  "capabilities": { "streaming": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{ "id": "echo", "name": "echo", "description": "Echo back", "tags": ["echo"] }]
}
JSON

# 3. Run the client. NOTE: --server is the base URL WITHOUT /connect — the
# client appends /connect itself (client.ts:39). Pass ws:// not http://.
cd packages/client
../../node_modules/.bin/tsx src/cli.ts \
  --server ws://localhost:8787 \
  --token dev-client-token-raw-12345 \
  --agentId echo-agent \
  --card /tmp/echo-card.json \
  --backend echo
# logs: [client] connected, sending hello
```

The WS registration auto-creates an `agent_policies` row with
`allowed_callers = '{}'` (public). To make the agent require auth, populate
`allowed_callers` then restart the client (registry reads the list only at
registration time).

## Path A — opaque token via direct DB insert

Covers `agent-auth.ts` dispatch and `matchPrincipal` without touching Google.

```bash
# 1. Insert a callers row with a known raw token.
CALLER_TOKEN=vbc_caller_dev_test_opaque_token_raw_12345
psql vicoop_bridge_dev <<SQL
INSERT INTO callers (token_hash, principal_id, provider, email, expires_at)
VALUES (
  encode(digest('$CALLER_TOKEN', 'sha256'), 'hex'),
  'google:1234567890',
  'google',
  'alice@example.com',
  now() + interval '1 day'
);
UPDATE agent_policies
SET allowed_callers = ARRAY['google:sub:1234567890']
WHERE agent_id = 'echo-agent';
SQL

# 2. Restart the echo client so registry picks up the new allowed_callers
pkill -f 'tsx.*cli.ts.*echo-agent'
# ...rerun the client command from "Bring up an echo client" step 3...

# 3. Auth matrix
BODY='{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"m1","role":"user","kind":"message","parts":[{"kind":"text","text":"hello"}]}}}'

# no bearer → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/agents/echo-agent \
  -H "Content-Type: application/json" -d "$BODY"

# wrong bearer → 401 "Caller token not found"
curl -s -X POST http://localhost:8787/agents/echo-agent \
  -H "Authorization: Bearer vbc_caller_WRONG" \
  -H "Content-Type: application/json" -d "$BODY"

# valid bearer, principal not in list → 403
# (first insert another caller row with a different principal_id)

# valid bearer matching google:sub:1234567890 → 200 echo
curl -s -X POST http://localhost:8787/agents/echo-agent \
  -H "Authorization: Bearer $CALLER_TOKEN" \
  -H "Content-Type: application/json" -d "$BODY"
```

## Path B — Google OAuth device flow

Full RFC-8628 flow. Requires Google env vars (above) and a real Google account
that's a test user on the OAuth consent screen.

```bash
# 1. Kick off device flow
curl -sX POST http://localhost:8787/oauth/device/code | tee /tmp/device.json
# { "device_code": "...", "user_code": "XXXX-XXXX", "verification_uri_complete": "...", ... }

DEVICE_CODE=$(jq -r .device_code /tmp/device.json)

# 2. Open the URL in a browser and approve with Google.
open "$(jq -r .verification_uri_complete /tmp/device.json)"
# Flow: /oauth/device?user_code=... → /oauth/google/start → Google consent →
#       /oauth/google/callback → "Approved as <email>" page

# 3. Poll for the opaque token
curl -sX POST http://localhost:8787/oauth/token \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
  --data-urlencode "device_code=$DEVICE_CODE"
# while pending: {"error":"authorization_pending"}
# after approval: {"access_token":"vbc_caller_...","token_type":"Bearer","expires_in":...}

# 4. Find the principal that was bound to your token
psql vicoop_bridge_dev -c \
  "SELECT principal_id, email, expires_at FROM callers ORDER BY created_at DESC LIMIT 1;"

# 5. Grant that principal access to the agent + restart echo client
psql vicoop_bridge_dev -c \
  "UPDATE agent_policies SET allowed_callers = ARRAY['google:sub:<YOUR_SUB>'] WHERE agent_id='echo-agent';"
pkill -f 'tsx.*cli.ts.*echo-agent'
# ...rerun client...

# 6. Call the agent with the issued Bearer
TOKEN="vbc_caller_..."   # from step 3
curl -s -X POST http://localhost:8787/agents/echo-agent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"m","role":"user","kind":"message","parts":[{"kind":"text","text":"hi"}]}}}'
```

Other entry formats:
- `google:email:<your_email>` — matches on verified email
- `google:domain:<your_workspace_domain>` — any verified account from the domain
  (matches either `hd` claim or `@domain` email suffix)

## Path C — SIWE exchange (programmatic)

Raw SIWE bearers are no longer accepted on `/agents/:id`, `POST /`, or admin
GraphQL (see #31). SIWE is now an **issuance method**: sign a message, POST it
to `/auth/siwe/exchange`, receive an opaque `vbc_caller_*` token, and use that
token on every subsequent request. This section signs programmatically with a
test EOA and walks the full exchange.

```bash
# Script uses a well-known Anvil test key — safe because it has no real balance.
cat > /tmp/gen-siwe.mjs <<'JS'
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';

// Must match the server's PUBLIC_URL hostname — the exchange endpoint enforces
// domain match against siweDomain derived from PUBLIC_URL.
const DOMAIN = process.env.SIWE_DOMAIN ?? 'localhost';
const URI = process.env.SIWE_URI ?? 'http://localhost:8787';
// Anvil account #0 — public test key, DO NOT use for anything real.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const account = privateKeyToAccount(PRIVATE_KEY);
console.error(`# wallet: ${account.address}`);
const msg = new SiweMessage({
  domain: DOMAIN,
  address: account.address,
  statement: 'Regression test',
  uri: URI,
  version: '1',
  chainId: 1,
  nonce: 'testnonce0123456789abcdef',
  issuedAt: new Date().toISOString(),
  expirationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});
const message = msg.prepareMessage();
const signature = await account.signMessage({ message });
// Emit JSON to stdout so it can be piped directly into the exchange endpoint.
console.log(JSON.stringify({ message, signature }));
JS

# Run from packages/admin-ui — it's the only workspace with viem resolvable.
cp /tmp/gen-siwe.mjs packages/admin-ui/
(cd packages/admin-ui && node gen-siwe.mjs) > /tmp/siwe.json

# Exchange SIWE → opaque caller token.
TOKEN=$(curl -sX POST http://localhost:8787/auth/siwe/exchange \
  -H "Content-Type: application/json" \
  --data @/tmp/siwe.json | jq -r .access_token)
echo "$TOKEN"   # vbc_caller_...

# Confirm the callers row landed with provider='siwe'.
psql vicoop_bridge_dev -c \
  "SELECT principal_id, provider, expires_at FROM callers ORDER BY created_at DESC LIMIT 1;"
# principal_id should be eth:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 (Anvil #0, lowercased)
# provider should be 'siwe'

# Grant the wallet, restart client, call the agent with the opaque token.
psql vicoop_bridge_dev -c \
  "UPDATE agent_policies SET allowed_callers = ARRAY['eth:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'] WHERE agent_id='echo-agent';"
# ...restart client...

curl -s -X POST http://localhost:8787/agents/echo-agent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"messageId":"m","role":"user","kind":"message","parts":[{"kind":"text","text":"siwe test"}]}}}'
```

Verified scenarios:
- exchange issues an opaque token tied to `eth:<addr>` with `provider='siwe'`
- that opaque token matches canonical `eth:0x...` entries in `allowed_callers`
- mixed policy (`[eth:0x..., google:sub:...]`) — both opaque tokens match
  against their own principal
- raw SIWE bearer on `/agents/:id` → 401 `Invalid bearer token: expected vbc_caller_* prefix`
- expired SIWE message on exchange → 401 `invalid_grant`
- domain mismatch on exchange → 401 `invalid_grant`
- admin UI / admin GraphQL: same opaque token grants `wallet_address` claim and
  (if wallet in `ADMIN_WALLET_ADDRESSES`) admin scope

## Unit tests with live DB

DB-gated cases in the auth module tests (caller-token, device-flow,
siwe-exchange) skip without `DATABASE_URL`. To run the full suite:

```bash
DATABASE_URL="postgres://$USER@localhost:5432/vicoop_bridge_dev" \
  pnpm --filter @vicoop-bridge/server exec tsx --test src/auth/*.test.ts
# expect: pass 90 / skipped 0
```

## Gotchas

- **`allowed_callers` edits via SQL don't hot-reload** — `registry.ts` caches
  the list in memory at WS registration. After updating the DB, kill and
  re-run the echo client so it re-registers and the registry re-reads the row.
- **Client `--server` URL must not include `/connect`** — client.ts appends it.
  `--server ws://localhost:8787/connect` results in `/connect/connect` and
  immediate disconnects.
- **`/oauth/*` endpoints 404 without Google env** — the mount is conditional on
  all four Google config vars being present.
- **Multiple client processes with the same token** collide; the older WS gets
  closed with code 4009. Kill previous clients before restarting.
- **`device_sessions` pending rows accumulate if flows are abandoned**. They
  have a 10-min TTL and are cleaned up hourly by the background job in
  `index.ts`. To force-purge: `DELETE FROM device_sessions WHERE expires_at <= now();`
- **Caller token LRU cache is 60s**. After `UPDATE callers SET revoked=true`,
  revocation only takes effect on the next verify after ~60s. For immediate
  testing, wait out the window or restart the server.

## Tear-down

```bash
pkill -f 'tsx.*watch.*src/cli.ts'    # server
pkill -f 'tsx.*cli.ts.*echo-agent'   # client
dropdb vicoop_bridge_dev             # optional, full reset
```
