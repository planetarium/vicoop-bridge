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
import { X402Gate, type X402GateOutcome, type X402OfferingSidecar } from './gate.js';
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

/**
 * In-memory stand-in for the Postgres sidecar: the pricing snapshot taken when
 * an offering is published, and the one-shot claim that stops a replayed
 * submission from running the work twice.
 */
interface MemorySidecar extends X402OfferingSidecar {
  /** Test hook: force the stored terms out of step with the offering. */
  overwritePricing(taskId: string, pricing: X402Pricing): void;
}

function memorySidecar(): MemorySidecar {
  const pricingByTask = new Map<string, X402Pricing>();
  const claimed = new Set<string>();
  return {
    // The real store records the terms in the same statement as the offering;
    // recording them here on entry is the equivalent for a double.
    async publishing<T>(taskId: string, pricing: X402Pricing, fn: () => Promise<T>): Promise<T> {
      pricingByTask.set(taskId, pricing);
      return fn();
    },
    async getPricing(taskId) {
      return pricingByTask.get(taskId);
    },
    async claim(taskId) {
      if (claimed.has(taskId)) return false;
      claimed.add(taskId);
      return true;
    },
    overwritePricing(taskId, pricing) {
      pricingByTask.set(taskId, pricing);
    },
  };
}

function makeGate(
  facilitator: X402Facilitator,
  pricing: X402Pricing = PRICING,
  sidecar: X402OfferingSidecar = memorySidecar(),
): X402Gate {
  return new X402Gate(
    'a1',
    pricing,
    new X402Context({ store: new InMemoryX402Store(), facilitator, x402Version: 2 }),
    sidecar,
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
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') throw new Error('unreachable');
  return gate.open({
    taskId,
    contextId: `ctx-${taskId}`,
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
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
): Promise<{ gate: X402Gate; classified: X402ValidClassification; pricing: X402Pricing }> {
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
  if (second.kind !== 'proceed' || second.settlement?.mode !== 'deferred') {
    throw new Error('a metered offering must defer settlement until after the work');
  }
  // Metered agents must not have moved money yet — the charge does not exist
  // until the work has been done.
  assert.equal((facilitator as { settleCalls?: number }).settleCalls, 0);
  return {
    gate,
    classified: second.settlement.classified,
    pricing: second.settlement.pricing,
  };
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
  const { gate, classified, pricing } = await uptoVerified(facilitator, 'u-2');

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
    pricing,
    usage,
  });

  assert.equal(result.kind, 'settled');
  assert.equal(facilitator.settledAmount, '450000');
});

