/**
 * Credit Purchase Flow
 *
 * Client buys credits via Stripe Checkout.
 * Funds go into Balo's Stripe account (no Connect).
 * Balance is updated on webhook receipt, not here.
 */

import Stripe from 'stripe';
import { db } from '@balo/db';
import { clientProfiles, creditTransactions } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { generateIdempotencyKey } from './idempotency-pattern';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export interface CreditPackage {
  credits: number;       // Number of credits (= AUD dollars)
  priceAUDCents: number; // Amount to charge in cents
  label: string;         // e.g. "50 credits — A$50"
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  { credits: 25,  priceAUDCents: 2500,  label: '25 credits — A$25' },
  { credits: 50,  priceAUDCents: 5000,  label: '50 credits — A$50' },
  { credits: 100, priceAUDCents: 10000, label: '100 credits — A$100' },
  { credits: 250, priceAUDCents: 25000, label: '250 credits — A$250' },
];

/**
 * Create a Stripe Checkout session for a credit purchase.
 * Balance is NOT updated here — wait for webhook.
 */
export async function createCreditCheckoutSession({
  clientUserId,
  packageCredits,
  successUrl,
  cancelUrl,
}: {
  clientUserId: string;
  packageCredits: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ sessionId: string; url: string }> {
  const pkg = CREDIT_PACKAGES.find(p => p.credits === packageCredits);
  if (!pkg) throw new Error(`Invalid credit package: ${packageCredits}`);

  const idempotencyKey = generateIdempotencyKey('checkout', clientUserId, String(packageCredits));

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      currency: 'aud',
      line_items: [
        {
          price_data: {
            currency: 'aud',
            unit_amount: pkg.priceAUDCents,
            product_data: { name: pkg.label },
          },
          quantity: 1,
        },
      ],
      metadata: {
        clientUserId,
        creditsToAdd: String(pkg.credits),
        packageLabel: pkg.label,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    { idempotencyKey }
  );

  return { sessionId: session.id, url: session.url! };
}

/**
 * Fulfill a completed credit purchase.
 * Called by the webhook handler — NOT called directly from the UI.
 * Idempotent: checks for existing transaction before updating balance.
 */
export async function fulfillCreditPurchase({
  stripeSessionId,
  clientUserId,
  creditsToAdd,
  amountPaidCents,
}: {
  stripeSessionId: string;
  clientUserId: string;
  creditsToAdd: number;
  amountPaidCents: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Idempotency check — skip if already processed
    const existing = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.stripePaymentId, stripeSessionId))
      .limit(1);

    if (existing.length > 0) return; // Already fulfilled

    // Lock the row before updating balance
    const [profile] = await tx
      .select()
      .from(clientProfiles)
      .where(eq(clientProfiles.userId, clientUserId))
      .for('update');

    if (!profile) throw new Error(`Client profile not found: ${clientUserId}`);

    // Update balance
    await tx
      .update(clientProfiles)
      .set({ creditBalance: profile.creditBalance + creditsToAdd })
      .where(eq(clientProfiles.userId, clientUserId));

    // Record transaction
    await tx.insert(creditTransactions).values({
      userId: clientUserId,
      type: 'purchase',
      credits: creditsToAdd,
      amountCents: amountPaidCents,
      stripePaymentId: stripeSessionId,
      description: `Purchased ${creditsToAdd} credits`,
    });
  });
}
