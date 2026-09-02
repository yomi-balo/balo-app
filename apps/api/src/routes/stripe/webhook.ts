import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { db, stripeWebhookEventsRepository } from '@balo/db';
import { getStripeClient, getWebhookSecret } from '../../lib/stripe.js';
import {
  applyStripeEffect,
  resolveStripeEffect,
  StripeWebhookCommitProofError,
} from '../../services/stripe/index.js';

/**
 * The single idempotent Stripe webhook endpoint (BAL-382).
 *
 * Flow: verify the signature on the RAW body (400 on failure → Stripe does not retry a bad
 * signature) → fast short-circuit on a fully-processed replay → resolve external data
 * (Stripe calls, no DB writes) BEFORE opening the transaction so it stays short → in ONE
 * `db.transaction`, insert the event-id marker, apply the effect, and stamp `processed_at`
 * together (a persisted marker therefore always implies a committed effect; the ledger
 * `idempotency_key` unique is the authoritative backstop). Unknown event types resolve to a
 * null effect → marker recorded, processed, ack 200 (never 500 — that floods retries).
 *
 * BAL-515 — THE ACK CONTRACT IS NOW "A 200 ASSERTS A PROVEN COMMIT". Two guards, both below:
 * a row-count check on `markProcessed` INSIDE the transaction, and a re-read of the marker on the
 * BASE `db` AFTER it resolves. Either failure throws → 500 → Stripe redelivers. Read the comments
 * at each site before touching them; they record the incident that motivated them.
 */
export async function stripeWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/stripe', { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    const rawBody = request.rawBody;

    let event: Stripe.Event;
    try {
      if (rawBody === undefined || typeof signature !== 'string') {
        throw new Error('missing raw body or stripe-signature header');
      }
      event = getStripeClient().webhooks.constructEvent(rawBody, signature, getWebhookSecret());
    } catch (err: unknown) {
      request.log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Stripe webhook signature verification failed'
      );
      return reply.code(400).send({ error: 'invalid signature' });
    }

    // Fast idempotent short-circuit on a fully-processed replay (no txn, no Stripe refetch).
    const seen = await stripeWebhookEventsRepository.findByEventId(event.id);
    if (seen?.processedAt) {
      request.log.info(
        { eventId: event.id, eventType: event.type },
        'Stripe webhook replay — already processed, acking'
      );
      return reply.code(200).send({ received: true });
    }

    // Resolve external data (may call Stripe) BEFORE the txn so it stays short. A throw here
    // propagates to the app error handler → 500 → Stripe retries. null = unhandled type.
    const effect = await resolveStripeEffect(event);

    // Deferred POST-COMMIT effects (BAL-378 session settled / settlement-failed notices, the
    // BAL-377 top-up receipt, + analytics) run AFTER the txn commits — never inside it, since
    // enqueuing to BullMQ / PostHog must not be undone by a rollback. Empty for an unhandled
    // type or a deduped replay.
    let postCommit: Array<() => Promise<void>> = [];

    await db.transaction(async (tx) => {
      const marker = await stripeWebhookEventsRepository.insertReceived(
        { eventId: event.id, type: event.type },
        tx
      );
      if (marker === undefined) {
        // A concurrent delivery inserted the marker first — bail if it already finished.
        const current = await stripeWebhookEventsRepository.findByEventId(event.id, tx);
        if (current?.processedAt) {
          return;
        }
      }
      if (effect) {
        postCommit = await applyStripeEffect(tx, effect);
      }
      const stamped = await stripeWebhookEventsRepository.markProcessed(event.id, tx);
      if (!stamped) {
        // BAL-515 — `false` is NEVER a legitimate outcome here: either `insertReceived` returned
        // a row above, or it returned `undefined` because a concurrent delivery had already
        // committed one (and that arm only falls through when the row is NOT yet processed). The
        // row exists on both. A zero-row UPDATE therefore means this transaction cannot see the
        // marker it just wrote — the phantom-commit signature, caught mid-flight. Throwing here
        // rolls the WHOLE transaction back, so nothing is half-applied.
        throw new StripeWebhookCommitProofError(event.id, event.type, 'mark_processed');
      }
    });

    // ⚠⚠ COMMIT PROOF — THE ONLY APP-LEVEL GUARD AGAINST A PHANTOM COMMIT, AND THE REASON
    // BAL-515 EXISTS. A resolved `db.transaction()` is NOT proof of a commit: over the Supabase
    // transaction pooler, `postgres-js` preparing COMMIT as a NAMED statement could meet a
    // backend lacking that name (26000), retry it inside the aborted block, and resolve with
    // Postgres having rolled everything back and reported nothing. A real A$300 top-up was
    // charged and never credited that way, with this route answering 200
    // (`packages/db/src/client.ts:12-41`, pinned by `client.prepared-commit.integration.test.ts`).
    //
    // ⚠ IT MUST BE POST-COMMIT AND ON THE BASE `db`. A `.returning()` check INSIDE the
    // transaction would NOT have caught the incident — the UPDATE succeeded; the COMMIT lied.
    // `findByEventId`'s `exec` defaults to the base `db`, so passing no tx handle is what lands
    // this read on a different pooled connection.
    //
    // ⚠ ROW EXISTENCE IS NOT PROOF — `processedAt` IS. A phantom commit loses the insert AND the
    // stamp, but a concurrent delivery can legitimately have inserted the row; only the stamp
    // proves THIS transaction's work landed. The concurrent-delivery short-circuit above is safe
    // here because it only returns early when `processedAt` was ALREADY set.
    //
    // ⚠ THERE IS DELIBERATELY NO EVENTUAL-ACK ESCAPE HATCH. See the error's own docblock: acking
    // a money effect that may not exist is precisely the incident. Stripe's retry schedule is
    // finite (~3 days) and this guard has no always-false mode — it fails only when the
    // transaction genuinely did not commit — so a 500 from here is always real and recoverable.
    const committed = await stripeWebhookEventsRepository.findByEventId(event.id);
    if (!committed?.processedAt) {
      request.log.error(
        { eventId: event.id, eventType: event.type, handled: effect !== null },
        'Stripe webhook transaction resolved but its marker is NOT committed — refusing to ack; Stripe will redeliver'
      );
      throw new StripeWebhookCommitProofError(event.id, event.type, 'post_commit_readback');
    }

    // Post-commit side-effects. Each publish is best-effort + idempotent by `correlationId`
    // (BullMQ jobId dedup), so even a genuine Stripe replay collapses to one delivery.
    for (const run of postCommit) {
      await run();
    }

    request.log.info(
      { eventId: event.id, eventType: event.type, handled: effect !== null },
      'Stripe webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}
