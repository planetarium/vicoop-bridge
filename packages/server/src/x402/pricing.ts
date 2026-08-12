import { z } from 'zod';
import type { MerchantOffer } from '@a2x/sdk/x402';

// Per-agent x402 pricing, persisted on `agents.x402_pricing` and carried on
// the live `ClientConnection`. Deliberately DB-owned rather than declared in
// the WS hello frame: `payTo` decides who receives money, and the hello frame
// is authored by the connecting client. Same trust boundary as
// `allowed_callers` — the bridge, not the agent, is authoritative.
//
// Two schemes:
//
//   exact — a fixed charge per call, agreed before the work happens.
//   upto  — the payer authorizes up to a ceiling and the bridge settles the
//           metered token consumption. x402 V2 only.
//
// The metering itself lives in the SDK's `MerchantGate` — this module only
// owns the stored row shape and its mapping onto the SDK's `MerchantOffer`.

// An EVM address. Stored as given (checksummed or not) — the x402 payload
// checks compare case-insensitively.
const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

// Atomic units of the asset, as a decimal integer string. Never a number:
// USDC has 6 decimals but other assets have 18, and 1e18 exceeds the exact
// range of a double — the same reason the x402 wire format uses strings.
const AtomicAmount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a decimal integer string in atomic units');

const PositiveAtomicAmount = AtomicAmount.refine((v) => v !== '0', 'must be greater than zero');

const BasePricing = {
  // Bare name (`base-sepolia`) under x402 V1, CAIP-2 (`eip155:84532`) under V2.
  // Not constrained here: the SDK owns per-version network encoding, and
  // pinning a list would reject a chain the facilitator already supports.
  network: z.string().min(1),
  asset: EvmAddress,
  payTo: EvmAddress,
  description: z.string().min(1).optional(),
  // Overrides the SDK's per-asset EIP-712 domain default. Needed for tokens
  // outside the well-known USDC deployments the SDK special-cases; a wrong
  // domain produces signatures the facilitator can never verify.
  extra: z.record(z.string(), z.unknown()).optional(),
};

const ExactPricingSchema = z.object({
  ...BasePricing,
  scheme: z.literal('exact'),
  amount: PositiveAtomicAmount,
});

// Price per *million* tokens, in atomic units — the unit model providers
// quote in, kept as-is so an operator transcribes a price list without
// converting. Atomic strings again: at 6 decimals `$3.00 / MTok` is
// `"3000000"`.
const RatesSchema = z.object({
  input: AtomicAmount,
  output: AtomicAmount,
  // Cache reads are normally discounted heavily. Absent means "same as
  // input" rather than "free" — treating an unstated discount as 100% would
  // give away the bulk of a cache-heavy call.
  cachedInput: AtomicAmount.optional(),
});

const UptoPricingSchema = z.object({
  ...BasePricing,
  scheme: z.literal('upto'),
  // The ceiling the payer authorizes. The metered charge is clamped to it by
  // the SDK, so it doubles as the blast radius of a metering bug.
  maxAmount: PositiveAtomicAmount,
  rates: RatesSchema,
  // Floor for a completed call that metered below it. Also what is charged
  // when the backend reported no usage at all — the bridge maps this row with
  // `unreportedUsage: 'floor'`, see `pricingToOffer`. Absent means zero.
  minAmount: AtomicAmount.optional(),
  // The payer's Permit2 witness binds to this address, so it must match the
  // facilitator that will settle. Read it from the facilitator's
  // `GET /supported` (`extra.facilitatorAddress`). The SDK never substitutes
  // a default here, unlike the `exact` scheme's EIP-712 domain.
  facilitatorAddress: EvmAddress,
});

// `scheme` defaults to `exact` so the common flat-fee row stays a four-field
// object.
function withSchemeDefault(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !('scheme' in raw)) {
    return { ...(raw as Record<string, unknown>), scheme: 'exact' };
  }
  return raw;
}

/**
 * Pricing as **read** from storage. Unknown keys are dropped rather than
 * rejected, on purpose: a row written by a newer server (a field this build
 * doesn't know yet) must still price correctly here. Rejecting it would make
 * `parseX402Pricing` throw, which downgrades the agent to free — a rollback
 * would quietly stop charging for every paid agent.
 */
