// The orchestration itself — classify, freeze, claim, verify, meter, clamp —
// is the SDK's `MerchantGate` and is tested there. What these tests pin is the
// bridge's side of the composition: outcomes rendered as the wire events this
// executor emits, the pricing row mapped onto the published offer, and the
// deployment's policy choices (settle-before-work for `exact`, floor for
// unreported usage, zero for a trusted reported zero).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { TaskState, type Message } from '@a2x/sdk';
import {
  InMemoryMerchantOfferStore,
  InMemoryX402Store,
  X402Context,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type MerchantDeferredObligation,
  type X402Facilitator,
  type X402PaymentPayload,
  type X402VerifyResponse,
  type X402FacilitatorSettleResponse,
} from '@a2x/sdk/x402';
import { X402Gate, type X402GateOutcome } from './gate.js';
import { PostgresX402Store } from './store.js';
import { parseX402Pricing, type X402Pricing } from './pricing.js';

const RESOURCE = 'https://bridge.test/agents/a1';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const FACILITATOR = '0x3333333333333333333333333333333333333333';

const PRICING: X402Pricing = parseX402Pricing({
  network: 'eip155:84532',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: PAY_TO,
})!;

// Stub facilitator: the on-chain half of x402. Recording the calls lets the
// tests assert not just the outcome but whether settlement was attempted at
// all — the difference between "charged for failed work" and "not charged".
function stubFacilitator(
  opts: {
    verify?: X402VerifyResponse;
    settle?: X402FacilitatorSettleResponse;
    settleThrows?: boolean;
  } = {},
): X402Facilitator & {
  verifyCalls: number;
  settleCalls: number;
  // The amount on the requirement handed to `settle` — under `upto` this is
  // the metered charge after the SDK's clamp, i.e. what the payer is billed.
  settledAmount?: string;
} {
  const state = {
    verifyCalls: 0,
    settleCalls: 0,
    settledAmount: undefined as string | undefined,
    async verify(): Promise<X402VerifyResponse> {
      state.verifyCalls += 1;
      return opts.verify ?? { isValid: true };
    },
    async settle(
      _payload: unknown,
      requirements: unknown,
    ): Promise<X402FacilitatorSettleResponse> {
      state.settleCalls += 1;
      const r = requirements as { amount?: string; maxAmountRequired?: string };
      state.settledAmount = r.amount ?? r.maxAmountRequired;
      if (opts.settleThrows) throw new Error('facilitator unreachable');
      return (
        opts.settle ?? {
          success: true,
          transaction: '0xdeadbeef',
          network: 'eip155:84532',
          payer: '0x2222222222222222222222222222222222222222',
        }
      );
    },
  };
  return state as X402Facilitator & typeof state;
}

function makeGate(
  facilitator: X402Facilitator,
  pricing: X402Pricing = PRICING,
  offerStore: InMemoryMerchantOfferStore = new InMemoryMerchantOfferStore(),
): X402Gate {
  return new X402Gate(
    'a1',
    pricing,
    new X402Context({ store: new InMemoryX402Store(), facilitator, x402Version: 2 }),
    offerStore,
    RESOURCE,
  );
}

