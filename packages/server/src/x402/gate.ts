import {
  X402Context,
  X402_FOUNDATION_EXTENSION_URI,
  requirementScheme,
  type BaseX402Context,
  type X402ValidClassification,
  type X402SettleResponse,
} from '@a2x/sdk/x402';
import { TaskState, type Message, type TaskStatusUpdateEvent } from '@a2x/sdk';
import type { Sql } from '../db.js';
import { logEvent } from '../log.js';
import { PostgresX402Store } from './store.js';
import { meterUsage, pricingToAccepts, type X402Pricing } from './pricing.js';
import type { TaskUsage } from './usage.js';

export { X402_FOUNDATION_EXTENSION_URI };

// The x402 wire version this deployment emits. V2 is the x402 Foundation
// A2A transport — CAIP-2 networks, top-level `resource`, and the only version
// that has the usage-based `upto` scheme at all. The SDK still defaults to V1
// for compatibility with the older reference lineage, so we opt in explicitly
// and leave an escape hatch for a deployment that has to serve V1-only
// clients — one that an `upto` agent cannot use.
const X402_VERSION: 1 | 2 = process.env.BRIDGE_X402_VERSION === '1' ? 1 : 2;

// How long a payer has to sign and resubmit before the offering lapses. Past
// it the store reports no offering and the submission is refused — the payer
// is never charged for a lapsed offer, they just have to start over.
const OFFERING_TTL_SECONDS = (() => {
  const raw = process.env.BRIDGE_X402_OFFER_TTL_SECONDS;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
})();

/**
 * Build the payment context this deployment runs on: offerings in Postgres,
 * settlement through the configured facilitator (the SDK's hosted default
 * when `BRIDGE_X402_FACILITATOR_URL` is unset).
 *
 * Separate from `X402Gate` so tests can drive the gate with an in-memory
 * store and a stub facilitator instead of a database and a live chain.
 */
export function createPostgresX402Context(
  sql: Sql,
  agentId: string,
): { context: X402Context; sidecar: X402OfferingSidecar } {
  const url = process.env.BRIDGE_X402_FACILITATOR_URL;
  const store = new PostgresX402Store(sql, agentId);
  return {
    context: new X402Context({
      store,
      x402Version: X402_VERSION,
      ...(url ? { facilitator: { url } } : {}),
    }),
    // Same instance: the sidecar rows live on the offering row, so they share
    // the store's agent scoping rather than re-deriving it.
    sidecar: store,
  };
}

/**
 * Outcome of running the payment gate on an inbound turn.
 *
 * - `proceed` — nothing to charge for, or the payment verified. Run the work.
 *   `classified` is present exactly when a settlement is owed afterwards.
 * - `halt` — emit `event` and end the turn. Either the payment was requested
 *   (`input-required`, awaiting the client's signed resubmission) or it was
 *   refused (`failed`).
 */
export type X402GateOutcome =
  | {
      kind: 'proceed';
      classified?: X402ValidClassification;
      /**
       * The pricing the offering was published under, read back from the
       * store. Settlement uses this, never the agent's live pricing — the two
       * turns are separate requests and a reprice in between would otherwise
       * meter against terms the payer never signed.
       */
      pricing?: X402Pricing;
    }
  | { kind: 'halt'; event: TaskStatusUpdateEvent };

export interface X402GateParams {
  taskId: string;
  contextId: string;
  message: Message;
  /** Public URL of the agent being paid for — shown in the payer's wallet. */
  resource: string;
}

/**
 * Server-side x402 payment gate for one agent.
 *
 * Sits in front of `WSForwardingExecutor`'s forwarding path and implements
 * the merchant half of the x402 A2A round-trip:
 *
 *   turn 1  unpaid request      → `input-required` + `x402.payment.required`
 *   turn 2  signed resubmission → verify → forward to the agent → settle
 *
 * The bridge drives this through the SDK's `X402Context` rather than the
 * `BaseAgent.run()` path the SDK documents, because `WSForwardingExecutor`
 * overrides `execute`/`executeStream` outright — there is no in-process agent
 * to host the flow. `X402Context`'s methods take a structural
 * `{ taskId, message }`, so they compose with a custom executor unchanged;
 * only the events need translating, which `haltEvent` does.
 *
 * Settlement is deliberately deferred until the agent has finished
 * successfully: payment buys delivered work, so a task that fails or is
 * cancelled is never settled and the payer's signed authorization simply goes
 * unused. Under `upto` that deferral is also what makes metering possible —
 * the token counts only exist once the work is done.
 */
