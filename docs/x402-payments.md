# x402 payments

The bridge can charge callers per invocation using
[x402](https://github.com/x402-foundation/x402), settling on-chain through a
facilitator. Pricing is configured per agent; an agent with no pricing row is
free and takes no payment code path at all.

Only the **`exact`** scheme is implemented today — a fixed price per call,
agreed before the work happens. See [Roadmap](#roadmap) for usage-based
billing.

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

Pricing lives in `agents.x402_pricing` (JSONB, NULL by default):

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

`amount` is a string on purpose. It is atomic units, not dollars: writing
`0.01` when you meant one cent of USDC is the classic mistake, and 18-decimal
assets exceed the exact integer range of a JavaScript number. The server
rejects anything that is not a positive decimal integer string at startup of
the connection rather than at payment time.

**Pricing is read from the database, never from the client's `hello` frame.**
`payTo` decides who gets paid, and the hello frame is authored by the
connecting agent — so it carries the same trust boundary as `allowed_callers`.
A malformed pricing row does not take the agent offline: it is logged
(`x402_pricing_invalid`) and the agent connects as free, so nobody is charged
against a configuration the server could not read.

Repricing takes effect on the next call — the executor reads the live
connection each turn rather than caching pricing at connect time.

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
| `x402_settled` | settled on-chain; carries the transaction hash |
| `x402_settle_failed` / `x402_settle_error` | settlement was refused or unreachable |
| `x402_gate_error` | the payment rail was unavailable; the call was refused rather than served free |
| `x402_pricing_invalid` | a malformed pricing row; the agent connected as free |

## Testing locally

Base Sepolia + the default hosted facilitator is the intended sandbox. Set
pricing on a test agent, then drive it with the `a2a-wallet` CLI, which signs
x402 payloads and handles the resubmission.

The gate's own tests (`packages/server/src/x402/gate.test.ts`) run against a
stub facilitator, so the full round-trip — including the refusal paths — is
verifiable without a chain or a database.

## Roadmap

**Usage-based billing (the `upto` scheme).** Conceptually the better fit for
an LLM bridge: the payer signs a Permit2 authorization up to a ceiling, and
the merchant settles only the metered consumption. The SDK supports it (x402
V2 only), and the settlement clamp means a metering bug can only ever
undercharge.

It is blocked on one thing: the bridge has no per-task usage signal. The
`usage.request` RPC returns a per-agent snapshot, and `TaskCompleteFrame`
carries only `status`. Adding an optional `usage` field to that frame, filled
in by the backends, is the prerequisite.
