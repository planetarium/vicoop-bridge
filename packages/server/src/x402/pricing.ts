import { z } from 'zod';
import type { X402Accept } from '@a2x/sdk/x402';

// Per-agent x402 pricing, persisted on `agents.x402_pricing` and carried on
// the live `ClientConnection`. Deliberately DB-owned rather than declared in
// the WS hello frame: `payTo` decides who receives money, and the hello frame
// is authored by the connecting client. Same trust boundary as
// `allowed_callers` — the bridge, not the agent, is authoritative.
//
// One offering, `exact` scheme only. Multi-offer (several networks) and the
// usage-based `upto` scheme both fit this shape later: `upto` needs a metered
// amount at settle time, which needs per-task usage on the WS protocol first.

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
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a decimal integer string in atomic units')
  .refine((v) => v !== '0', 'must be greater than zero');

export const X402PricingSchema = z.object({
  // Bare name (`base-sepolia`) under x402 V1, CAIP-2 (`eip155:84532`) under V2.
  // Not constrained here: the SDK owns per-version network encoding, and
  // pinning a list would reject a chain the facilitator already supports.
  network: z.string().min(1),
  amount: AtomicAmount,
  asset: EvmAddress,
  payTo: EvmAddress,
  description: z.string().min(1).optional(),
  // Overrides the SDK's per-asset EIP-712 domain default. Needed for tokens
  // outside the well-known USDC deployments the SDK special-cases; a wrong
  // domain produces signatures the facilitator can never verify.
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type X402Pricing = z.infer<typeof X402PricingSchema>;

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
 * Build the offering advertised to the payer. `resource` must be the public
 * URL of what is being paid for — strict facilitators reject non-URL values,
 * and wallets show it in the consent prompt, so it is the agent's own
 * endpoint rather than an opaque id.
 */
export function pricingToAccepts(pricing: X402Pricing, resource: string): X402Accept[] {
  return [
    {
      scheme: 'exact',
      network: pricing.network,
      amount: pricing.amount,
      asset: pricing.asset,
      payTo: pricing.payTo,
      resource,
      description: pricing.description ?? 'Agent invocation',
      ...(pricing.extra !== undefined ? { extra: pricing.extra } : {}),
    },
  ];
}
