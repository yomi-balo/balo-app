// webhook-handler.ts
// Fastify route: POST /webhooks/stripe
// Pattern: verify signature → dispatch to BullMQ → return 200 immediately

import Stripe from 'stripe';
import type { FastifyRequest, FastifyReply } from 'fastify';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ── Route handler ─────────────────────────────────────────────────

export async function stripeWebhookHandler(request: FastifyRequest, reply: FastifyReply) {
  const sig = request.headers['stripe-signature'] as string;

  // Fastify must be configured to preserve rawBody for webhook routes:
  // fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)
  const rawBody = (request as any).rawBody as Buffer;

  // 1. Verify Stripe signature — reject immediately if invalid
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    request.log.error({ err }, 'Stripe webhook signature verification failed');
    return reply.status(400).send({ error: 'Invalid signature' });
  }

  // 2. Dispatch to BullMQ — jobId = event.id deduplicates retries
  await stripeEventQueue.add(
    event.type,
    {
      eventId: event.id,
      type: event.type,
      data: event.data.object,
      idempotencyKey: event.id, // Stripe event ID as idempotency key
    },
    {
      jobId: event.id, // BullMQ deduplicates by jobId
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );

  // 3. Return 200 immediately — NEVER process inline
  // Stripe will retry if we don't respond within 30s
  return reply.status(200).send({ received: true });
}

// ── BullMQ Worker ─────────────────────────────────────────────────

export const stripeWorker = new Worker('stripe-events', async (job) => {
  const { type, data, idempotencyKey } = job.data;

  switch (type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(data as Stripe.Checkout.Session);
      break;

    case 'transfer.paid':
      await handleTransferPaid(data as Stripe.Transfer);
      break;

    case 'transfer.failed':
      await handleTransferFailed(data as Stripe.Transfer);
      break;

    case 'account.updated':
      await handleAccountUpdated(data as Stripe.Account);
      break;

    case 'charge.refunded':
      await handleChargeRefunded(data as Stripe.Charge);
      break;

    case 'charge.dispute.created':
      await handleDisputeCreated(data as Stripe.Dispute);
      break;

    default:
      // Log unhandled events but don't fail the job
      job.log(`Unhandled Stripe event type: ${type}`);
  }
});

// ── account.updated handler ───────────────────────────────────────

async function handleAccountUpdated(account: Stripe.Account) {
  // Find expert by stripeConnectId and update status
  const expert = await expertProfileRepository.findByStripeAccountId(account.id);
  if (!expert) return;

  await expertProfileRepository.update(expert.id, {
    stripeChargesEnabled: account.charges_enabled,
    stripePayoutsEnabled: account.payouts_enabled,
    stripeDetailsSubmitted: account.details_submitted,
  });
}

// ── charge.dispute.created handler ───────────────────────────────

async function handleDisputeCreated(dispute: Stripe.Dispute) {
  // Freeze the associated case and notify admin
  // Do NOT auto-reverse credits — wait for dispute resolution
  await caseRepository.flagForDispute(dispute.payment_intent as string);
  await notificationService.alertAdmin('dispute_created', { disputeId: dispute.id });
}
