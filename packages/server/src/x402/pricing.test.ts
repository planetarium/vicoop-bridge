import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseX402Pricing, pricingToAccepts } from './pricing.js';

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

test('parseX402Pricing accepts a minimal offering', () => {
  assert.deepEqual(parseX402Pricing(VALID), VALID);
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
  assert.equal(parseX402Pricing({ ...VALID, amount: big })?.amount, big);
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
