// credit-purchase-flow.ts
// Client buys credits via Stripe Checkout Session
// Flow: Checkout Session → Stripe payment page → webhook → BullMQ → addCredits()

import Stripe from 'stripe';
import { db } from '@balo/db';
import { users, creditTransactions } from '@balo/db/schema';
import { eq } from 'drizzle-orm';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ── Create Checkout Session ───────────────────────────────────────

export async function createCreditPurchaseSession(
  userId: string,
  packageId: string,
  userEmail: string,
) {
  const pkg = await creditPackageRepository.findById(packageId);
  const idempotencyKey = `purchase_${userId}_${packageId}_${Date.now()}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: userEmail,
    line_items: [
      {
        price_data: {
          currency: 'aud',
          product_data: { name: `${pkg.credits} Balo Credits` },
          unit_amount: pkg.priceInCents, // Always in cents
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId,
      packageId,
      credits: pkg.credits.toString(), // Must be string in metadata
      idempotencyKey,
    },
    success_url: 'https://balo.expert/dashboard?purchase=success',
    cancel_url: 'https://balo.expert/dashboard?purchase=cancelled',
  });

  return session.url;
}

// ── Add Credits (atomic DB transaction) ──────────────────────────
// THIS IS THE ONLY WAY TO MODIFY CREDIT BALANCE — never update directly

export async function addCredits(
  userId: string,
  amount: number, // Positive = credits in, negative = credits out
  type: 'purchase' | 'consumption' | 'refund' | 'promo' | 'expiry' | 'adjustment',
  metadata: {
    description?: string;
    stripePaymentIntentId?: string;
    stripeTransferId?: string;
    caseId?: string;
    meetingId?: string;
    idempotencyKey?: string;
  },
) {
  return db.transaction(async (tx) => {
    // 1. Get current balance with row lock (prevents race conditions)
    const [user] = await tx
      .select({ balance: users.creditBalance })
      .from(users)
      .where(eq(users.id, userId))
      .for('update'); // CRITICAL: row lock

    if (!user) throw new Error('User not found');

    const newBalance = user.balance + amount;

    // 2. Guard: never allow negative balance
    if (newBalance < 0) {
      throw new Error(`Insufficient credits. Balance: ${user.balance}, Requested: ${Math.abs(amount)}`);
    }

    // 3. Record transaction with balance snapshot
    await tx.insert(creditTransactions).values({
      userId,
      type,
      amount,
      balanceAfter: newBalance, // Snapshot for audit trail
      ...metadata,
    });

    // 4. Update denormalized balance
    await tx.update(users).set({ creditBalance: newBalance }).where(eq(users.id, userId));

    return newBalance;
  });
}

// ── Webhook handler (called from BullMQ worker) ───────────────────

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const idempotencyKey = `checkout_${session.id}`;

  // Check if already processed (idempotency)
  const existing = await db.query.creditTransactions.findFirst({
    where: eq(creditTransactions.idempotencyKey, idempotencyKey),
  });

  if (existing) {
    console.info('Duplicate checkout webhook, skipping', { sessionId: session.id });
    return;
  }

  const credits = parseInt(session.metadata!.credits);
  const userId = session.metadata!.userId;

  await addCredits(userId, credits, 'purchase', {
    stripePaymentIntentId: session.payment_intent as string,
    idempotencyKey,
    description: `Purchased ${credits} Balo credits`,
  });
}
