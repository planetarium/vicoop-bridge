import {
  MerchantGate,
  X402Context,
  X402_FOUNDATION_EXTENSION_URI,
  type BaseX402Context,
  type MerchantDeferredObligation,
  type MerchantMeterableUsage,
  type MerchantOfferStore,
  type MerchantPricing,
  type X402SettleResponse,
} from '@a2x/sdk/x402';
import { TaskState, type Message, type TaskStatusUpdateEvent } from '@a2x/sdk';
import type { Sql } from '../db.js';
import { logEvent } from '../log.js';
import { PostgresX402Store } from './store.js';
import { pricingToOffer, type X402Pricing } from './pricing.js';

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
): { context: X402Context; offerStore: MerchantOfferStore } {
  const url = process.env.BRIDGE_X402_FACILITATOR_URL;
  const store = new PostgresX402Store(sql, agentId);
  return {
    context: new X402Context({
      store,
      x402Version: X402_VERSION,
      ...(url ? { facilitator: { url } } : {}),
    }),
    // Same instance: the frozen offer lives on the offering row, so the offer
    // store shares the SDK store's agent scoping rather than re-deriving it.
    offerStore: store,
  };
}

/**
 * What the caller still owes, once the gate has cleared a turn to run.
 *
 * The two schemes settle at opposite ends of the work, and the difference is
 * not an implementation detail — it decides who carries the risk when things
 * go wrong.
 *
 * - `settled` (`exact`): already charged, before the agent was contacted. The
 *   amount is fixed and known up front, so there is no reason to hand over the
 *   work first and hope the authorization is still good afterwards.
 *   `metadata` is the receipt to merge onto the task's terminal message.
 * - `deferred` (`upto`): the charge comes from consumption, which does not
 *   exist until the work is done, so settlement can only follow it.
 *   `obligation` carries the classified submission and the terms the offering
 *   was published under, frozen by the SDK's offer store — settlement uses
 *   these, never the agent's live pricing, because a reprice between the two
 *   turns would otherwise meter against terms the payer never signed.
 */
export type X402Settlement =
  | { mode: 'settled'; metadata: Record<string, unknown> }
  | { mode: 'deferred'; obligation: MerchantDeferredObligation };

/**
 * Outcome of running the payment gate on an inbound turn.
 *
 * - `proceed` — nothing to charge for, or the payment verified. Run the work.
 *   `settlement` is present exactly when the payment round-trip is live.
 * - `halt` — emit `event` and end the turn. Either the payment was requested
 *   (`input-required`, awaiting the client's signed resubmission) or it was
 *   refused (`failed`).
 */
export type X402GateOutcome =
  | { kind: 'proceed'; settlement?: X402Settlement }
  | { kind: 'halt'; event: TaskStatusUpdateEvent };

export interface X402GateParams {
  taskId: string;
  contextId: string;
  message: Message;
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
 * The orchestration — classify, freeze the offered terms, claim the one-shot
 * right to a submission, verify, meter, clamp, settle — is the SDK's
 * `MerchantGate`; this class is the bridge-side composition of it. What stays
 * here is exactly what the SDK leaves to the host: rendering outcomes as the
 * `TaskStatusUpdateEvent`s this executor emits, the telemetry stream, mapping
 * the stored pricing row onto a `MerchantOffer`, and the deployment's policy
 * choices (`exactTiming: 'before-work'`, `unreportedUsage: 'floor'`, the
 * offering TTL, and the wire version).
 *
 * The SDK fails closed on its own: a facilitator or store error surfaces as a
 * `refuse` outcome, never a `proceed`, so an unpaid call cannot fall through
 * to the agent because the payment rail was unavailable. `onError` below is
 * the operator's view of those errors.
 */
export class X402Gate {
  private readonly gate: MerchantGate;

