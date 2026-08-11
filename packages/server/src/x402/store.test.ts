// Integration tests for the x402 offering store against a real Postgres.
// The properties here are the ones a unit test with an in-memory stub cannot
// establish: agent scoping is a WHERE clause, the claim is a conditional
// UPDATE, the sweep is a DELETE, and the offer store's frozen offer is a
// JSONB column bound to the SDK's offering write in one statement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { MerchantOffer, X402StoreEntry } from '@a2x/sdk/x402';
import { PostgresX402Store, sweepExpiredX402Offerings } from './store.js';
import { parseX402Pricing, pricingToOffer } from './pricing.js';

const hasDb = !!process.env.DATABASE_URL;

const RESOURCE = 'https://bridge.test/agents/a';

const OFFER: MerchantOffer = pricingToOffer(
  parseX402Pricing({
    network: 'eip155:84532',
    amount: '10000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x1111111111111111111111111111111111111111',
  })!,
  RESOURCE,
);

function entry(taskId: string, overrides: Partial<X402StoreEntry> = {}): X402StoreEntry {
  return {
    taskId,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '10000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0x1111111111111111111111111111111111111111',
        resource: RESOURCE,
        description: 'test',
      },
    ],
    status: 'offered',
    storedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function withDb(fn: (sql: postgres.Sql, tag: string) => Promise<void>): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!);
  const tag = `x402-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fn(sql, tag);
  } finally {
    await sql`DELETE FROM x402_offerings WHERE task_id LIKE ${`${tag}%`}`;
    await sql.end();
  }
}

test(
  'an offering is invisible to a different agent',
  { skip: !hasDb },
  async () => {
    // The reason this matters: tasks resolve by id from a store shared across
    // agents (#453), so agent B can be handed a task created at agent A.
    // Keyed on task_id alone, B's gate would load A's cheap offering and
    // accept A's signature as payment for B's work.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-shared`;
      const a = new PostgresX402Store(sql, `${tag}-agent-a`);
      const b = new PostgresX402Store(sql, `${tag}-agent-b`);

      await a.publishing(taskId, OFFER, () => a.put(entry(taskId)));

      assert.ok(await a.get(taskId), 'the owning agent sees its own offering');
      assert.equal(await b.get(taskId), undefined, 'another agent must not');
      assert.equal(await b.getOffer(taskId), undefined);
      assert.equal(await b.claim(taskId), false, 'and must not be able to claim it');

      // B's delete must not reach A's row either.
      await b.delete(taskId);
      assert.ok(await a.get(taskId), "another agent's delete must not remove it");
    });
  },
);

test(
  'the same taskId can hold an independent offering per agent',
  { skip: !hasDb },
  async () => {
    // Follows from the composite key. Worth pinning because the previous
    // single-column PK made the second put silently overwrite the first.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-collide`;
      const a = new PostgresX402Store(sql, `${tag}-agent-a`);
      const b = new PostgresX402Store(sql, `${tag}-agent-b`);

      await a.put(entry(taskId, { status: 'offered' }));
      await b.put(entry(taskId, { status: 'verified' }));

      assert.equal((await a.get(taskId))?.status, 'offered');
      assert.equal((await b.get(taskId))?.status, 'verified');
    });
  },
);

test(
  'claim succeeds exactly once, including under concurrency',
  { skip: !hasDb },
  async () => {
    // The SDK's classify() does not inspect the entry's status, so a replayed
    // submission classifies valid every time. This conditional UPDATE is what
    // stops the backend running the work twice for one authorization.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-claim`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);
      await store.put(entry(taskId));

      assert.equal(await store.claim(taskId), true);
      assert.equal(await store.claim(taskId), false, 'a sequential replay loses');

      // And when both arrive at once, exactly one wins.
      const raced = `${tag}-claim-race`;
      await store.put(entry(raced));
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.claim(raced)),
      );
      assert.equal(results.filter(Boolean).length, 1, 'exactly one concurrent claim wins');
    });
  },
);

test(
  'release re-opens the claim, scoped to the owning agent',
  { skip: !hasDb },
  async () => {
    // `release` is the contract's one sanctioned un-claim — the SDK invokes
    // it when a retryable scheme cancels verified work. It must actually
    // re-open the window (a later claim wins again) and must be scoped like
    // every other operation: another agent releasing the same taskId must not
    // hand this agent's one-shot right back.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-release`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);
      const other = new PostgresX402Store(sql, `${tag}-agent-other`);
      await store.put(entry(taskId));

      assert.equal(await store.claim(taskId), true);
      await other.release(taskId);
      assert.equal(
        await store.claim(taskId),
        false,
        "another agent's release must not un-claim it",
      );

      await store.release(taskId);
      assert.equal(
        await store.claim(taskId),
        true,
        'a released claim can be taken exactly once again',
      );
      assert.equal(await store.claim(taskId), false, 'and stays one-shot after that');
    });
  },
);

test(
  'the offer store delete removes the row for its own agent',
  { skip: !hasDb },
  async () => {
    // `delete` serves both the SDK store and the offer store contract — the
    // MerchantGate calls it on cleanup after settlement, and a deleted row
    // must read as absent on every surface at once.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-delete`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);
      await store.publishing(taskId, OFFER, () => store.put(entry(taskId)));

      await store.delete(taskId);

      assert.equal(await store.get(taskId), undefined);
      assert.equal(await store.getOffer(taskId), undefined);
      assert.equal(await store.claim(taskId), false, 'a deleted offering cannot be claimed');
    });
  },
);

