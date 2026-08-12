import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantPricingToAccept } from '@a2x/sdk/x402';
import {
  X402PricingSchema,
  X402PricingWriteSchema,
  formatPricingError,
  parseX402Pricing,
  pricingToOffer,
  type X402UptoPricing,
} from './pricing.js';

const VALID = {
  network: 'eip155:84532',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x1111111111111111111111111111111111111111',
};

const RESOURCE = 'https://bridge.test/agents/a1';

test('parseX402Pricing treats NULL and undefined as "free agent"', () => {
  assert.equal(parseX402Pricing(null), undefined);
  assert.equal(parseX402Pricing(undefined), undefined);
});

test('parseX402Pricing defaults a scheme-less row to exact', () => {
  // Flat-fee pricing is the common case and stays a four-field object; the
  // discriminator is filled in so downstream code can switch on it.
  assert.deepEqual(parseX402Pricing(VALID), { ...VALID, scheme: 'exact' });
  assert.deepEqual(parseX402Pricing({ ...VALID, scheme: 'exact' }), {
    ...VALID,
    scheme: 'exact',
  });
});

test('parseX402Pricing rejects a non-address payTo', () => {
  // The whole point of DB-owned pricing is that payTo names who gets paid;
  // a typo that silently became a valid-looking address would send money to
  // an unrecoverable hole.
  assert.throws(() => parseX402Pricing({ ...VALID, payTo: '0xnope' }));
  assert.throws(() => parseX402Pricing({ ...VALID, asset: 'USDC' }));
});

test('parseX402Pricing rejects amounts that are not atomic integer strings', () => {
  // `0.01` is the classic mistake: x402 amounts are atomic units, so a
  // decimal here means the operator thought in dollars and would undercharge
  // by six orders of magnitude if it were coerced.
  assert.throws(() => parseX402Pricing({ ...VALID, amount: '0.01' }));
  assert.throws(() => parseX402Pricing({ ...VALID, amount: 10000 }));
  assert.throws(() => parseX402Pricing({ ...VALID, amount: '1e4' }));
  assert.throws(() => parseX402Pricing({ ...VALID, amount: '-1' }));
});

test('parseX402Pricing rejects a zero charge', () => {
  // A zero-amount offering would make every caller sign a payment that
  // transfers nothing — a free agent is expressed by NULL pricing instead.
  assert.throws(() => parseX402Pricing({ ...VALID, amount: '0' }));
});

test('parseX402Pricing keeps a large atomic amount exact', () => {
  // 18-decimal assets exceed the exact integer range of a double, which is
  // why the wire format (and this column) uses strings throughout.
  const big = '1234567890123456789';
  const parsed = parseX402Pricing({ ...VALID, amount: big });
  assert.equal(parsed?.scheme === 'exact' ? parsed.amount : undefined, big);
});

// ── row → MerchantOffer mapping ───────────────────────────────────────────

test('pricingToOffer builds a single exact offering bound to the resource URL', () => {
  const offer = pricingToOffer(parseX402Pricing(VALID)!, RESOURCE);
  assert.equal(offer.accepts.length, 1);
  assert.deepEqual(offer.accepts[0], {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: VALID.asset,
    payTo: VALID.payTo,
    resource: RESOURCE,
    description: 'Agent invocation',
  });
});

test('pricingToOffer forwards a custom description and EIP-712 extra', () => {
  const extra = { name: 'USD Coin', version: '2' };
  const offer = pricingToOffer(
    parseX402Pricing({ ...VALID, description: 'Premium research', extra })!,
    RESOURCE,
  );
  assert.equal(offer.accepts[0]!.description, 'Premium research');
  assert.deepEqual(offer.accepts[0]!.extra, extra);
});

// ── upto (metered) pricing ────────────────────────────────────────────────

const UPTO = {
  scheme: 'upto' as const,
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x1111111111111111111111111111111111111111',
  maxAmount: '1000000',
  // $3.00 / MTok in, $15.00 / MTok out, at 6 decimals.
  rates: { input: '3000000', output: '15000000' },
  facilitatorAddress: '0x3333333333333333333333333333333333333333',
};

function upto(overrides: Record<string, unknown> = {}): X402UptoPricing {
  const parsed = parseX402Pricing({ ...UPTO, ...overrides });
  assert.equal(parsed?.scheme, 'upto');
  return parsed as X402UptoPricing;
}

test('parseX402Pricing accepts an upto offering', () => {
  assert.deepEqual(parseX402Pricing(UPTO), UPTO);
});

test('parseX402Pricing requires a facilitator address for upto', () => {
  // The payer's Permit2 witness binds to it and the SDK substitutes no
  // default, so an offering without it could only dead-end at signing.
  const { facilitatorAddress: _omitted, ...withoutFacilitator } = UPTO;
  assert.throws(() => parseX402Pricing(withoutFacilitator));
});

test('parseX402Pricing requires atomic-unit rates for upto', () => {
  const { rates: _omitted, ...withoutRates } = UPTO;
  assert.throws(() => parseX402Pricing(withoutRates));
  assert.throws(() => parseX402Pricing({ ...UPTO, rates: { input: '3.00', output: '15' } }));
  assert.throws(() => parseX402Pricing({ ...UPTO, rates: { input: 3000000, output: '15' } }));
});