test('a metered charge above the ceiling is clamped down to it', async () => {
  const facilitator = stubFacilitator();
  const { gate, classified, pricing } = await uptoVerified(facilitator, 'u-3');

  // 10M input tokens prices to 30000000 — 30x the authorized ceiling. The
  // SDK clamps, which is what makes a pricing mistake unable to overcharge.
  const result = await gate.settle({
    taskId: 'u-3',
    contextId: 'ctx-u-3',
    classified,
    pricing,
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
  const { gate, classified, pricing } = await uptoVerified(facilitator, 'u-4', priced);

  const result = await gate.settle({
    taskId: 'u-4',
    contextId: 'ctx-u-4',
    classified,
    pricing,
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
  const { gate, classified, pricing } = await uptoVerified(facilitator, 'u-5');

  const result = await gate.settle({
    taskId: 'u-5',
    contextId: 'ctx-u-5',
    classified,
    pricing,
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
  // Settled inside `open`, at the signed amount, with usage nowhere in play —
  // metering an `exact` requirement throws in the SDK.
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed') return;
  assert.equal(second.settlement?.mode, 'settled');
  assert.equal(facilitator.settledAmount, '10000');
});

// ── the offering's terms are frozen, and usable once ──────────────────────

test('settlement prices from the offering, not from a reprice that landed between turns', async () => {
  // The two turns are separate requests, so the agent can be repriced in
  // between. Settling from live pricing would meter turn 2 against terms turn
  // 1 never signed — and when an `upto` offering met `exact` pricing, the
  // metering branch was skipped and the SDK settled the full authorized
  // ceiling instead of the metered charge.
  const facilitator = stubFacilitator();
  const store = new InMemoryX402Store();
  const sidecar = memorySidecar();
  const context = () =>
    new X402Context({ store, facilitator, x402Version: 2 });

  const atOfferTime = new X402Gate('a1', UPTO_PRICING, context(), sidecar);
  const first = await atOfferTime.open({
    taskId: 'reprice',
    contextId: 'ctx-reprice',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  // Admin reprices to a flat fee. The executor rebuilds the gate on the next
  // turn, so turn 2 runs with entirely different live pricing.
  const afterReprice = new X402Gate('a1', PRICING, context(), sidecar);
  const second = await afterReprice.open({
    taskId: 'reprice',
    contextId: 'ctx-reprice',
    message: uptoSubmissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });
  assert.equal(second.kind, 'proceed');
  if (second.kind !== 'proceed' || second.settlement?.mode !== 'deferred') return;

  // `open` hands back the frozen terms, not what the agent charges now — and
  // defers, because the offering was metered even though the agent is now
  // flat-fee. Settling here as `exact` would have charged the ceiling.
  assert.equal(second.settlement.pricing.scheme, 'upto');

  await afterReprice.settle({
    taskId: 'reprice',
    contextId: 'ctx-reprice',
    classified: second.settlement.classified,
    pricing: second.settlement.pricing,
    usage: { prompt_tokens: 100_000, completion_tokens: 10_000, total_tokens: 110_000 },
  });

  // Metered, not the 1000000 ceiling the old code would have settled.
  assert.equal(facilitator.settledAmount, '450000');
});

test('a replayed submission is refused instead of running the work twice', async () => {
  // `classify()` does not inspect the entry's status, so the same signed
  // payload classifies valid every time it is sent. Without the claim the
  // backend would run again for one authorization.
  const facilitator = stubFacilitator();
  const gate = makeGate(facilitator);

  const first = await gate.open({
    taskId: 'replay',
    contextId: 'ctx-replay',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const submission = submissionMessage(offeredRequirement(first.event));
  const attempt = () =>
    gate.open({
      taskId: 'replay',
      contextId: 'ctx-replay',
      message: submission,
      resource: RESOURCE,
    });

  assert.equal((await attempt()).kind, 'proceed');

  const replay = await attempt();
  assert.equal(replay.kind, 'halt');
  if (replay.kind !== 'halt') return;
  assert.equal(replay.event.status.state, TaskState.FAILED);
  // The claim is taken before verify, so the replay costs no facilitator call.
  assert.equal(facilitator.verifyCalls, 1);
});

test('a snapshot that disagrees with the signed requirement is refused, not silently unmetered', async () => {
  // Concurrent turn-1s racing a reprice can leave the offering and the
  // snapshot describing different schemes. Merely skipping the metering
  // branch is the expensive failure: an `upto` requirement with no amount
  // settles the full authorized ceiling.
  const facilitator = stubFacilitator();
  const store = new InMemoryX402Store();
  const sidecar = memorySidecar();

  // Publish an `upto` offering, then corrupt the snapshot to `exact`.
  const gate = new X402Gate(
    'a1',
    UPTO_PRICING,
    new X402Context({ store, facilitator, x402Version: 2 }),
    sidecar,
  );
  const first = await gate.open({
    taskId: 'mismatch',
    contextId: 'ctx-mismatch',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;
  sidecar.overwritePricing('mismatch', PRICING);

  const second = await gate.open({
    taskId: 'mismatch',
    contextId: 'ctx-mismatch',
    message: uptoSubmissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });

  assert.equal(second.kind, 'halt');
  if (second.kind !== 'halt') return;
  assert.equal(second.event.status.state, TaskState.FAILED);
  assert.equal(facilitator.verifyCalls, 0, 'refused before the facilitator is involved');
  assert.equal(facilitator.settleCalls, 0);
});

test('a missing pricing snapshot refuses the call rather than guessing a price', async () => {
  // Written in the same breath as the offering, so absence means corruption.
  // Falling back to live pricing here is exactly the bug the snapshot exists
  // to prevent, so the safe direction is to refuse.
  const facilitator = stubFacilitator();
  const sidecar = memorySidecar();
  const forgetful: X402OfferingSidecar = {
    publishing: (_t, _p, fn) => fn(),
    getPricing: async () => undefined,
    claim: (taskId) => sidecar.claim(taskId),
  };
  const gate = makeGate(facilitator, PRICING, forgetful);

  const first = await gate.open({
    taskId: 'no-snapshot',
    contextId: 'ctx-no-snapshot',
    message: userMessage(),
    resource: RESOURCE,
  });
  assert.equal(first.kind, 'halt');
  if (first.kind !== 'halt') return;

  const second = await gate.open({
    taskId: 'no-snapshot',
    contextId: 'ctx-no-snapshot',
    message: submissionMessage(offeredRequirement(first.event)),
    resource: RESOURCE,
  });

  assert.equal(second.kind, 'halt');
  if (second.kind !== 'halt') return;
  assert.equal(second.event.status.state, TaskState.FAILED);
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settleCalls, 0);
});