  constructor(
    private readonly agentId: string,
    private readonly pricing: X402Pricing,
    private readonly x402: BaseX402Context,
    offerStore: MerchantOfferStore,
    /** Public URL of the agent being paid for — shown in the payer's wallet. */
    resource: string,
  ) {
    this.gate = new MerchantGate({
      x402,
      // Resolved fresh on every turn 1 and then frozen by the offer store, so
      // a signed turn 2 settles under the terms it was offered even when the
      // agent has been repriced in between.
      pricing: () => ({
        ...pricingToOffer(this.pricing, resource),
        expiresInSeconds: OFFERING_TTL_SECONDS,
      }),
      offerStore,
      // Flat fees charge before the agent is contacted: the amount was fixed
      // at offer time and the payer signed for exactly it, so there is nothing
      // to learn by doing the work first — and doing it first means handing
      // over the result and only then discovering the authorization has been
      // drained. A failure costs nobody: no charge, no work.
      exactTiming: 'before-work',
      onError: (error, ctx) => {
        // Facilitator unreachable, DB down, malformed offering. The payer sees
        // a generic refusal; this is where the operator sees why.
        logEvent('x402_gate_error', {
          agentId: this.agentId,
          taskId: ctx.taskId,
          operation: ctx.operation,
          error: String(error),
        });
      },
    });
  }

  /**
   * Scheme-independent description of an offering's terms, for logs. Under a
   * metered scheme the amount is the authorized ceiling, so it is labelled as
   * such rather than reported as a price that will be charged. Takes either
   * the stored row or the SDK's frozen pricing — the discriminants agree
   * (`batch-settlement` exists only on the SDK side; the bridge never stores
   * such a row, but frozen pricing is typed to admit it).
   */
  private offeringFields(pricing: X402Pricing | MerchantPricing): Record<string, string> {
    return pricing.scheme === 'upto' || pricing.scheme === 'batch-settlement'
      ? {
          scheme: pricing.scheme,
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
   */
  async open(params: X402GateParams): Promise<X402GateOutcome> {
    const { taskId, contextId, message } = params;

    // `upto` exists only in x402 V2. The SDK would throw from
    // `requestPayment`, which its fail-closed catch would report as a
    // transient outage — misleading for what is a permanent misconfiguration.
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

    const outcome = await this.gate.open({ taskId, contextId, message });

    switch (outcome.kind) {
      case 'request-payment':
        // Turn 1. The SDK persisted the offering (status `offered`, with the
        // TTL) and froze its terms; only the event needs translating.
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
            text: outcome.text,
            metadata: outcome.metadata,
          }),
        };

      case 'refuse':
        // Covers every refusal the SDK produces — a malformed or mismatched
        // submission, a failed verify, a replayed claim, a lapsed offering, a
        // flat fee that could not be collected, or an infra error failing
        // closed. `code` is the spec §9.1 discriminator between them.
        logEvent('x402_payment_refused', {
          agentId: this.agentId,
          taskId,
          code: outcome.code,
          reason: outcome.reason,
        });
        if (outcome.failureReceipt !== undefined) {
          // Money was in motion when this refusal happened: a `before-work`
          // exact settlement was attempted and the facilitator said no.
          logEvent('x402_settle_failed', {
            agentId: this.agentId,
            taskId,
            reason: outcome.failureReceipt.errorReason ?? 'unknown',
          });
        }
        return {
          kind: 'halt',
          event: this.failedEvent({
            taskId,
            contextId,
            code: outcome.code,
            reason: outcome.reason,
            ...(outcome.failureReceipt !== undefined
              ? { failureReceipt: outcome.failureReceipt }
              : {}),
          }),
        };

      case 'handled': {
        // A batch-settlement refund the SDK settled without running any work.
        // Unreachable today: the bridge never publishes batch-settlement
        // pricing, so no frozen offer can select it — but the outcome union
        // carries it, and the safe defensive mapping is a terminal halt. The
        // money already moved (the SDK holds a successful refund receipt), so
        // the receipt must reach the payer on a completed terminal status;
        // running the work or reporting failure would both misstate what
        // happened. The extra log is the operator's tripwire that a path this
        // deployment cannot produce fired anyway.
        logEvent('x402_unexpected_outcome', {
          agentId: this.agentId,
          taskId,
          outcome: 'handled',
          operation: outcome.operation,
        });
        this.logSettled(taskId, outcome.receipt);
        return {
          kind: 'halt',
          event: this.statusEvent({
            taskId,
            contextId,
            state: TaskState.COMPLETED,
            text: 'The payment operation completed; no agent work was performed.',
            metadata: outcome.receiptMetadata,
          }),
        };
      }

      case 'proceed': {
        const obligation = outcome.obligation;
        if (obligation === undefined) {
          // The resolver above never returns null for a priced agent, so a
          // bare proceed cannot happen here; tolerate it as "free" anyway.
          return { kind: 'proceed' };
        }

        logEvent('x402_payment_verified', {
          agentId: this.agentId,
          taskId,
          ...this.offeringFields(obligation.pricing),
        });

        if (obligation.kind === 'deferred') {
          // Metered: the charge does not exist until the work has been done,
          // so settlement has to follow it — see `settle`.
          return { kind: 'proceed', settlement: { mode: 'deferred', obligation } };
        }

        // Flat fee, already settled by the SDK before the agent is contacted
        // (`exactTiming: 'before-work'`). Safe because the claim inside the
        // SDK is a one-shot: a replayed submission cannot settle twice.
        this.logSettled(taskId, obligation.receipt);
        const done = this.x402.completedEvent({ receipt: obligation.receipt });
        const metadata = done.type === 'done' ? (done.metadata ?? {}) : {};
        return { kind: 'proceed', settlement: { mode: 'settled', metadata } };
      }
    }
  }

