import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  meterUsage,
  parseX402Pricing,
  pricingToAccepts,
  type X402UptoPricing,
} from './pricing.js';

const VALID = {
  network: 'eip155:84532',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x1111111111111111111111111111111111111111',
};

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

test('pricingToAccepts builds a single exact offering bound to the resource URL', () => {
  const accepts = pricingToAccepts(parseX402Pricing(VALID)!, 'https://bridge.test/agents/a1');
  assert.equal(accepts.length, 1);
  assert.deepEqual(accepts[0], {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: VALID.asset,
    payTo: VALID.payTo,
    resource: 'https://bridge.test/agents/a1',
    description: 'Agent invocation',
  });
});

test('pricingToAccepts forwards a custom description and EIP-712 extra', () => {
  const extra = { name: 'USD Coin', version: '2' };
  const accepts = pricingToAccepts(
    parseX402Pricing({ ...VALID, description: 'Premium research', extra })!,
    'https://bridge.test/agents/a1',
  );
  assert.equal(accepts[0]!.description, 'Premium research');
  assert.deepEqual(accepts[0]!.extra, extra);
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

test('pricingToAccepts offers the ceiling and the facilitator address for upto', () => {
  const accepts = pricingToAccepts(upto(), 'https://bridge.test/agents/a1');
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]!.scheme, 'upto');
  // `amount` on the wire is what the payer authorizes, not what is charged.
  assert.equal(accepts[0]!.amount, '1000000');
  assert.deepEqual(accepts[0]!.extra, { facilitatorAddress: UPTO.facilitatorAddress });
});

test('meterUsage prices input and output at their separate rates', () => {
  // 100k in @ $3/MTok = 300000 atomic; 10k out @ $15/MTok = 150000 atomic.
  const charge = meterUsage(upto(), {
    prompt_tokens: 100_000,
    completion_tokens: 10_000,
    total_tokens: 110_000,
  });
  assert.equal(charge.basis, 'metered');
  assert.equal(charge.amountAtomic, '450000');
});

test('meterUsage discounts cached input without double-counting it', () => {
  // cached_tokens is a breakdown of prompt_tokens, never additive: 100k
  // prompt of which 90k cached = 10k fresh @ $3 + 90k cached @ $0.30.
  const charge = meterUsage(upto({ rates: { ...UPTO.rates, cachedInput: '300000' } }), {
    prompt_tokens: 100_000,
    completion_tokens: 0,
    total_tokens: 100_000,
    cached_tokens: 90_000,
  });
  assert.equal(charge.amountAtomic, '57000');
});

test('meterUsage charges cached input at the full rate when no discount is set', () => {
  // Absent cachedInput means "same as input", not "free" — treating an
  // unstated discount as 100% would give away most of a cache-heavy call.
  const charge = meterUsage(upto(), {
    prompt_tokens: 100_000,
    completion_tokens: 0,
    total_tokens: 100_000,
    cached_tokens: 90_000,
  });
  assert.equal(charge.amountAtomic, '300000');
});

test('meterUsage rounds a sub-unit charge up rather than down to zero', () => {
  // A fractional result must not floor to 0, which downstream is
  // indistinguishable from "nothing was reported".
  const charge = meterUsage(upto({ rates: { input: '1', output: '1' } }), {
    prompt_tokens: 1,
    completion_tokens: 0,
    total_tokens: 1,
  });
  assert.equal(charge.amountAtomic, '1');
  assert.equal(charge.basis, 'metered');
});

test('meterUsage applies the floor when the metered charge is below it', () => {
  const charge = meterUsage(upto({ minAmount: '50000' }), {
    prompt_tokens: 100,
    completion_tokens: 0,
    total_tokens: 100,
  });
  assert.equal(charge.basis, 'floor');
  assert.equal(charge.amountAtomic, '50000');
});

test('meterUsage treats missing or zero usage as unpriceable, not free', () => {
  // The distinction that matters for revenue: openclaw reports no usage at
  // all, and codex/vicoop-codex emit {0,0,0} when their runtime dropped
  // accounting. Neither means the call was free.
  for (const usage of [undefined, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }]) {
    const withoutFloor = meterUsage(upto(), usage);
    assert.equal(withoutFloor.basis, 'no-usage');
    assert.equal(withoutFloor.amountAtomic, '0');

    const withFloor = meterUsage(upto({ minAmount: '25000' }), usage);
    assert.equal(withFloor.basis, 'no-usage');
    assert.equal(withFloor.amountAtomic, '25000');
  }
});

test('meterUsage stays exact on values that would break a double', () => {
  // 1e9 tokens * 3e12 rate = 3e21 before division — far past 2^53, which is
  // why the arithmetic is BigInt end to end.
  const charge = meterUsage(upto({ rates: { input: '3000000000000', output: '0' } }), {
    prompt_tokens: 1_000_000_000,
    completion_tokens: 0,
    total_tokens: 1_000_000_000,
  });
  assert.equal(charge.amountAtomic, '3000000000000000');
});
