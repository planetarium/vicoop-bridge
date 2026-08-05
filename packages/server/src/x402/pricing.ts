import { z } from 'zod';
import type { X402Accept } from '@a2x/sdk/x402';
import type { TaskUsage } from './usage.js';

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
  // Floor for a completed call. Also what is charged when the backend
  // reported no usage at all — see `meterUsage`. Absent means zero.
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
 * Build the offering advertised to the payer. `resource` must be the public
 * URL of what is being paid for — strict facilitators reject non-URL values,
 * and wallets show it in the consent prompt, so it is the agent's own
 * endpoint rather than an opaque id.
 */
export function pricingToAccepts(pricing: X402Pricing, resource: string): X402Accept[] {
  const common = {
    network: pricing.network,
    asset: pricing.asset,
    payTo: pricing.payTo,
    resource,
  };

  if (pricing.scheme === 'upto') {
    return [
      {
        ...common,
        scheme: 'upto',
        // What the payer authorizes, not what they will be charged.
        amount: pricing.maxAmount,
        description: pricing.description ?? 'Metered agent invocation — billed per token',
        extra: { ...(pricing.extra ?? {}), facilitatorAddress: pricing.facilitatorAddress },
      },
    ];
  }

  return [
    {
      ...common,
      scheme: 'exact',
      amount: pricing.amount,
      description: pricing.description ?? 'Agent invocation',
      ...(pricing.extra !== undefined ? { extra: pricing.extra } : {}),
    },
  ];
}

/** What `meterUsage` decided to charge, and why — the `why` is logged. */
export interface MeteredCharge {
  amountAtomic: string;
  /**
   * - `metered`  — priced from reported token counts.
   * - `floor`    — the metered value was below `minAmount`.
   * - `no-usage` — the backend reported nothing; `minAmount` (or zero) applied.
   */
  basis: 'metered' | 'floor' | 'no-usage';
}

/**
 * Price a completed call from its reported token usage.
 *
 * Arithmetic is BigInt throughout: rates are per million tokens, so the
 * intermediate product overflows a double's exact range long before the
 * amounts do. The division rounds **up** — standard for billing, and it keeps
 * a genuinely tiny call from pricing to zero, which would be
 * indistinguishable from "the runtime told us nothing".
 *
 * That distinction is the reason `basis` exists. `total_tokens: 0` does not
 * mean the call was free: codex and vicoop-codex emit `{0,0,0}` as an honest
 * "the runtime did not report" placeholder, and openclaw reports no usage at
 * all. Charging zero for delivered work is a real loss, so an operator who
 * cares sets `minAmount` and gets that floor instead. Charging the authorized
 * ceiling in this case would be worse: it bills the payer the maximum for a
 * gap in *our* instrumentation.
 */
export function meterUsage(pricing: X402UptoPricing, usage: TaskUsage | undefined): MeteredCharge {
  const floor = BigInt(pricing.minAmount ?? '0');

  if (usage === undefined || usage.total_tokens === 0) {
    return { amountAtomic: floor.toString(), basis: 'no-usage' };
  }

  const cached = BigInt(usage.cached_tokens ?? 0);
  // `cached_tokens` is a breakdown of `prompt_tokens`, never additive, so the
  // full-price share is what remains after taking the cached part out.
  const freshInput = BigInt(usage.prompt_tokens) - cached;
  const cachedRate = BigInt(pricing.rates.cachedInput ?? pricing.rates.input);

  const micros =
    (freshInput > 0n ? freshInput : 0n) * BigInt(pricing.rates.input) +
    cached * cachedRate +
    // `reasoning_tokens` is likewise a breakdown of `completion_tokens`, so
    // completion alone already covers it.
    BigInt(usage.completion_tokens) * BigInt(pricing.rates.output);

  const PER = 1_000_000n;
  const metered = micros === 0n ? 0n : (micros + PER - 1n) / PER;

  if (metered < floor) return { amountAtomic: floor.toString(), basis: 'floor' };
  return { amountAtomic: metered.toString(), basis: 'metered' };
}
