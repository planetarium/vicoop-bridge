# x402 payments

The bridge can charge callers per invocation using
[x402](https://github.com/x402-foundation/x402), settling on-chain through a
facilitator. Pricing is configured per agent; an agent with no pricing row is
free and takes no payment code path at all.

Two pricing schemes are supported:

| scheme | what the caller pays | when to use it |
| --- | --- | --- |
| `exact` | a flat fee per call, agreed before the work happens | predictable pricing; the only option for backends that can't report token usage |
| `upto` | the tokens actually consumed, up to a ceiling they authorize | metered LLM access, where a one-line question and a long research task shouldn't cost the same |

`exact` is the default and works on every backend. `upto` needs two things
the caller and the backend must both supply — see
[Metered pricing](#metered-pricing-upto) before choosing it.

## How a paid call runs

```
turn 1   caller → bridge          message/send (no payment)
         bridge → caller          Task(input-required)
                                    metadata['x402.payment.required']
                                      = { x402Version: 2, resource, accepts: [...] }
         (the connected agent is never contacted; no capacity is consumed)

         caller signs the payload with its wallet

turn 2   caller → bridge          message/send { message.taskId: <same task> }
                                    metadata['x402.payment.status'] = 'payment-submitted'
                                    metadata['x402.payment.payload'] = <signed>
         bridge                   classify → facilitator.verify
         bridge → agent           task.assign        (only now does work start)
         agent  → bridge          task.complete
         bridge                   facilitator.settle
         bridge → caller          Task(completed)
                                    metadata['x402.payment.receipts'] = [{ transaction, ... }]
```

Two properties that follow from the ordering, and are worth stating because
they are the ones an operator gets asked about:

- **Unpaid calls never reach the agent.** The gate runs before the task is
  bound or forwarded, so an unpaid or invalid request costs the backend
  nothing.
- **Failed work is not charged.** Settlement happens only on a `completed`
  task. If the agent fails, is cancelled, or times out, the payer's signed
  authorization simply goes unused — it expires on its own.

If settlement itself fails, the task is reported `failed` rather than
`completed`: the caller got the work but the merchant was not paid, and
reporting success would hide that.

## Configuring an agent's price

From the operator's machine, with the same owner-session bearer `agent callers`
uses (`vicoop-client auth login --server <URL>` first):

```bash
# What does this agent charge?
vicoop-client agent x402 show <AGENT_ID>

# Flat fee: 0.01 USDC per call on Base Sepolia
vicoop-client agent x402 set <AGENT_ID> \
  --network eip155:84532 \
  --asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  --pay-to 0xYourWallet \
  --amount 10000

# Metered: $3/MTok in, $15/MTok out, 1 USDC ceiling, 0.001 USDC floor
vicoop-client agent x402 set <AGENT_ID> \
  --scheme upto \
  --network eip155:84532 \
  --asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  --pay-to 0xYourWallet \
  --facilitator 0xFacilitatorAddress \
  --max-amount 1000000 --min-amount 1000 \
  --rate-input 3000000 --rate-output 15000000

# Or supply the whole object (also reads stdin with `-`)
vicoop-client agent x402 set <AGENT_ID> --file pricing.json

# Back to free
vicoop-client agent x402 clear <AGENT_ID>
```

These call `GET`/`PUT`/`DELETE /admin-api/agents/:id/x402`. The body is
validated server-side against the same schema the payment gate uses, so a bad
address or a dollars-instead-of-atomic amount is rejected at write time rather
than silently disabling payments at the agent's next connect. Changes are
hot-reloaded — no daemon restart, no reconnect.

Note the auth boundary: these take the **owner-session** bearer, not the agent
token. A stolen agent token can impersonate the agent but cannot reprice it or
redirect its payments.

Pricing lives in `agents.x402_pricing` (JSONB, NULL by default). A row with no
`scheme` is `exact`:

```json
{
  "network": "eip155:84532",
  "amount": "10000",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x1111111111111111111111111111111111111111",
  "description": "Premium research agent"
}
```

| field | meaning |
| --- | --- |
| `network` | CAIP-2 chain id under x402 V2 (`eip155:84532` = Base Sepolia); a bare name (`base-sepolia`) under V1. |
| `amount` | Price in the asset's **smallest unit**, as a decimal string. USDC has 6 decimals, so `"10000"` is 0.01 USDC. |
| `asset` | Token contract address. |
| `payTo` | Wallet that receives the payment. |
| `description` | Shown in the payer's wallet consent prompt. Optional. |
| `extra` | EIP-712 domain override (`{ name, version }`). Only needed for tokens outside the well-known USDC deployments the SDK special-cases — a wrong domain produces signatures the facilitator can never verify. Optional. |

Every amount is a string on purpose. They are atomic units, not dollars:
writing `0.01` when you meant one cent of USDC is the classic mistake, and
18-decimal assets exceed the exact integer range of a JavaScript number. The
server rejects anything that is not a decimal integer string when the agent
connects, rather than at payment time.

**Pricing is read from the database, never from the client's `hello` frame.**
`payTo` decides who gets paid, and the hello frame is authored by the
connecting agent — so it carries the same trust boundary as `allowed_callers`.
A malformed pricing row does not take the agent offline: it is logged
(`x402_pricing_invalid`) and the agent connects as free, so nobody is charged
against a configuration the server could not read.

Repricing takes effect on the next call — the executor reads the live
connection each turn rather than caching pricing at connect time.

## Metered pricing (`upto`)

Under `upto` the payer signs a Permit2 authorization for a **ceiling**, the
agent does the work, and the bridge settles only what the call actually
consumed.

```json
{
  "scheme": "upto",
  "network": "eip155:84532",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x1111111111111111111111111111111111111111",
  "facilitatorAddress": "0x3333333333333333333333333333333333333333",
  "maxAmount": "1000000",
  "rates": { "input": "3000000", "output": "15000000", "cachedInput": "300000" },
  "minAmount": "1000"
}
```

| field | meaning |
| --- | --- |
| `maxAmount` | The ceiling the payer authorizes. Also the blast radius of a pricing mistake — the charge is clamped to it. |
| `rates` | Price per **million tokens**, in atomic units — the unit model vendors quote in, so a price list transcribes directly. `"3000000"` at 6 decimals is $3.00/MTok. |
| `rates.cachedInput` | Rate for cache-read prompt tokens. **Absent means "same as `input`", not "free"** — treating an unstated discount as 100% would give away most of a cache-heavy call. |
| `minAmount` | Floor for a completed call, and what is charged when usage is unavailable (below). Absent means zero. |
| `facilitatorAddress` | The payer's Permit2 witness binds to this, so it must match the facilitator that settles. Read it from the facilitator's `GET /supported` (`extra.facilitatorAddress`). The SDK substitutes no default here. |

The charge is `ceil((fresh_input×input + cached×cachedInput + output×output) / 1e6)`,
computed in BigInt. `cached_tokens` is a *breakdown* of `prompt_tokens` and
`reasoning_tokens` a breakdown of `completion_tokens` — neither is additive,
so neither is double-counted. Rounding is up, which keeps a very small call
from pricing to zero.

The SDK clamps the settled amount to the minimum of what we metered, the
ceiling we offered, and the payer's signed cap. **A metering bug can therefore
only ever undercharge** — the clamp is defence in depth on top of the
facilitator enforcing the same bound on-chain.

### Two prerequisites

**x402 V2.** `upto` does not exist in V1. This deployment defaults to V2, but
if `BRIDGE_X402_VERSION=1` an `upto` agent refuses every call with
`invalid_x402_version` and logs `x402_config_invalid` — a permanent
misconfiguration, reported as one rather than as a transient outage.

**The caller has to opt in.** Signing `upto` authorizes spending up to the
maximum at the merchant's discretion, which is broader consent than `exact`.
The SDK's default requirement selector therefore *never* auto-picks an `upto`
offer: clients must pass `allowUpto` (on `A2XClient`'s `x402` config or
`signX402Payment`) or select the requirement explicitly. An `upto`-only agent
is unusable by a default-configured client, so check your callers before
switching an existing agent over.

### When the backend reports no usage

Not every completed call can be priced:

- **openclaw reports no token usage at any layer.** Metered pricing is not
  possible for that backend — leave it on `exact`.
- **codex and vicoop-codex omit the counts** when their runtime dropped its
  accounting for a turn. Both log a warning when they do. (They still emit a
  `{0,0,0}` placeholder into the openai-compat metadata, which that
  extension's contract requires — but the protocol's `usage` field is left
  absent, so the meter is not fooled.)

Both cases arrive as "no usage reported", which is **not** "the call was
free". The bridge charges `minAmount` (zero if unset) and logs
`x402_usage_unavailable` with what it charged. A reported zero is treated the
same way, since a runtime that genuinely consumed nothing did no billable
work either.

The default direction is deliberately payer-favourable. Billing the authorized
ceiling because *our* instrumentation lost the token count would be a
user-visible wrong; undercharging is our own loss to fix. **If you run a
metered agent, set `minAmount`** — otherwise those calls are free, and the log
event is the only thing telling you so.

## Deployment settings

| env var | default | purpose |
| --- | --- | --- |
| `BRIDGE_X402_VERSION` | `2` | Wire version this deployment emits. Set to `1` only to serve clients built against the older reference lineage. A server speaks exactly one version — there is no per-request negotiation, because the activation URI is version-neutral. |
| `BRIDGE_X402_FACILITATOR_URL` | SDK default (`https://x402.org/facilitator`) | Facilitator running verify + settle. |
| `BRIDGE_X402_OFFER_TTL_SECONDS` | `600` | How long a payer has to sign and resubmit. Past it the offering lapses and the submission is refused; the payer is not charged, they just start over. |

The AgentCard advertises `X402_FOUNDATION_EXTENSION_URI` with the price in
`params` when — and only when — pricing is configured, so a caller can decide
whether it is willing to pay before spending a turn. It is advertised
`required: false`: a caller that cannot pay still gets a well-formed
`input-required` response naming the price, which is more useful than being
refused at extension activation.

## Offering storage

Offerings live in the `x402_offerings` table, not in process memory.

This is not an optimization. The round-trip spans two HTTP requests and the
bridge runs several Fly instances behind a load balancer, so turn 2 regularly
lands on an instance that never saw turn 1. With the SDK's default in-memory
store that reads as "no offering for this task" and the payment is refused —
the payer is not charged, but the call fails for no reason the caller can act
on. Restarts do the same to a single instance.

Rows are deleted when the task terminates. Expiry is lazy (a `WHERE` clause on
read), so no background reaper is required; `PostgresX402Store.sweepExpired()`
exists to reclaim rows whose task never terminated at all.

The row's `entry` column is the audit record of what was charged — the
advertised offering, the lifecycle status, and on success the receipt
(transaction hash, payer, settled amount).

## Observability

All events are structured JSON on stdout (see
[`vicoop-bridge-logs`](./remote-testing.md) for how to read them):

| event | when |
| --- | --- |
| `x402_payment_required` | turn 1 — an offering was published |
| `x402_payment_verified` | turn 2 — the facilitator accepted the payload |
| `x402_payment_refused` | the submission was invalid (no offering, wrong network, bad shape) |
| `x402_verify_failed` | the facilitator rejected the payload |
| `x402_metered` | `upto` only — what the call priced to, with the token counts and the `basis` (`metered` / `floor` / `no-usage`) |
| `x402_usage_unavailable` | `upto` only — work was delivered that could not be priced; carries what was charged instead |
| `x402_usage_legacy_source` | `upto` only — the counts came from the openai-compat fallback because the client is too old to send `TaskCompleteFrame.usage`. Chase the client upgrade; the fallback is meant to be retired |
| `x402_settled` | settled on-chain; carries the transaction hash and the facilitator-confirmed amount |
| `x402_settle_failed` / `x402_settle_error` | settlement was refused or unreachable |
| `x402_gate_error` | the payment rail was unavailable; the call was refused rather than served free |
| `x402_pricing_invalid` | a malformed pricing row; the agent connected as free |
| `x402_config_invalid` | `upto` pricing on a V1 deployment; every call is refused until fixed |

Two worth alerting on: `x402_usage_unavailable` means revenue is being left on
the table, and a sustained `x402_settle_failed` means work is being delivered
without payment landing.

## Testing locally

Base Sepolia + the default hosted facilitator is the intended sandbox. Set
pricing on a test agent, then drive it with the `a2a-wallet` CLI, which signs
x402 payloads and handles the resubmission.

The gate's own tests (`packages/server/src/x402/gate.test.ts`) run against a
stub facilitator, so the full round-trip — including the refusal paths — is
verifiable without a chain or a database.

## Where the token counts come from

`TaskCompleteFrame.usage` — a first-class, optional field on the bridge's own
wire protocol:

```ts
{ promptTokens, completionTokens, cachedInputTokens?, model? }
```

The claude, codex, and vicoop-codex backends populate it from the counts they
already have at the end of a turn. `ws.ts` stashes it on the task binding, and
the settlement path prices from there.

**This is deliberately independent of the openai-compat extension.** The same
counts do also ride under `OPENAI_COMPAT_EXTENSION_URI` in
`status.message.metadata`, for that extension's own consumers — but billing
does not read them from there by choice. Deriving revenue from another
extension's namespace would mean that renaming or versioning that extension
turns every charge into "unreported", which bills the floor, silently, with
nothing failing. Usage is a transport-level fact about a task, so the protocol
owns it.

`readTaskUsage` still falls back to the openai-compat key when the frame field
is absent, purely so a client too old to send it stays priceable during a
rollout. That fallback logs `x402_usage_legacy_source` and is meant to be
retired once no such clients remain.

One consequence worth knowing: the openai-compat envelope *requires* a `usage`
block, so codex and vicoop-codex substitute `{0,0,0}` there when their runtime
reported nothing. The protocol field has no such requirement, so it is simply
**absent** in that case — which is the truth, and is what lets the meter tell
"reported zero" apart from "reported nothing".

Note this is also **not** the `usage.request` / `usage.response` RPC. That
returns a cumulative account-level quota snapshot (rolling subscription
windows, overage budget), rate-limited and cached — useful for capacity
dashboards, useless for metering a single call.