export const X402PricingSchema = z.preprocess(
  withSchemeDefault,
  z.discriminatedUnion('scheme', [ExactPricingSchema, UptoPricingSchema]),
);

/**
 * Pricing as **written** through the admin API. Strict: an unrecognized key
 * is an error, not something to drop silently.
 *
 * The asymmetry with the read schema is deliberate. Every field here is
 * optional-with-a-consequential-default, so a typo does not fail — it changes
 * the price. `minamount` instead of `minAmount` leaves the floor unset, which
 * makes every call the backend cannot meter free. `cachedinput` instead of
 * `cachedInput` charges cache reads at the full input rate, overcharging the
 * payer. Both would return 200 under the lenient schema, and the operator
 * would find out from an invoice. Writes are the one place where the caller
 * is present to be told, so they are told.
 */
export const X402PricingWriteSchema = z.preprocess(
  withSchemeDefault,
  z.discriminatedUnion('scheme', [
    ExactPricingSchema.strict(),
    // `.strict()` only guards the level it is applied to, so the nested rate
    // table needs its own — that is where two of the three typo-able optional
    // fields live. `extra` stays a free-form record by design: it is a
    // passthrough for scheme-specific fields the SDK owns.
    UptoPricingSchema.extend({ rates: RatesSchema.strict() }).strict(),
  ]),
);

export type X402Pricing = z.infer<typeof X402PricingSchema>;
export type X402ExactPricing = z.infer<typeof ExactPricingSchema>;
export type X402UptoPricing = z.infer<typeof UptoPricingSchema>;

/**
 * Parse a `agents.x402_pricing` JSONB value. Returns `undefined` for NULL —
 * the overwhelmingly common case (a free agent) — and throws only on a value
 * that is present but malformed, which is an operator error worth surfacing.
 */
export function parseX402Pricing(raw: unknown): X402Pricing | undefined {
  if (raw === null || raw === undefined) return undefined;
  return X402PricingSchema.parse(raw);
}

/**
 * Render a validation failure as one line an operator can act on.
 *
 * `String(zodError)` is a multi-line JSON dump that reaches the CLI as a wall
 * of text; the field path and the reason are the only parts that matter.
 */
export function formatPricingError(err: unknown): string {
  if (!(err instanceof z.ZodError)) return String(err);
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Map a stored pricing row onto the offer the SDK's `MerchantGate` publishes.
 *
 * `resource` must be the public URL of what is being paid for — strict
 * facilitators reject non-URL values, and wallets show it in the consent
 * prompt, so it is the agent's own endpoint rather than an opaque id.
 *
 * The wire shape is unchanged from the pre-MerchantGate builds: the SDK
 * flattens an `upto` entry back to `{ scheme: 'upto', amount: maxAmount }`
 * when it advertises, and the rate table only ever drives settlement.
 */
export function pricingToOffer(pricing: X402Pricing, resource: string): MerchantOffer {
  const common = {
    network: pricing.network,
    asset: pricing.asset,
    payTo: pricing.payTo,
    resource,
  };

  if (pricing.scheme === 'upto') {
    return {
      accepts: [
        {
          ...common,
          scheme: 'upto',
          maxAmount: pricing.maxAmount,
          ...(pricing.minAmount !== undefined ? { minAmount: pricing.minAmount } : {}),
          rates: {
            inputPerMillion: pricing.rates.input,
            outputPerMillion: pricing.rates.output,
            ...(pricing.rates.cachedInput !== undefined
              ? { cachedInputPerMillion: pricing.rates.cachedInput }
              : {}),
          },
          // Bridge policy: a backend that reported no usage bills the floor,
          // never the authorized ceiling — a gap in *our* instrumentation must
          // not charge the payer the maximum. A trusted reported zero is
          // different and settles zero (a2x#206); see `readTaskUsage`.
          unreportedUsage: 'floor',
          description: pricing.description ?? 'Metered agent invocation — billed per token',
          extra: { ...(pricing.extra ?? {}), facilitatorAddress: pricing.facilitatorAddress },
        },
      ],
    };
  }

  return {
    accepts: [
      {
        ...common,
        scheme: 'exact',
        amount: pricing.amount,
        description: pricing.description ?? 'Agent invocation',
        ...(pricing.extra !== undefined ? { extra: pricing.extra } : {}),
      },
    ],
  };
}