test('pricingToOffer maps an upto row onto the SDK rate model with the floor policy', () => {
  // The row stores rates as {input, output, cachedInput}; the SDK names them
  // per-million explicitly. `unreportedUsage` is the bridge's standing risk
  // allocation: an instrumentation gap bills the floor, never the cap.
  const offer = pricingToOffer(
    upto({ minAmount: '25000', rates: { ...UPTO.rates, cachedInput: '300000' } }),
    RESOURCE,
  );
  assert.equal(offer.accepts.length, 1);
  const pricing = offer.accepts[0]!;
  assert.equal(pricing.scheme, 'upto');
  if (pricing.scheme !== 'upto') return;
  assert.equal(pricing.maxAmount, '1000000');
  assert.equal(pricing.minAmount, '25000');
  assert.deepEqual(pricing.rates, {
    inputPerMillion: '3000000',
    outputPerMillion: '15000000',
    cachedInputPerMillion: '300000',
  });
  assert.equal(pricing.unreportedUsage, 'floor');
  assert.deepEqual(pricing.extra, { facilitatorAddress: UPTO.facilitatorAddress });
});

test('pricingToOffer leaves the optional upto fields absent, not defaulted', () => {
  // Absent cachedInput means "same as input" — the SDK owns that default, so
  // the mapping must not materialize one. Absent minAmount likewise.
  const offer = pricingToOffer(upto(), RESOURCE);
  const pricing = offer.accepts[0]!;
  assert.equal(pricing.scheme, 'upto');
  if (pricing.scheme !== 'upto') return;
  assert.equal(pricing.minAmount, undefined);
  assert.deepEqual(pricing.rates, {
    inputPerMillion: '3000000',
    outputPerMillion: '15000000',
  });
});

test('the upto wire shape is unchanged: ceiling as amount, no rate table', () => {
  // What the SDK advertises from this mapping must be what the old
  // `pricingToAccepts` put on the wire — the payer-visible contract.
  const accept = merchantPricingToAccept(pricingToOffer(upto(), RESOURCE).accepts[0]!);
  assert.deepEqual(accept, {
    scheme: 'upto',
    network: 'eip155:84532',
    amount: '1000000',
    asset: UPTO.asset,
    payTo: UPTO.payTo,
    resource: RESOURCE,
    description: 'Metered agent invocation — billed per token',
    extra: { facilitatorAddress: UPTO.facilitatorAddress },
  });
});

// ── write-time strictness ─────────────────────────────────────────────────
//
// Every optional field on a pricing object changes what is charged, so a
// dropped typo is a wrong price rather than a no-op. The write path rejects
// unknown keys; the read path still drops them, so a row written by a newer
// server keeps pricing correctly after a rollback instead of silently
// downgrading the agent to free.

test('the write schema rejects a typo in the floor instead of dropping it', () => {
  // `minamount` would leave minAmount unset, making every call the backend
  // cannot meter free — the exact footgun the docs warn about.
  const typo = { ...UPTO, minamount: '1000' };
  assert.throws(() => X402PricingWriteSchema.parse(typo), /minamount/);

  // The read path still tolerates it, and drops it.
  const read = X402PricingSchema.parse(typo) as X402UptoPricing;
  assert.equal(read.minAmount, undefined);
});

test('the write schema rejects a typo in the nested rate table', () => {
  // `.strict()` guards one level, so the nested rates object needs its own —
  // `cachedinput` would charge cache reads at the full input rate.
  assert.throws(
    () =>
      X402PricingWriteSchema.parse({
        ...UPTO,
        rates: { input: '3000000', output: '15000000', cachedinput: '300000' },
      }),
    /cachedinput/,
  );
});

test('the write schema rejects an unknown key on exact pricing too', () => {
  assert.throws(() => X402PricingWriteSchema.parse({ ...VALID, amout: '10000' }), /amout/);
});

test('the write schema still accepts every documented field', () => {
  assert.doesNotThrow(() =>
    X402PricingWriteSchema.parse({
      ...UPTO,
      minAmount: '1000',
      description: 'Metered research',
      rates: { input: '3000000', output: '15000000', cachedInput: '300000' },
    }),
  );
  assert.doesNotThrow(() => X402PricingWriteSchema.parse(VALID));
  assert.doesNotThrow(() => X402PricingWriteSchema.parse({ ...VALID, scheme: 'exact' }));
});

test('the write schema leaves `extra` free-form', () => {
  // It is a passthrough for scheme-specific fields the SDK owns (the EIP-712
  // domain), so strictness must not reach inside it.
  assert.doesNotThrow(() =>
    X402PricingWriteSchema.parse({
      ...VALID,
      extra: { name: 'USD Coin', version: '2', somethingNew: true },
    }),
  );
});

test('the read schema tolerates a field a newer server wrote', () => {
  // Rejecting would make parseX402Pricing throw, which connects the agent as
  // free — a rollback would quietly stop charging for every paid agent.
  const fromFuture = { ...UPTO, chargeSource: 'client' };
  assert.doesNotThrow(() => X402PricingSchema.parse(fromFuture));
  assert.equal((X402PricingSchema.parse(fromFuture) as X402UptoPricing).maxAmount, '1000000');
});

test('formatPricingError names the offending field on one line', () => {
  try {
    X402PricingWriteSchema.parse({ ...UPTO, minamount: '1000' });
    assert.fail('expected a validation error');
  } catch (err) {
    const message = formatPricingError(err);
    assert.match(message, /minamount/);
    assert.equal(message.includes('\n'), false, 'must stay a single line for the CLI');
  }
});
