// idempotency-pattern.ts
// Idempotency is required on EVERY Stripe API call and EVERY webhook handler.
// This file shows the standard patterns.

import Stripe from 'stripe';
import { db } from '@balo/db';
import { creditTransactions } from '@balo/db/schema';
import { eq } from 'drizzle-orm';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ── Pattern 1: Idempotency key on Stripe API calls ────────────────
// Pass as second argument to any mutating Stripe call

export async function safeTransfer(expertId: string, amountCents: number, stripeAccountId: string) {
  // Key format: operation_primaryId_timestamp (or operation_primaryId_requestId)
  const idempotencyKey = `transfer_${expertId}_${Date.now()}`;

  const transfer = await stripe.transfers.create(
    {
      amount: amountCents,
      currency: 'aud',
      destination: stripeAccountId,
    },
    { idempotencyKey }, // <-- second argument
  );

  return transfer;
}

// ── Pattern 2: Idempotency check in webhook handlers ─────────────
// Check BEFORE processing — never rely on BullMQ dedup alone

export async function idempotentWebhookHandler(
  stripeEventId: string,
  process: () => Promise<void>,
) {
  const idempotencyKey = `event_${stripeEventId}`;

  // Check if already processed
  const existing = await db.query.creditTransactions.findFirst({
    where: eq(creditTransactions.idempotencyKey, idempotencyKey),
  });

  if (existing) {
    console.info('Duplicate Stripe event, skipping', { eventId: stripeEventId });
    return; // Return silently — this is expected behaviour on retries
  }

  // Process the event
  await process();
}

// ── Pattern 3: Idempotency key formats ───────────────────────────

const IDEMPOTENCY_KEY_FORMATS = {
  // Credit purchases
  checkout: (sessionId: string) => `checkout_${sessionId}`,

  // Payouts
  payout: (expertId: string, timestamp: number) => `payout_${expertId}_${timestamp}`,
  payoutReversal: (transferId: string) => `payout_reversal_${transferId}`,

  // Refunds
  refund: (caseId: string) => `refund_${caseId}`,

  // Admin adjustments
  adjustment: (adminId: string, userId: string, timestamp: number) =>
    `adjustment_${adminId}_${userId}_${timestamp}`,
};

// ── Usage example ─────────────────────────────────────────────────

// In a webhook handler:
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  await idempotentWebhookHandler(session.id, async () => {
    const credits = parseInt(session.metadata!.credits);
    await addCredits(session.metadata!.userId, credits, 'purchase', {
      stripePaymentIntentId: session.payment_intent as string,
      idempotencyKey: IDEMPOTENCY_KEY_FORMATS.checkout(session.id),
    });
  });
}