/**
 * The per-offering state the bridge keeps alongside the SDK's entry: the
 * pricing an offering was published under, and a one-shot claim.
 *
 * Separate from `BaseX402Store` because the SDK owns that shape, and separate
 * from the gate's constructor argument so tests can drive the round-trip
 * without a database.
 */
export interface X402OfferingSidecar {
  putPricing(taskId: string, pricing: X402Pricing): Promise<void>;
  getPricing(taskId: string): Promise<X402Pricing | undefined>;
  /** `true` for the one caller that wins the right to act on a submission. */
  claim(taskId: string): Promise<boolean>;
}

export class X402Gate {
  constructor(
    private readonly agentId: string,
    private readonly pricing: X402Pricing,
    private readonly x402: BaseX402Context,
    private readonly sidecar: X402OfferingSidecar,
  ) {}

  /**
   * Scheme-independent description of an offering, for logs. Under `upto` the
   * amount is the authorized ceiling, so it is labelled as such rather than
   * reported as a price that will be charged.
   */
  private offeringFields(pricing: X402Pricing): Record<string, string> {
    return pricing.scheme === 'upto'
      ? {
          scheme: 'upto',
          ceiling: pricing.maxAmount,
          network: pricing.network,
          asset: pricing.asset,
        }
      : {
          scheme: 'exact',
          amount: pricing.amount,
          network: pricing.network,
          asset: pricing.asset,
        };
  }