function userMessage(metadata?: Record<string, unknown>): Message {
  return {
    messageId: `m-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    parts: [{ text: 'do the thing' }],
    ...(metadata !== undefined ? { metadata } : {}),
  } as unknown as Message;
}

/** The `accepts[0]` requirement the merchant published on turn 1. */
function offeredRequirement(event: {
  status: { message?: { metadata?: Record<string, unknown> } };
}): Record<string, unknown> {
  const required = event.status.message?.metadata?.[X402_METADATA_KEYS.REQUIRED] as {
    accepts: Record<string, unknown>[];
  };
  return required.accepts[0]!;
}

/**
 * A turn-2 message carrying a signed `exact` payload that echoes the offered
 * requirement — the shape `@x402/evm` produces for an EIP-3009 signature.
 */
function submissionMessage(
  requirement: Record<string, unknown>,
  overrides: { to?: string; value?: string } = {},
): Message {
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: requirement as never,
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: '0x2222222222222222222222222222222222222222',
        to: overrides.to ?? PAY_TO,
        value: overrides.value ?? '10000',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: `0x${'11'.repeat(32)}`,
      },
    },
  } as X402PaymentPayload;

  return userMessage({
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
    [X402_METADATA_KEYS.PAYLOAD]: payload,
  });
}

test('turn 1 halts with input-required carrying the payment-required offering', async () => {
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const outcome = await gate.open({
    taskId: 't-1',
    contextId: 'ctx-1',
    message: userMessage(),
  });

  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.INPUT_REQUIRED);
  // `final` ends the SSE stream without terminating the task, which is what
  // lets the client resume the same taskId on turn 2.
  assert.equal(outcome.event.final, true);

  const metadata = outcome.event.status.message?.metadata ?? {};
  assert.equal(metadata[X402_METADATA_KEYS.STATUS], X402_PAYMENT_STATUS.REQUIRED);

  const requirement = offeredRequirement(outcome.event);
  assert.equal(requirement.payTo, PAY_TO);
  assert.equal(requirement.amount, '10000');
  assert.equal(requirement.scheme, 'exact');
  assert.equal(requirement.network, 'eip155:84532');

  // V2 hoists the resource out of each requirement to the envelope's top
  // level, so that is where the payer's wallet reads what it is paying for.
  const required = outcome.event.status.message?.metadata?.[X402_METADATA_KEYS.REQUIRED] as {
    x402Version: number;
    resource: { url: string };
  };
  assert.equal(required.x402Version, 2);
  assert.equal(required.resource.url, RESOURCE);

  // Nothing was charged just by asking.
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settleCalls, 0);
});

test('turn 2 with a valid signed payload verifies and proceeds', async () => {
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-2',
    contextId: 'ctx-2',
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 't-2',
    contextId: 'ctx-2',
    message: submissionMessage(offeredRequirement(first.event)),
  });

  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed') return;
  assert.equal(facilitator.verifyCalls, 1);
  // Flat-fee agents charge here, before the caller's work is forwarded — the
  // amount was fixed at offer time, so there is nothing to learn by doing the
  // work first.
  assert.equal(facilitator.settleCalls, 1);
  assert.equal(second.settlement?.mode, 'settled');
  if (second.settlement?.mode !== 'settled') return;
  const receipts = second.settlement.metadata[X402_METADATA_KEYS.RECEIPTS] as {
    transaction: string;
  }[];
  assert.equal(receipts[0]!.transaction, '0xdeadbeef');
});

test('a submission whose taskId was never offered is refused', async () => {
  // The horizontally-scaled failure mode the Postgres offer store exists to
  // prevent: if the offering is missing, the payload must be refused rather
  // than trusted.
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const offering = await gate.open({
    taskId: 't-known',
    contextId: 'ctx',
    message: userMessage(),
  });
  assert.equal(offering.kind, 'halt');
  if (offering.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-unknown',
    contextId: 'ctx',
    message: submissionMessage(offeredRequirement(offering.event)),
  });

  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.FAILED);
  assert.equal(facilitator.verifyCalls, 0);
});

test('a payload paying the wrong recipient is refused before the facilitator', async () => {
  // The signature is bound to `to`; a payload redirecting funds elsewhere is
  // caught locally, so a malicious client cannot even spend facilitator quota.
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-3',
    contextId: 'ctx-3',
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-3',
    contextId: 'ctx-3',
    message: submissionMessage(offeredRequirement(first.event), {
      to: '0x9999999999999999999999999999999999999999',
    }),
  });

  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.FAILED);
  assert.equal(facilitator.verifyCalls, 0);
});

test('a failed facilitator verification halts without settling', async () => {
  const facilitator = stubFacilitator({
    verify: { isValid: false, invalidReason: 'insufficient_funds' },
  });
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-4',
    contextId: 'ctx-4',
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-4',
    contextId: 'ctx-4',
    message: submissionMessage(offeredRequirement(first.event)),
  });

  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.FAILED);
  assert.equal(
    outcome.event.status.message?.metadata?.[X402_METADATA_KEYS.STATUS],
    X402_PAYMENT_STATUS.FAILED,
  );
  assert.equal(facilitator.settleCalls, 0);
});

test('a store or facilitator error fails closed instead of serving the call free', async () => {
  const facilitator: X402Facilitator = {
    async verify() {
      throw new Error('facilitator down');
    },
    async settle() {
      throw new Error('facilitator down');
    },
  };
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-5',
    contextId: 'ctx-5',
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-5',
    contextId: 'ctx-5',
    message: submissionMessage(offeredRequirement(first.event)),
  });

  // The important part is that it is NOT 'proceed' — an unpaid call must
  // never reach the agent because the payment rail was unavailable.
  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.FAILED);
});

/** Turn 1 then turn 2 for a flat-fee agent, returning turn 2's outcome. */
async function exactTurnTwo(
  facilitator: X402Facilitator,
  taskId: string,
): Promise<X402GateOutcome> {
  const gate = makeGate(facilitator);
  const first = await gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') throw new Error('unreachable');
  return gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: submissionMessage(offeredRequirement(first.event)),
  });
}

test('a flat fee settles before the work and hands back the receipt', async () => {
  const facilitator = stubFacilitator();
  const outcome = await exactTurnTwo(facilitator, 't-6');

  assert.equal(outcome.kind, 'proceed');
  if (outcome.kind !== 'proceed' || outcome.settlement?.mode !== 'settled') return;
  assert.equal(
    outcome.settlement.metadata[X402_METADATA_KEYS.STATUS],
    X402_PAYMENT_STATUS.COMPLETED,
  );
  const receipts = outcome.settlement.metadata[X402_METADATA_KEYS.RECEIPTS] as {
    transaction: string;
  }[];
  assert.equal(receipts[0]!.transaction, '0xdeadbeef');
  assert.equal(facilitator.settleCalls, 1);
});

test('a flat fee that cannot be collected never reaches the agent', async () => {
  // The point of settling first: a drained authorization costs the merchant
  // nothing, because the work has not been done yet. Under the previous
  // settle-after-work order this same failure meant the caller kept the output.
  const facilitator = stubFacilitator({
    settle: { success: false, errorReason: 'INSUFFICIENT_FUNDS' },
  });
  const outcome = await exactTurnTwo(facilitator, 't-7');

  assert.equal(outcome.kind, 'halt', 'the turn must not proceed to the backend');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.FAILED);
  assert.equal(
    outcome.event.status.message?.metadata?.[X402_METADATA_KEYS.STATUS],
    X402_PAYMENT_STATUS.FAILED,
  );
});

test('a throwing settlement halts the turn rather than propagating', async () => {
  const facilitator = stubFacilitator({ settleThrows: true });
  const outcome = await exactTurnTwo(facilitator, 't-8');
  assert.equal(outcome.kind, 'halt');
});

// ── upto: metered settlement ──────────────────────────────────────────────

const UPTO_PRICING: X402Pricing = parseX402Pricing({
  scheme: 'upto',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: PAY_TO,
  maxAmount: '1000000', // 1 USDC ceiling
  rates: { input: '3000000', output: '15000000' }, // $3 / $15 per MTok
  facilitatorAddress: FACILITATOR,
})!;

/** A turn-2 message carrying a Permit2 witness — the `upto` signed shape. */
function uptoSubmissionMessage(
  requirement: Record<string, unknown>,
  overrides: { authorized?: string } = {},
): Message {
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: requirement as never,
    payload: {
      signature: `0x${'cd'.repeat(65)}`,
      permit2Authorization: {
        from: '0x2222222222222222222222222222222222222222',
        permitted: {
          token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: overrides.authorized ?? '1000000',
        },
        spender: '0x4444444444444444444444444444444444444444',
        nonce: `0x${'22'.repeat(32)}`,
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        witness: {
          to: PAY_TO,
          facilitator: FACILITATOR,
          validAfter: '0',
        },
      },
    },
  } as X402PaymentPayload;

  return userMessage({
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
    [X402_METADATA_KEYS.PAYLOAD]: payload,
  });
}

/** Run an upto round-trip to a verified payment, ready to settle. */
async function uptoVerified(
  facilitator: X402Facilitator,
  taskId: string,
  pricing: X402Pricing = UPTO_PRICING,
): Promise<{ gate: X402Gate; obligation: MerchantDeferredObligation }> {
  const gate = makeGate(facilitator, pricing);
  const first = await gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') throw new Error('unreachable');

  const second = await gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: uptoSubmissionMessage(offeredRequirement(first.event)),
  });
  assert.equal(second.kind, 'proceed', 'upto submission should verify');
  if (second.kind !== 'proceed' || second.settlement?.mode !== 'deferred') {
    throw new Error('a metered offering must defer settlement until after the work');
  }
  // Metered agents must not have moved money yet — the charge does not exist
  // until the work has been done.
  assert.equal((facilitator as { settleCalls?: number }).settleCalls, 0);
  return { gate, obligation: second.settlement.obligation };
}

test('an upto offering advertises the ceiling and the facilitator address', async () => {
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator, UPTO_PRICING);

  const outcome = await gate.open({
    taskId: 'u-1',
    contextId: 'ctx-u1',
    message: userMessage(),
  });
  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;

  const requirement = offeredRequirement(outcome.event);
  assert.equal(requirement.scheme, 'upto');
  // What the payer authorizes, not what they will be charged — the SDK
  // flattens the rate table back off the wire shape entirely.
  assert.equal(requirement.amount, '1000000');
  assert.equal(requirement.rates, undefined);
  assert.deepEqual(requirement.extra, { facilitatorAddress: FACILITATOR });
});

test('upto settles the metered charge, not the authorized ceiling', async () => {
  const facilitator = stubFacilitator();
  const { gate, obligation } = await uptoVerified(facilitator, 'u-2');

  // 100k in @ $3/MTok + 10k out @ $15/MTok = 450000 atomic, well under the
  // 1000000 ceiling the payer authorized.
  const result = await gate.settle({
    taskId: 'u-2',
    contextId: 'ctx-u-2',
    obligation,
    usage: { kind: 'detailed', inputTokens: 100_000, outputTokens: 10_000 },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '450000');
});

test('upto settles the floor when the backend reported no usage', async () => {
  // openclaw reports nothing at all — the `unreportedUsage: 'floor'` policy
  // the bridge maps every row with. Charging zero for delivered work is a
  // real loss, so an operator who sets minAmount gets that floor; charging
  // the authorized ceiling would be worse, billing the payer the maximum for
  // a gap in *our* instrumentation.
  const facilitator = stubFacilitator();
  const priced = parseX402Pricing({
    scheme: 'upto',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: PAY_TO,
    maxAmount: '1000000',
    rates: { input: '3000000', output: '15000000' },
    minAmount: '25000',
    facilitatorAddress: FACILITATOR,
  })!;
  const { gate, obligation } = await uptoVerified(facilitator, 'u-4', priced);

  const result = await gate.settle({
    taskId: 'u-4',
    contextId: 'ctx-u-4',
    obligation,
    usage: { kind: 'unreported' },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '25000');
});

test('upto with unreported usage and no floor settles zero rather than the ceiling', async () => {
  const facilitator = stubFacilitator();
  const { gate, obligation } = await uptoVerified(facilitator, 'u-5');

  const result = await gate.settle({
    taskId: 'u-5',
    contextId: 'ctx-u-5',
    obligation,
    usage: { kind: 'unreported' },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '0');
});

test('a trusted reported zero settles zero, not the floor', async () => {
  // The a2x#206 semantic change this migration ships: a backend that
  // *reported* zero consumption is believed, even when a floor is set. The
  // floor exists for work the bridge could not price, not as a minimum bill
  // for work the backend priced at nothing. Runtimes that emit {0,0} as an
  // "accounting dropped" sentinel now surface as `unreported` in
  // `readTaskUsage`'s callers only when they truly reported nothing.
  const facilitator = stubFacilitator();
  const priced = parseX402Pricing({
    scheme: 'upto',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: PAY_TO,
    maxAmount: '1000000',
    rates: { input: '3000000', output: '15000000' },
    minAmount: '25000',
    facilitatorAddress: FACILITATOR,
  })!;
  const { gate, obligation } = await uptoVerified(facilitator, 'u-zero', priced);

  const result = await gate.settle({
    taskId: 'u-zero',
    contextId: 'ctx-u-zero',
    obligation,
    usage: { kind: 'detailed', inputTokens: 0, outputTokens: 0 },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '0');
});

test('a failed deferred settlement replaces the terminal event', async () => {
  // The merchant was not paid, so the task must not report success — the
  // caller already has the output (nothing can be done about that under
  // `upto`), but the terminal state and receipt say what actually happened.
  const facilitator = stubFacilitator({
    settle: { success: false, errorReason: 'INSUFFICIENT_FUNDS' },
  });
  const { gate, obligation } = await uptoVerified(facilitator, 'u-fail');

  const result = await gate.settle({
    taskId: 'u-fail',
    contextId: 'ctx-u-fail',
    obligation,
    usage: { kind: 'detailed', inputTokens: 100, outputTokens: 100 },
  });

  assert.equal(result.kind, 'failed');
  if (result.kind !== 'failed') return;
  assert.equal(result.event.status.state, TaskState.FAILED);
  assert.equal(
    result.event.status.message?.metadata?.[X402_METADATA_KEYS.STATUS],
    X402_PAYMENT_STATUS.FAILED,
  );
});

test('an exact agent ignores usage and settles the signed amount', async () => {
  // Settled inside `open`, at the signed amount, with usage nowhere in play —
  // metering an `exact` requirement throws in the SDK.
  const facilitator = stubFacilitator();
  const outcome = await exactTurnTwo(facilitator, 'u-6');
  assert.equal(outcome.kind, 'proceed');
  if (outcome.kind !== 'proceed') return;
  assert.equal(outcome.settlement?.mode, 'settled');
  assert.equal(facilitator.settledAmount, '10000');
});

// ── the offering's terms are frozen across a reprice ──────────────────────

test('settlement prices from the offering, not from a reprice that landed between turns', async () => {
  // The freezing itself is the SDK offer store's contract; what this pins is the
  // bridge wiring around it — the executor rebuilds the gate when an admin
  // reprices, so turn 2 runs on a *different* gate instance over the same
  // store and offer store, and must still settle under turn 1's terms.
  const facilitator = stubFacilitator();
  const store = new InMemoryX402Store();
  const offerStore = new InMemoryMerchantOfferStore();
  const context = () => new X402Context({ store, facilitator, x402Version: 2 });

  const atOfferTime = new X402Gate('a1', UPTO_PRICING, context(), offerStore, RESOURCE);
  const first = await atOfferTime.open({
    taskId: 'reprice',
    contextId: 'ctx-reprice',
    message: userMessage(),
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  // Admin reprices to a flat fee. The executor rebuilds the gate on the next
  // turn, so turn 2 runs with entirely different live pricing.
  const afterReprice = new X402Gate('a1', PRICING, context(), offerStore, RESOURCE);
  const second = await afterReprice.open({
    taskId: 'reprice',
    contextId: 'ctx-reprice',
    message: uptoSubmissionMessage(offeredRequirement(first.event)),
  });
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed' || second.settlement?.mode !== 'deferred') return;

  // `open` hands back the frozen terms, not what the agent charges now — and
  // defers, because the offering was metered even though the agent is now
  // flat-fee. Settling here as `exact` would have charged the ceiling.
  assert.equal(second.settlement.obligation.pricing.scheme, 'upto');

  await afterReprice.settle({
    taskId: 'reprice',
    contextId: 'ctx-reprice',
    obligation: second.settlement.obligation,
    usage: { kind: 'detailed', inputTokens: 100_000, outputTokens: 10_000 },
  });

  // Metered under the frozen rates, not the 1000000 ceiling.
  assert.equal(facilitator.settledAmount, '450000');
});

test('publication is authorized against durable payment state and uncertain settlements survive cleanup', async () => {
  const store = new InMemoryX402Store();
  const facilitator = stubFacilitator({ settleThrows: true });
  const context = new X402Context({ store, facilitator, x402Version: 2 });
  const gate = new X402Gate('a1', PRICING, context, new InMemoryMerchantOfferStore(), RESOURCE);
  const first = await gate.open({ taskId: 'uncertain', contextId: 'ctx', message: userMessage() });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;
  const second = await gate.open({ taskId: 'uncertain', contextId: 'ctx',
    message: submissionMessage(offeredRequirement(first.event)) });
  assert.equal(second.kind, 'halt');
  assert.equal((await store.get('uncertain'))?.failure?.indeterminate, true);
  await gate.clear('uncertain');
  assert.ok(await store.get('uncertain'), 'indeterminate on-chain outcome must remain available for reconciliation');
  assert.equal((await gate.authorizeDelivery('uncertain', 'ctx'))?.status.state, TaskState.FAILED);
});

test('exact and upto authorize publication only after their payment round-trip', async () => {
  for (const pricing of [PRICING, UPTO_PRICING]) {
    const store = new InMemoryX402Store();
    const facilitator = stubFacilitator();
    const context = new X402Context({ store, facilitator, x402Version: 2 });
    const gate = new X402Gate('a1', pricing, context, new InMemoryMerchantOfferStore(), RESOURCE);
    const taskId = `delivery-${pricing.scheme}`;
    const first = await gate.open({ taskId, contextId: 'ctx', message: userMessage() });
    assert.equal(first.kind, 'halt');
    if (first.kind !== 'halt') return;
    assert.equal((await gate.authorizeDelivery(taskId, 'ctx'))?.status.state, TaskState.FAILED);
    const requirement = offeredRequirement(first.event);
    const second = await gate.open({ taskId, contextId: 'ctx', message: pricing.scheme === 'upto'
      ? uptoSubmissionMessage(requirement) : submissionMessage(requirement) });
    assert.equal(second.kind, 'proceed');
    assert.equal((await store.get(taskId))?.merchantDelivery?.publicationStartedAt, undefined);
    assert.equal(await gate.authorizeDelivery(taskId, 'ctx'), undefined);
    assert.ok((await store.get(taskId))?.merchantDelivery?.publicationStartedAt instanceof Date);
    assert.equal(facilitator.settleCalls, pricing.scheme === 'upto' ? 0 : 1);
    await gate.clear(taskId);
    assert.equal(await store.get(taskId), undefined);
    assert.equal(facilitator.settleCalls, pricing.scheme === 'upto' ? 0 : 1, 'cleanup does not adopt SDK partial-failure billing');
  }
});

test('accepted exact and upto tasks can deliver after the original offer signing deadline', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const agentId = `x402-late-output-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    for (const pricing of [PRICING, UPTO_PRICING]) {
      const store = new PostgresX402Store(sql, agentId);
      const facilitator = stubFacilitator();
      const context = new X402Context({ store, facilitator, x402Version: 2 });
      const gate = new X402Gate(agentId, pricing, context, store, RESOURCE);
      const taskId = `late-${pricing.scheme}`;
      const first = await gate.open({ taskId, contextId: 'ctx', message: userMessage() });
      assert.equal(first.kind, 'halt');
      if (first.kind !== 'halt') continue;
      const signingDeadline = new Date(Date.now() + 1_000);
      await store.put({ ...(await store.get(taskId))!, expiresAt: signingDeadline });
      const requirement = offeredRequirement(first.event);
      const second = await gate.open({ taskId, contextId: 'ctx', message: pricing.scheme === 'upto'
        ? uptoSubmissionMessage(requirement) : submissionMessage(requirement) });
      assert.equal(second.kind, 'proceed');
      if (second.kind !== 'proceed') continue;
      assert.ok((await store.get(taskId))!.expiresAt!.getTime() > signingDeadline.getTime());
      assert.equal((await store.get(taskId))?.merchantDelivery?.publicationStartedAt, undefined);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, signingDeadline.getTime() - Date.now()) + 20));
      assert.equal(await gate.authorizeDelivery(taskId, 'ctx'), undefined, 'the first output remains deliverable after offer expiry');
      assert.ok((await store.get(taskId))?.merchantDelivery?.publicationStartedAt);
      if (second.settlement?.mode === 'deferred') {
        assert.ok(await store.getOffer(taskId), 'accepted metered terms remain available');
        const result = await gate.settle({ taskId, contextId: 'ctx', obligation: second.settlement.obligation,
          usage: { kind: 'unreported' } });
        assert.equal(result.kind, 'settled');
      }
      assert.equal(facilitator.settleCalls, 1);
      await gate.clear(taskId);
      assert.equal(await store.get(taskId), undefined);
    }
  } finally {
    await sql`DELETE FROM x402_offerings WHERE agent_id = ${agentId}`;
    await sql.end();
  }
});

