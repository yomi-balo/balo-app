/**
 * Stripe Webhook Handler
 *
 * Handles incoming Stripe events for Balo's single account.
 * No Connect events — Balo does not use Stripe Connect.
 *
 * Pattern: verify → return 200 → dispatch to BullMQ → worker processes
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { queue } from '@balo/api/jobs/queue';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function stripeWebhookHandler(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    // rawBody must be configured in Fastify — do not use parsed body
    event = stripe.webhooks.constructEvent(req.rawBody as Buffer, sig, webhookSecret);
  } catch (err: any) {
    req.log.warn({ err }, 'Stripe webhook signature verification failed');
    return reply.code(400).send({ error: 'Invalid signature' });
  }

  // Return 200 immediately — processing happens async in BullMQ
  reply.code(200).send({ received: true });

  // jobId = event.id ensures idempotent processing (no duplicate jobs)
  await queue.add('stripe-event', { event }, { jobId: event.id });
}

// ── BullMQ Worker ────────────────────────────────────────────────

import { fulfillCreditPurchase } from './credit-purchase-flow';
import { db } from '@balo/db';

export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const { clientUserId, creditsToAdd } = session.metadata ?? {};

      if (!clientUserId || !creditsToAdd) {
        throw new Error(`Missing metadata on session ${session.id}`);
      }

      await fulfillCreditPurchase({
        stripeSessionId: session.id,
        clientUserId,
        creditsToAdd: Number(creditsToAdd),
        amountPaidCents: session.amount_total ?? 0,
      });
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      // TODO: reverse credit_transactions, update client balance
      // Implement when refund flow is built
      break;
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute;
      // Flag for admin review — do not auto-reverse credits
      // TODO: create admin_alerts record
      break;
    }

    default:
      // Unhandled events are silently ignored (Stripe sends many event types)
      break;
  }
}

// ─────────────────────────────────────────────
// NOTE: No transfer.paid / transfer.failed events.
// Balo does not use Stripe Connect or transfers.
// Expert earnings are tracked in expert_earnings table.
// Payout execution is post-MVP and admin-initiated.
// ─────────────────────────────────────────────