  /**
   * Classify the inbound turn and either request payment, refuse it, or clear
   * the request to run.
   *
   * Facilitator or store failures resolve to a `halt` rather than throwing:
   * an unpaid request must never fall through to the agent, so the safe
   * direction on an unexpected error is to refuse the call.
   */
  async open(params: X402GateParams): Promise<X402GateOutcome> {
    const { taskId, contextId, message, resource } = params;
    const ctx = { taskId, message };

    // `upto` exists only in x402 V2. The SDK would throw from
    // `requestPayment`, which the catch below would report as a transient
    // outage — misleading for what is a permanent misconfiguration.
    if (this.pricing.scheme === 'upto' && X402_VERSION === 1) {
      logEvent('x402_config_invalid', {
        agentId: this.agentId,
        taskId,
        reason: 'upto pricing requires x402 V2, but BRIDGE_X402_VERSION is 1',
      });
      return {
        kind: 'halt',
        event: this.failedEvent({
          taskId,
          contextId,
          code: 'invalid_x402_version',
          reason: 'Metered pricing requires x402 V2, which this deployment does not serve.',
        }),
      };
    }

    try {
      const classified = await this.x402.classify(ctx);

      if (classified.kind === 'no-submission') {
        // Turn 1. `requestPayment` persists the offering (status `offered`,
        // with the TTL) and yields the `request-input` event we translate.
        const accepts = pricingToAccepts(this.pricing, resource);
        let metadata: Record<string, unknown> | undefined;
        let text: string | undefined;
        for await (const event of this.x402.requestPayment(ctx, {
          accepts,
          expiresInSeconds: OFFERING_TTL_SECONDS,
        })) {
          if (event.type === 'request-input') {
            metadata = event.metadata;
            text = event.message;
          }
        }
        if (metadata === undefined) {
          // `requestPayment` always yields a `request-input`; reaching here
          // means the SDK contract changed under us. Refuse rather than
          // silently serve the call for free.
          throw new Error('x402 requestPayment yielded no request-input event');
        }
        // Freeze the terms alongside the offering. Turn 2 settles from this,
        // so a reprice between the turns cannot change what the payer is
        // charged for a requirement they already signed.
        await this.sidecar.putPricing(taskId, this.pricing);
        logEvent('x402_payment_required', {
          agentId: this.agentId,
          taskId,
          ...this.offeringFields(this.pricing),
        });
        return {
          kind: 'halt',
          event: this.statusEvent({
            taskId,
            contextId,
            state: TaskState.INPUT_REQUIRED,
            text: text ?? 'Payment required to invoke this agent.',
            metadata,
          }),
        };
      }

      if (classified.kind !== 'valid') {
        // `classify` has already recorded the failure on the store entry.
        logEvent('x402_payment_refused', {
          agentId: this.agentId,
          taskId,
          reason: classified.kind,
          code: classified.code,
        });
        return {
          kind: 'halt',
          event: this.failedEvent({
            taskId,
            contextId,
            code: classified.code,
            reason: classified.reason,
          }),
        };
      }

      // One submission, one execution. `classify` above does not inspect the
      // entry's status, so a replayed `payment-submitted` classifies valid
      // every time; without this the backend would run the work again for the
      // same authorization. The claim is never released — see `claim`.
      if (!(await this.sidecar.claim(taskId))) {
        logEvent('x402_submission_replayed', { agentId: this.agentId, taskId });
        return {
          kind: 'halt',
          event: this.failedEvent({
            taskId,
            contextId,
            code: 'DUPLICATE_NONCE',
            reason: 'This payment has already been submitted for this task.',
          }),
        };
      }

      // Terms are the ones the offering was published under, not whatever the
      // agent charges right now.
      const settlementPricing = await this.sidecar.getPricing(taskId);
      if (settlementPricing === undefined) {
        // Written in the same breath as the offering, so this is corruption
        // rather than a normal state. Refuse instead of guessing a price.
        logEvent('x402_pricing_snapshot_missing', { agentId: this.agentId, taskId });
        return {
          kind: 'halt',
          event: this.failedEvent({
            taskId,
            contextId,
            code: 'SETTLEMENT_FAILED',
            reason: 'The terms this payment was offered under are no longer available.',
          }),
        };
      }

      const verify = await this.x402.verify(ctx, classified);
      if (!verify.isValid) {
        const reason = verify.invalidReason ?? 'Payment verification failed.';
        logEvent('x402_verify_failed', { agentId: this.agentId, taskId, reason });
        return {
          kind: 'halt',
          event: this.failedEvent({
            taskId,
            contextId,
            code: 'VERIFY_FAILED',
            reason,
          }),
        };
      }

      logEvent('x402_payment_verified', {
        agentId: this.agentId,
        taskId,
        ...this.offeringFields(settlementPricing),
      });
      return { kind: 'proceed', classified, pricing: settlementPricing };
    } catch (err) {
      // Facilitator unreachable, DB down, malformed offering — fail closed.
      logEvent('x402_gate_error', {
        agentId: this.agentId,
        taskId,
        error: String(err),
      });
      return {
        kind: 'halt',
        event: this.failedEvent({
          taskId,
          contextId,
          code: 'SETTLEMENT_FAILED',
          reason: 'Payment processing is temporarily unavailable.',
        }),
      };
    }
  }

  /**
   * Settle a verified payment after the agent completed the work.
   *
   * Under `exact` the charge is the amount the payer already signed for and
   * `usage` is ignored. Under `upto` the charge is metered from `usage` and
   * the SDK clamps it down to the minimum of the metered value, the offered
   * ceiling, and the payer's signed cap — so a pricing or metering mistake
   * here can only ever undercharge.
   *
   * Returns metadata to merge onto the task's final status message on
   * success, or a replacement terminal event when settlement failed — the
   * merchant was not paid, so the task must not report success.
   */
  async settle(params: {
    taskId: string;
    contextId: string;
    classified: X402ValidClassification;
    /** The offering's frozen terms, from `open`. Never the live pricing. */
    pricing: X402Pricing;
    usage?: TaskUsage | undefined;
  }): Promise<
    | { kind: 'settled'; metadata: Record<string, unknown> }
    | { kind: 'failed'; event: TaskStatusUpdateEvent }
  > {
    const { taskId, contextId, classified, pricing, usage } = params;
    const ctx = { taskId };

    // Metering an `exact` requirement throws in the SDK — the signature binds
    // it to one value — so the option is only ever passed for `upto`.
    //
    // Gated on the *requirement* the payer actually signed as well as on the
    // snapshot: the two agree by construction, and requiring both means no
    // single stale value can send a metered amount at an exact signature or
    // vice versa.
    let settleOpts: { amountAtomic?: string } | undefined;
    if (pricing.scheme === 'upto' && requirementScheme(classified.requirement) === 'upto') {
      const charge = meterUsage(pricing, usage);
      settleOpts = { amountAtomic: charge.amountAtomic };
      logEvent('x402_metered', {
        agentId: this.agentId,
        taskId,
        basis: charge.basis,
        amount: charge.amountAtomic,
        ceiling: pricing.maxAmount,
        ...(usage !== undefined
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              ...(usage.cached_tokens !== undefined ? { cachedTokens: usage.cached_tokens } : {}),
              ...(usage.model !== undefined ? { model: usage.model } : {}),
            }
          : {}),
      });
      if (charge.basis === 'no-usage') {
        // Loud on purpose: the backend delivered work the bridge could not
        // price. Either the runtime dropped its accounting (codex #351) or
        // the backend has none at all (openclaw), and both mean this agent
        // is being given away at `minAmount` on every such call.
        logEvent('x402_usage_unavailable', {
          agentId: this.agentId,
          taskId,
          charged: charge.amountAtomic,
        });
      }
    }