  /**
   * Settle a deferred (`upto`) payment after the agent completed the work.
   *
   * The charge is metered from `usage` under the obligation's frozen terms,
   * and the SDK clamps it down to the minimum of the metered value, the
   * offered ceiling, and the payer's signed cap — so a pricing or metering
   * mistake here can only ever undercharge. An `unreported` usage bills the
   * floor (`unreportedUsage: 'floor'`), a trusted reported zero settles zero
   * (a2x#206).
   *
   * Returns metadata to merge onto the task's final status message on
   * success, or a replacement terminal event when settlement failed — the
   * merchant was not paid, so the task must not report success.
   */
  async settle(params: {
    taskId: string;
    contextId: string;
    /** The verified submission and its frozen terms, from `open`. */
    obligation: MerchantDeferredObligation;
    usage: MerchantMeterableUsage;
    /** The model the backend reported, for the metering log only. */
    model?: string | undefined;
  }): Promise<
    | { kind: 'settled'; metadata: Record<string, unknown> }
    | { kind: 'failed'; event: TaskStatusUpdateEvent }
  > {
    const { taskId, contextId, obligation, usage, model } = params;

    const result = await this.gate.settle({ taskId, obligation, usage });

    if (result.kind === 'failed') {
      logEvent('x402_settle_failed', {
        agentId: this.agentId,
        taskId,
        reason: result.reason,
      });
      return {
        kind: 'failed',
        event: this.failedEvent({
          taskId,
          contextId,
          code: result.code,
          reason: result.reason,
          ...(result.failureReceipt !== undefined
            ? { failureReceipt: result.failureReceipt }
            : {}),
        }),
      };
    }

    if (obligation.scheme === 'upto' && result.charge !== undefined) {
      const charge = result.charge;
      logEvent('x402_metered', {
        agentId: this.agentId,
        taskId,
        basis: charge.basis,
        amount: charge.requestedAtomic,
        ceiling: obligation.pricing.maxAmount,
        ...(usage.kind === 'detailed'
          ? {
              promptTokens: usage.inputTokens,
              completionTokens: usage.outputTokens,
              ...(usage.cachedInputTokens !== undefined
                ? { cachedTokens: usage.cachedInputTokens }
                : {}),
            }
          : {}),
        ...(model !== undefined ? { model } : {}),
      });
      if (charge.basis === 'unreported-floor') {
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

    this.logSettled(taskId, result.receipt);
    return { kind: 'settled', metadata: result.receiptMetadata };
  }

  /** Drop the lifecycle record once the task has terminated. Best-effort. */
  async clear(taskId: string): Promise<void> {
    try {
      await this.x402.clearOffering({ taskId });
    } catch (err) {
      logEvent('x402_clear_error', { agentId: this.agentId, taskId, error: String(err) });
    }
  }

  private logSettled(taskId: string, receipt: X402SettleResponse): void {
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
   * Translate an x402 outcome into the wire event this executor emits.
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
