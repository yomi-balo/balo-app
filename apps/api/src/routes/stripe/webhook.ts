import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { db, stripeWebhookEventsRepository } from '@balo/db';
import { getStripeClient, getWebhookSecret } from '../../lib/stripe.js';
import { applyStripeEffect, resolveStripeEffect } from '../../services/stripe/index.js';

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
        await applyStripeEffect(tx, effect);
      }
      await stripeWebhookEventsRepository.markProcessed(event.id, tx);
    });

    request.log.info(
      { eventId: event.id, eventType: event.type, handled: effect !== null },
      'Stripe webhook processed'
    );
    return reply.code(200).send({ received: true });
  });
}