test('unpaid retries cannot replace an accepted metered payment before its first output', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const agentId = `x402-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const store = new PostgresX402Store(sql, agentId);
    const facilitator = stubFacilitator();
    const context = new X402Context({ store, facilitator, x402Version: 2 });
    const gate = new X402Gate(agentId, UPTO_PRICING, context, store, RESOURCE);
    const taskId = 'accepted';
    const first = await gate.open({ taskId, contextId: 'ctx', message: userMessage() });
    assert.equal(first.kind, 'halt');
    if (first.kind !== 'halt') return;
    const accepted = await gate.open({ taskId, contextId: 'ctx',
      message: uptoSubmissionMessage(offeredRequirement(first.event)) });
    assert.equal(accepted.kind, 'proceed');
    const before = await store.get(taskId);
    assert.equal(before?.status, 'verified');
    for (const staleHint of [false, true]) {
      // Model a retry that read the replay hint just before the first claim.
      if (staleHint) store.getClaimStatus = async () => 'available';
      const retry = await gate.open({ taskId, contextId: 'ctx', message: userMessage() });
      assert.equal(retry.kind, 'halt');
      if (retry.kind === 'halt') assert.equal(retry.event.status.state, TaskState.FAILED);
      assert.deepEqual(await store.get(taskId), before, 'retry retains lifecycle and retention');
    }
    assert.equal(await gate.authorizeDelivery(taskId, 'ctx'), undefined);
    assert.equal(facilitator.verifyCalls, 1);
    if (accepted.kind === 'proceed' && accepted.settlement?.mode === 'deferred') {
      const settled = await gate.settle({ taskId, contextId: 'ctx', obligation: accepted.settlement.obligation,
        usage: { kind: 'unreported' } });
      assert.equal(settled.kind, 'settled');
    }
    assert.equal(facilitator.settleCalls, 1);
  } finally {
    await sql`DELETE FROM x402_offerings WHERE agent_id = ${agentId}`;
    await sql.end();
  }
});


test('a losing verification cannot invalidate accepted metered work', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const agentId = `x402-verify-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const store = new PostgresX402Store(sql, agentId);
  let release!: () => void, entered!: () => void;
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const losingFacilitator = stubFacilitator();
  losingFacilitator.verify = async () => {
    entered();
    await ready;
    return { isValid: false, invalidReason: 'invalid signature' };
  };
  const facilitator = stubFacilitator();
  const gate = new X402Gate(agentId, UPTO_PRICING,
    new X402Context({ store, facilitator, x402Version: 2 }), store, RESOURCE);
  const losingGate = new X402Gate(agentId, UPTO_PRICING,
    new X402Context({ store, facilitator: losingFacilitator, x402Version: 2 }), store, RESOURCE);
  let losing: Promise<X402GateOutcome> | undefined;
  try {
    const taskId = 'verification-race';
    const first = await gate.open({ taskId, contextId: 'ctx', message: userMessage() });
    assert.equal(first.kind, 'halt');
    if (first.kind !== 'halt') return;
    const message = uptoSubmissionMessage(offeredRequirement(first.event));
    losing = losingGate.open({ taskId, contextId: 'ctx', message });
    await verifying;
    const accepted = await gate.open({ taskId, contextId: 'ctx', message });
    assert.equal(accepted.kind, 'proceed');
    const before = await store.get(taskId);
    release();
    const refused = await losing;
    assert.equal(refused.kind, 'halt');
    if (refused.kind === 'halt') assert.equal(refused.event.status.state, TaskState.FAILED);
    assert.deepEqual(await store.get(taskId), before, 'losing verification cannot overwrite accepted state');
    assert.equal(await gate.authorizeDelivery(taskId, 'ctx'), undefined);
    if (accepted.kind === 'proceed' && accepted.settlement?.mode === 'deferred') {
      const result = await gate.settle({ taskId, contextId: 'ctx', obligation: accepted.settlement.obligation,
        usage: { kind: 'unreported' } });
      assert.equal(result.kind, 'settled');
    }
    assert.equal(facilitator.settleCalls, 1);
    assert.equal(losingFacilitator.settleCalls, 0);
  } finally {
    release();
    await losing;
    await sql`DELETE FROM x402_offerings WHERE agent_id = ${agentId}`;
    await sql.end();
  }
});