test(
  'a lifecycle update does not reset the claim or the frozen offer',
  { skip: !hasDb },
  async () => {
    // `put` runs repeatedly as the SDK patches the entry through verify and
    // settle. Neither the claim nor the frozen terms may be clobbered by it.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-patch`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);
      await store.publishing(taskId, OFFER, () => store.put(entry(taskId)));
      assert.equal(await store.claim(taskId), true);

      await store.update(taskId, { status: 'verified', verifiedAt: new Date() });

      assert.equal((await store.get(taskId))?.status, 'verified');
      assert.equal(await store.claim(taskId), false, 'the claim survives the patch');
      assert.deepEqual(await store.getOffer(taskId), OFFER);
    });
  },
);

test(
  'an expired offering reads as absent and is swept',
  { skip: !hasDb },
  async () => {
    await withDb(async (sql, tag) => {
      const live = `${tag}-live`;
      const lapsed = `${tag}-lapsed`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);

      await store.publishing(live, OFFER, () =>
        store.put(entry(live, { expiresAt: new Date(Date.now() + 600_000) })),
      );
      await store.publishing(lapsed, OFFER, () =>
        store.put(entry(lapsed, { expiresAt: new Date(Date.now() - 1_000) })),
      );

      // Lazy expiry: hidden from reads before anything deletes it.
      assert.ok(await store.get(live));
      assert.equal(await store.get(lapsed), undefined);
      assert.equal(await store.getOffer(lapsed), undefined, 'lapsed terms are not live terms');
      assert.equal(await store.claim(lapsed), false, 'an expired offering cannot be claimed');

      const deleted = await sweepExpiredX402Offerings(sql);
      assert.ok(deleted >= 1, 'the sweep reclaims the lapsed row');

      const remaining = await sql<{ task_id: string }[]>`
        SELECT task_id FROM x402_offerings WHERE task_id IN (${live}, ${lapsed})
      `;
      assert.deepEqual(
        remaining.map((r) => r.task_id),
        [live],
        'the sweep leaves live offerings alone',
      );
    });
  },
);

test(
  'the frozen offer round-trips through JSONB in full',
  { skip: !hasDb },
  async () => {
    // The offer store freezes the complete MerchantOffer — rates, floor,
    // policy
    // and all — not just the fields the wire shape shows. Settlement reads
    // them back verbatim.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-offer`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);
      const uptoOffer = pricingToOffer(
        parseX402Pricing({
          scheme: 'upto',
          network: 'eip155:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x1111111111111111111111111111111111111111',
          facilitatorAddress: '0x3333333333333333333333333333333333333333',
          maxAmount: '1000000',
          minAmount: '1000',
          rates: { input: '3000000', output: '15000000', cachedInput: '300000' },
        })!,
        RESOURCE,
      );

      await store.publishing(taskId, uptoOffer, () => store.put(entry(taskId)));
      assert.deepEqual(await store.getOffer(taskId), uptoOffer);
    });
  },
);

test(
  'concurrent publishes freeze one live offering and its terms',
  { skip: !hasDb },
  async () => {
    // The race this design exists for. Two turn-1s for the same task, racing a
    // reprice: whichever offering ends up stored, the terms beside it must be
    // the ones that produced it. Writing the two separately — in either order —
    // can interleave into A's offering with B's rates, and since both are the
    // same scheme no downstream shape check would notice.
    await withDb(async (sql, tag) => {
      const taskId = `${tag}-race`;
      const store = new PostgresX402Store(sql, `${tag}-agent`);

      const priced = (amount: string): MerchantOffer =>
        pricingToOffer(
          parseX402Pricing({
            network: 'eip155:84532',
            amount,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x1111111111111111111111111111111111111111',
          })!,
          RESOURCE,
        );
      const offering = (amount: string) =>
        entry(taskId, {
          accepts: [{ ...entry(taskId).accepts[0]!, amount }],
        });

      const publishedAmounts: string[] = [];
      const publish = (requested: MerchantOffer) =>
        store.publishing(taskId, requested, async (frozen) => {
          const pricing = frozen.accepts[0]!;
          assert.equal(pricing.scheme, 'exact');
          const amount = pricing.scheme === 'exact' ? pricing.amount : '';
          publishedAmounts.push(amount);
          await store.put(offering(amount));
        });

      await Promise.all([publish(priced('10000')), publish(priced('990000'))]);

      const stored = await store.get(taskId);
      const terms = await store.getOffer(taskId);
      assert.ok(stored && terms);
      assert.equal(publishedAmounts.length, 2);
      assert.equal(
        publishedAmounts[0],
        publishedAmounts[1],
        'the later publisher must reuse the first live terms',
      );
      const frozenPricing = terms.accepts[0]!;
      assert.equal(
        frozenPricing.scheme === 'exact' ? frozenPricing.amount : undefined,
        stored.accepts[0]!.amount,
        'the stored terms must be the ones that produced the stored offering',
      );
    });
  },
);
