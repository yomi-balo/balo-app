import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { db, stripeWebhookEventsRepository } from '@balo/db';
import { getStripeClient, getWebhookSecret } from '../../lib/stripe.js';
import {
  applyStripeEffect,
  resolveStripeEffect,
  type CreditTopupReceipt,
} from '../../services/stripe/index.js';
import { notificationEvents } from '../../notifications/publisher.js';

/**
 * BAL-377 — publish the `credit.topup.completed` receipt AFTER the webhook transaction
 * commits (a persisted marker always implies a committed credit). Best-effort: a publish
 * failure is logged, never thrown — the money is already committed, and re-throwing would
 * make Stripe retry the whole idempotent webhook for a mere notification hiccup. Idempotent
 * by `correlationId` (`manual_purchase:{piId}` → BullMQ jobId dedup), so even a genuine
 * Stripe replay collapses to one receipt. A receipt with no purchaser (defensive — a
 * manual_purchase always stamps `memberId`) is skipped: `self` has no user to resolve.
 */
async function publishTopupReceipt(
  fastify: FastifyInstance,
  receipt: CreditTopupReceipt
): Promise<void> {
  if (receipt.purchaserUserId === null) {
    fastify.log.warn(
      { correlationId: receipt.correlationId },
      'credit.topup.completed skipped — manual purchase has no purchaser to notify'
    );
    return;
  }
  try {
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: receipt.correlationId,
      userId: receipt.purchaserUserId,
      companyId: receipt.companyId,
      creditedMinor: receipt.creditedMinor,
      chargedCurrency: receipt.chargedCurrency,
      chargedAmountMinor: receipt.chargedAmountMinor,
      promoGrantedMinor: receipt.promoGrantedMinor,
      balanceAfterMinor: receipt.balanceAfterMinor,
      expiresAt: receipt.expiresAt ?? '',
    });
  } catch (err: unknown) {
    fastify.log.error(
      {
        correlationId: receipt.correlationId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish credit.topup.completed receipt (money committed; notification best-effort)'
    );
  }
}

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

    // BAL-377 — a fresh manual_purchase credit surfaces the receipt facts to publish AFTER
    // the txn commits (hoisted out of the callback; null for every other effect / a replay).
    let topupReceipt: CreditTopupReceipt | null = null;

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
        const applied = await applyStripeEffect(tx, effect);
        if (applied?.kind === 'credit_topup_receipt') {
          topupReceipt = applied.receipt;
        }
      }
      await stripeWebhookEventsRepository.markProcessed(event.id, tx);
    });

    // POST-COMMIT: publish the top-up receipt notification (best-effort, idempotent).
    if (topupReceipt !== null) {
      await publishTopupReceipt(fastify, topupReceipt);
    }

    request.log.info(
      { eventId: event.id, eventType: event.type, handled: effect !== null },
      'Stripe webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}
