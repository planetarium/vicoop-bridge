import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskState, type Message } from '@a2x/sdk';
import {
  X402Context,
  InMemoryX402Store,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402Facilitator,
  type X402PaymentPayload,
  type X402ValidClassification,
  type X402VerifyResponse,
  type X402FacilitatorSettleResponse,
} from '@a2x/sdk/x402';
import { X402Gate } from './gate.js';
import { parseX402Pricing, type X402Pricing } from './pricing.js';
import type { TaskUsage } from './usage.js';

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

function makeGate(facilitator: X402Facilitator, pricing: X402Pricing = PRICING): X402Gate {
  return new X402Gate(
    'a1',
    pricing,
    new X402Context({ store: new InMemoryX402Store(), facilitator, x402Version: 2 }),
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
    resource: RESOURCE,
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
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 't-2',
    contextId: 'ctx-2',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });

  assert.equal(second.kind, 'proceed');
  assert.equal(facilitator.verifyCalls, 1);
  // Verification alone must not move money — settlement waits for the work.
  assert.equal(facilitator.settleCalls, 0);
});

test('a submission whose taskId was never offered is refused', async () => {
  // The horizontally-scaled failure mode this store exists to prevent: if the
  // offering is missing, the payload must be refused rather than trusted.
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const offering = await gate.open({
    taskId: 't-known',
    contextId: 'ctx',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(offering.kind, 'halt');
  if (offering.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-unknown',
    contextId: 'ctx',
    message: submissionMessage(offeredRequirement(offering.event)),
    resource: RESOURCE,
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
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-3',
    contextId: 'ctx-3',
    message: submissionMessage(offeredRequirement(first.event), {
      to: '0x9999999999999999999999999999999999999999',
    }),
    resource: RESOURCE,
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
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-4',
    contextId: 'ctx-4',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
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
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const outcome = await gate.open({
    taskId: 't-5',
    contextId: 'ctx-5',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });

  // The important part is that it is NOT 'proceed' — an unpaid call must
  // never reach the agent because the payment rail was unavailable.
  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;
  assert.equal(outcome.event.status.state, TaskState.FAILED);
});

test('settle attaches the receipt metadata on success', async () => {
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-6',
    contextId: 'ctx-6',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 't-6',
    contextId: 'ctx-6',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed' || !second.classified) return;

  const result = await gate.settle({
    taskId: 't-6',
    contextId: 'ctx-6',
    classified: second.classified,
  });

  assert.equal(result.kind, 'settled');
  if (result.kind !== 'settled') return;
  assert.equal(result.metadata[X402_METADATA_KEYS.STATUS], X402_PAYMENT_STATUS.COMPLETED);
  const receipts = result.metadata[X402_METADATA_KEYS.RECEIPTS] as { transaction: string }[];
  assert.equal(receipts[0]!.transaction, '0xdeadbeef');
  assert.equal(facilitator.settleCalls, 1);
});

test('a failed settlement replaces the terminal event so the task cannot report success', async () => {
  const facilitator = stubFacilitator({
    settle: { success: false, errorReason: 'INSUFFICIENT_FUNDS' },
  });
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-7',
    contextId: 'ctx-7',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 't-7',
    contextId: 'ctx-7',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed' || !second.classified) return;

  const result = await gate.settle({
    taskId: 't-7',
    contextId: 'ctx-7',
    classified: second.classified,
  });

  assert.equal(result.kind, 'failed');
  if (result.kind !== 'failed') return;
  assert.equal(result.event.status.state, TaskState.FAILED);
  assert.equal(
    result.event.status.message?.metadata?.[X402_METADATA_KEYS.STATUS],
    X402_PAYMENT_STATUS.FAILED,
  );
});

test('a throwing settlement is reported as a failure, not propagated', async () => {
  const facilitator = stubFacilitator({ settleThrows: true });
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 't-8',
    contextId: 'ctx-8',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 't-8',
    contextId: 'ctx-8',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed' || !second.classified) return;

  const result = await gate.settle({
    taskId: 't-8',
    contextId: 'ctx-8',
    classified: second.classified,
  });
  assert.equal(result.kind, 'failed');
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
): Promise<{ gate: X402Gate; classified: X402ValidClassification }> {
  const gate = makeGate(facilitator, pricing);
  const first = await gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') throw new Error('unreachable');

  const second = await gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: uptoSubmissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });
  assert.equal(second.kind, 'proceed', 'upto submission should verify');
  if (second.kind !== 'proceed' || !second.classified) throw new Error('unreachable');
  return { gate, classified: second.classified };
}

test('an upto offering advertises the ceiling and the facilitator address', async () => {
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator, UPTO_PRICING);

  const outcome = await gate.open({
    taskId: 'u-1',
    contextId: 'ctx-u1',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(outcome.kind, 'halt');
  if (outcome.kind !== 'halt') return;

  const requirement = offeredRequirement(outcome.event);
  assert.equal(requirement.scheme, 'upto');
  assert.equal(requirement.amount, '1000000');
  assert.deepEqual(requirement.extra, { facilitatorAddress: FACILITATOR });
});

test('upto settles the metered charge, not the authorized ceiling', async () => {
  const facilitator = stubFacilitator();
  const { gate, classified } = await uptoVerified(facilitator, 'u-2');

  // 100k in @ $3/MTok + 10k out @ $15/MTok = 450000 atomic, well under the
  // 1000000 ceiling the payer authorized.
  const usage: TaskUsage = {
    prompt_tokens: 100_000,
    completion_tokens: 10_000,
    total_tokens: 110_000,
  };
  const result = await gate.settle({
    taskId: 'u-2',
    contextId: 'ctx-u-2',
    classified,
    usage,
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '450000');
});

test('a metered charge above the ceiling is clamped down to it', async () => {
  const facilitator = stubFacilitator();
  const { gate, classified } = await uptoVerified(facilitator, 'u-3');

  // 10M input tokens prices to 30000000 — 30x the authorized ceiling. The
  // SDK clamps, which is what makes a pricing mistake unable to overcharge.
  const result = await gate.settle({
    taskId: 'u-3',
    contextId: 'ctx-u-3',
    classified,
    usage: { prompt_tokens: 10_000_000, completion_tokens: 0, total_tokens: 10_000_000 },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '1000000');
});

test('upto settles the floor when the backend reported no usage', async () => {
  // openclaw reports nothing; codex can emit {0,0,0} when its runtime drops
  // accounting. Charging zero for delivered work is a real loss, so an
  // operator who sets minAmount gets that instead.
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
  const { gate, classified } = await uptoVerified(facilitator, 'u-4', priced);

  const result = await gate.settle({
    taskId: 'u-4',
    contextId: 'ctx-u-4',
    classified,
    usage: undefined,
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '25000');
});

test('upto with no usage and no floor settles zero rather than the ceiling', async () => {
  // The default direction is payer-favourable on purpose: billing the
  // maximum because *our* instrumentation lost the token count would be a
  // user-visible wrong, where undercharging is our own loss to fix.
  const facilitator = stubFacilitator();
  const { gate, classified } = await uptoVerified(facilitator, 'u-5');

  const result = await gate.settle({
    taskId: 'u-5',
    contextId: 'ctx-u-5',
    classified,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '0');
});

test('an exact agent ignores usage and settles the signed amount', async () => {
  // Metering an `exact` requirement throws in the SDK, so the gate must not
  // pass an amount through for a flat-fee agent even when usage is present.
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 'u-6',
    contextId: 'ctx-u-6',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 'u-6',
    contextId: 'ctx-u-6',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed' || !second.classified) return;

  const result = await gate.settle({
    taskId: 'u-6',
    contextId: 'ctx-u-6',
    classified: second.classified,
    usage: { prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 },
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '10000');
});

test('the gate reports whether it meters, so the executor knows to read usage', () => {
  assert.equal(makeGate(stubFacilitator(), UPTO_PRICING).metered, true);
  assert.equal(makeGate(stubFacilitator()).metered, false);
});
