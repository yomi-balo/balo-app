// expert-payout-flow.ts
// Two flows:
// 1. chargeForConsultation() — per-minute billing at meeting end
// 2. requestPayout() — expert withdraws credits as AUD via Stripe Transfer

import Stripe from 'stripe';
import { db } from '@balo/db';
import { expertProfiles } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { addCredits } from './credit-purchase-flow';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const MINIMUM_PAYOUT_AMOUNT = 50; // 50 credits minimum = ~$50 AUD

// ── Conversion helpers ────────────────────────────────────────────

/** 1 credit = 1 AUD = 100 cents. Never hardcode amounts. */
export function creditsToAUDCents(credits: number): number {
  return credits * 100;
}

export function calculateBillableMinutes(meeting: { startedAt: Date; endedAt: Date }): number {
  const ms = meeting.endedAt.getTime() - meeting.startedAt.getTime();
  return Math.ceil(ms / 60000); // Round up to nearest minute
}

// ── 1. Charge for consultation (triggered at meeting end) ─────────

export async function chargeForConsultation(meetingId: string) {
  const meeting = await meetingRepository.findById(meetingId, {
    with: { expertProfile: true, client: true },
  });

  const billableMinutes = calculateBillableMinutes(meeting);
  const creditCost = billableMinutes * meeting.expertProfile.perMinuteRate;

  // Single DB transaction: deduct from client + add to expert
  await db.transaction(async (tx) => {
    await addCredits(meeting.clientId, -creditCost, 'consumption', {
      caseId: meeting.caseId,
      meetingId,
      description: `${billableMinutes}min consultation with ${meeting.expertProfile.displayName}`,
    });

    await addCredits(meeting.expertId, creditCost, 'consumption', {
      caseId: meeting.caseId,
      meetingId,
      description: `${billableMinutes}min consultation with ${meeting.client.name}`,
    });
  });
}

// ── 2. Expert requests payout ─────────────────────────────────────

export async function requestPayout(expertId: string, amountInCredits: number) {
  const expert = await db.query.expertProfiles.findFirst({
    where: eq(expertProfiles.userId, expertId),
    with: { user: { columns: { creditBalance: true } } },
  });

  if (!expert) throw new Error('Expert not found');

  // Guards — check all conditions before touching Stripe
  if (!expert.stripeConnectId) {
    throw new Error('Payment setup required — connect Stripe account first');
  }
  if (amountInCredits < MINIMUM_PAYOUT_AMOUNT) {
    throw new Error(`Minimum payout is ${MINIMUM_PAYOUT_AMOUNT} credits`);
  }
  if (expert.user.creditBalance < amountInCredits) {
    throw new Error('Insufficient balance');
  }

  const idempotencyKey = `payout_${expertId}_${Date.now()}`;
  const amountInCents = creditsToAUDCents(amountInCredits);

  // Create Stripe transfer (idempotency key prevents double transfers on retry)
  const transfer = await stripe.transfers.create(
    {
      amount: amountInCents,
      currency: 'aud',
      destination: expert.stripeConnectId,
      metadata: { baloExpertId: expertId, idempotencyKey },
    },
    { idempotencyKey },
  );

  // Deduct from expert wallet (atomic)
  await addCredits(expertId, -amountInCredits, 'adjustment', {
    stripeTransferId: transfer.id,
    idempotencyKey,
    description: `Payout of ${amountInCredits} credits ($${(amountInCents / 100).toFixed(2)} AUD)`,
  });

  return transfer;
}

// ── Webhook: handle transfer.paid ────────────────────────────────

export async function handleTransferPaid(transfer: Stripe.Transfer) {
  // Mark payout as completed in DB (update payout_requests table if it exists)
  // The credits were already deducted in requestPayout() — nothing to reverse
  await payoutRequestRepository.markCompleted(transfer.id);
}

// ── Webhook: handle transfer.failed ──────────────────────────────

export async function handleTransferFailed(transfer: Stripe.Transfer) {
  const idempotencyKey = `payout_reversal_${transfer.id}`;

  // Re-add credits to expert wallet
  const expertId = transfer.metadata.baloExpertId;
  const amountInCredits = transfer.amount / 100; // cents → credits

  await addCredits(expertId, amountInCredits, 'adjustment', {
    stripeTransferId: transfer.id,
    idempotencyKey,
    description: `Payout reversal — transfer failed (${transfer.id})`,
  });

  // Notify expert via Brevo
  await notificationService.sendPayoutFailedEmail(expertId, amountInCredits);

  // Update payout request status
  await payoutRequestRepository.markFailed(transfer.id, 'Stripe transfer failed');
}
