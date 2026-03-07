/**
 * Expert Earnings Ledger
 *
 * Tracks what Balo owes each expert after each consultation.
 * Does NOT execute payouts — that is admin-initiated (post-MVP).
 */

import { db } from '@balo/db';
import { expertEarnings } from '@balo/db/schema';
import { eq } from 'drizzle-orm';

const PLATFORM_FEE_RATE = 0.25; // 25% Balo platform fee

/**
 * Record earnings for a completed consultation.
 * Called at the end of a consultation session.
 */
export async function recordConsultationEarnings({
  consultationId,
  expertUserId,
  clientUserId,
  durationMinutes,
  creditsConsumed,
}: {
  consultationId: string;
  expertUserId: string;
  clientUserId: string;
  durationMinutes: number;
  creditsConsumed: number;
}): Promise<void> {
  // 1 credit = A$1 = 100 cents
  const grossAmountCents = creditsConsumed * 100;
  const platformFeeCents = Math.round(grossAmountCents * PLATFORM_FEE_RATE);
  const netAmountCents = grossAmountCents - platformFeeCents;

  await db.insert(expertEarnings).values({
    consultationId,
    expertUserId,
    clientUserId,
    durationMinutes,
    creditsConsumed,
    grossAmountCents,
    platformFeeCents,
    netAmountCents,
    status: 'pending',
  });
}

/**
 * Get total unpaid earnings for an expert (in AUD cents).
 * Used to display balance on the expert dashboard.
 */
export async function getExpertPendingEarnings(
  expertUserId: string
): Promise<{ pendingCents: number; approvedCents: number }> {
  const rows = await db
    .select()
    .from(expertEarnings)
    .where(eq(expertEarnings.expertUserId, expertUserId));

  const pendingCents = rows
    .filter(r => r.status === 'pending')
    .reduce((sum, r) => sum + r.netAmountCents, 0);

  const approvedCents = rows
    .filter(r => r.status === 'approved')
    .reduce((sum, r) => sum + r.netAmountCents, 0);

  return { pendingCents, approvedCents };
}

// ─────────────────────────────────────────────
// NOTE: Payout execution is post-MVP.
//
// When ready, admin will:
// 1. Review and approve expert_earnings rows
// 2. Trigger payout via Stripe Payouts API or Airwallex (TBD)
// 3. Create expert_payouts record linking to the batch
// 4. Mark expert_earnings rows as 'paid'
//
// DO NOT implement payout execution until the mechanism is decided.
// ─────────────────────────────────────────────
