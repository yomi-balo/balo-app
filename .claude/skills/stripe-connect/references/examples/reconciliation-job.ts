// reconciliation-job.ts
// Nightly BullMQ job that catches missed webhooks and flags balance discrepancies.
// Schedule: 2:00 AM AEST daily (UTC+10/11)
// NEVER auto-fix balance discrepancies — alert admin only.

import Stripe from 'stripe';
import { db } from '@balo/db';
import { users, creditTransactions } from '@balo/db/schema';
import { eq, sum } from 'drizzle-orm';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const LOOKBACK_SECONDS = 86400; // 24 hours

// ── Main reconciliation job ───────────────────────────────────────

export async function reconcileStripeTransactions() {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

  await reconcileCheckoutSessions(since);
  await reconcileTransfers(since);
  await findBalanceDiscrepancies();
}

// ── 1. Reconcile checkout sessions ───────────────────────────────

async function reconcileCheckoutSessions(since: number) {
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const sessions = await stripe.checkout.sessions.list({
      created: { gte: since },
      limit: 100,
      ...(startingAfter && { starting_after: startingAfter }),
    });

    for (const session of sessions.data) {
      if (session.payment_status !== 'paid') continue;

      const idempotencyKey = `checkout_${session.id}`;
      const existing = await db.query.creditTransactions.findFirst({
        where: eq(creditTransactions.idempotencyKey, idempotencyKey),
      });

      if (!existing) {
        // Missed webhook — attempt to re-process
        console.warn('Missing credit transaction for completed checkout', {
          sessionId: session.id,
          userId: session.metadata?.userId,
        });

        try {
          await handleCheckoutCompleted(session);
          console.info('Auto-recovered missed checkout', { sessionId: session.id });
        } catch (err) {
          console.error('Failed to auto-recover checkout', { sessionId: session.id, err });
          await notificationService.alertAdmin('missed_checkout', { sessionId: session.id });
        }
      }
    }

    hasMore = sessions.has_more;
    if (sessions.data.length > 0) {
      startingAfter = sessions.data[sessions.data.length - 1].id;
    }
  }
}

// ── 2. Reconcile transfers ────────────────────────────────────────

async function reconcileTransfers(since: number) {
  const transfers = await stripe.transfers.list({
    created: { gte: since },
    limit: 100,
  });

  for (const transfer of transfers.data) {
    const existing = await db.query.creditTransactions.findFirst({
      where: eq(creditTransactions.stripeTransferId, transfer.id),
    });

    if (!existing) {
      console.error('Transfer with no matching credit transaction', {
        transferId: transfer.id,
        amount: transfer.amount,
        destination: transfer.destination,
      });
      // Do NOT auto-fix transfers — always require manual review
      await notificationService.alertAdmin('unmatched_transfer', { transferId: transfer.id });
    }
  }
}

// ── 3. Find balance discrepancies ────────────────────────────────
// Compare users.credit_balance against sum of all their transactions

async function findBalanceDiscrepancies() {
  // Get all users with a non-zero balance or transaction history
  const usersWithTransactions = await db
    .selectDistinct({ userId: creditTransactions.userId })
    .from(creditTransactions);

  const discrepancies: Array<{ userId: string; storedBalance: number; calculatedBalance: number }> =
    [];

  for (const { userId } of usersWithTransactions) {
    const [user] = await db
      .select({ creditBalance: users.creditBalance })
      .from(users)
      .where(eq(users.id, userId));

    const [result] = await db
      .select({ total: sum(creditTransactions.amount) })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId));

    const calculatedBalance = Number(result.total ?? 0);

    if (user.creditBalance !== calculatedBalance) {
      discrepancies.push({
        userId,
        storedBalance: user.creditBalance,
        calculatedBalance,
      });
    }
  }

  if (discrepancies.length > 0) {
    console.error('Credit balance discrepancies detected', {
      count: discrepancies.length,
      discrepancies,
    });

    // NEVER auto-fix discrepancies — always alert admin for manual review
    await notificationService.alertAdmin('balance_discrepancies', {
      count: discrepancies.length,
      details: discrepancies,
    });
  } else {
    console.info('Reconciliation complete — no discrepancies found');
  }

  return discrepancies;
}