    let receipt: X402SettleResponse;
    try {
      receipt = await this.x402.settle(ctx, classified, settleOpts);
    } catch (err) {
      logEvent('x402_settle_error', {
        agentId: this.agentId,
        taskId,
        error: String(err),
      });
      return {
        kind: 'failed',
        event: this.failedEvent({
          taskId,
          contextId,
          code: 'SETTLEMENT_FAILED',
          reason: 'Payment settlement failed.',
        }),
      };
    }

    if (!receipt.success) {
      logEvent('x402_settle_failed', {
        agentId: this.agentId,
        taskId,
        reason: receipt.errorReason ?? 'unknown',
      });
      return {
        kind: 'failed',
        event: this.failedEvent({
          taskId,
          contextId,
          code: 'SETTLEMENT_FAILED',
          reason: receipt.errorReason ?? 'Payment settlement failed.',
          failureReceipt: receipt,
        }),
      };
    }

    logEvent('x402_settled', {
      agentId: this.agentId,
      taskId,
      transaction: receipt.transaction,
      network: receipt.network,
      ...(receipt.payer !== undefined ? { payer: receipt.payer } : {}),
      // What the facilitator confirmed charging, which under `upto` is the
      // reconciliation datum and is not recoverable from the offering. Absent
      // whenever the facilitator reported no amount — the SDK does not
      // backfill it from what was requested.
      ...(receipt.amount !== undefined ? { amount: receipt.amount } : {}),
    });

    const done = this.x402.completedEvent({ receipt });
    const metadata = done.type === 'done' ? (done.metadata ?? {}) : {};
    await this.clear(taskId);
    return { kind: 'settled', metadata };
  }

  /** Drop the lifecycle record once the task has terminated. Best-effort. */
  async clear(taskId: string): Promise<void> {
    try {
      await this.x402.clearOffering({ taskId });
    } catch (err) {
      logEvent('x402_clear_error', { agentId: this.agentId, taskId, error: String(err) });
    }
  }

  private failedEvent(input: {
    taskId: string;
    contextId: string;
    code: Parameters<X402Context['failedEvent']>[0]['code'];
    reason: string;
    failureReceipt?: X402SettleResponse;
  }): TaskStatusUpdateEvent {
    const event = this.x402.failedEvent({
      code: input.code,
      reason: input.reason,
      ...(input.failureReceipt !== undefined
        ? { failureReceipt: input.failureReceipt }
        : {}),
    });
    return this.statusEvent({
      taskId: input.taskId,
      contextId: input.contextId,
      state: TaskState.FAILED,
      text: input.reason,
      metadata: event.type === 'error' ? (event.metadata ?? {}) : {},
    });
  }

  /**
   * Translate an x402 `AgentEvent` into the wire event this executor emits.
   * `final: true` on both states: an `input-required` turn ends the stream
   * without terminating the task, which is exactly what the flag means here.
   */
  private statusEvent(input: {
    taskId: string;
    contextId: string;
    state: TaskState;
    text: string;
    metadata: Record<string, unknown>;
  }): TaskStatusUpdateEvent {
    return {
      taskId: input.taskId,
      contextId: input.contextId,
      final: true,
      status: {
        state: input.state,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${input.taskId}-x402-${input.state}`,
          role: 'agent',
          parts: [{ text: input.text }],
          metadata: input.metadata,
          taskId: input.taskId,
          contextId: input.contextId,
        },
      },
    };
  }
}
