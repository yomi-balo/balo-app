// connected-account-onboarding.ts
// Stripe Connect Express — expert payout account creation and onboarding link generation
// Used by: BAL-196 (Payouts page), Expert Settings → Payouts tab

import Stripe from 'stripe';
import { db } from '@balo/db';
import { expertProfiles } from '@balo/db/schema';
import { eq } from 'drizzle-orm';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ── Create Connect Express account ───────────────────────────────

export async function createConnectedAccount(expertId: string, email: string) {
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'AU',
    email,
    capabilities: {
      transfers: { requested: true },
    },
    metadata: { baloExpertId: expertId },
  });

  // Store the Stripe account ID immediately
  await db
    .update(expertProfiles)
    .set({ stripeConnectId: account.id })
    .where(eq(expertProfiles.userId, expertId));

  return account;
}

// ── Generate onboarding link ──────────────────────────────────────

export async function createOnboardingLink(stripeAccountId: string) {
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: 'https://balo.expert/expert/settings?tab=payouts&refresh=true',
    return_url: 'https://balo.expert/expert/settings?tab=payouts&setup=complete',
    type: 'account_onboarding',
  });

  return link.url;
}

// ── Check account status ──────────────────────────────────────────

export async function checkAccountStatus(stripeAccountId: string) {
  const account = await stripe.accounts.retrieve(stripeAccountId);

  return {
    payoutsEnabled: account.payouts_enabled,
    chargesEnabled: account.charges_enabled,
    detailsSubmitted: account.details_submitted,
    // requiresAction = true means the onboarding link should be shown again
    requiresAction: !account.details_submitted || !account.payouts_enabled,
  };
}

// ── Generate Express Dashboard link ──────────────────────────────

export async function createExpressDashboardLink(stripeAccountId: string) {
  const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
  return loginLink.url;
}

// ── Server Action: initiate payout setup ─────────────────────────
// Called from the Payouts page "Set up payouts" button

export async function initiatePayoutSetup(expertId: string) {
  const expert = await db.query.expertProfiles.findFirst({
    where: eq(expertProfiles.userId, expertId),
    with: { user: { columns: { email: true } } },
  });

  if (!expert) throw new Error('Expert profile not found');

  let stripeAccountId = expert.stripeConnectId;

  // Create account if it doesn't exist yet
  if (!stripeAccountId) {
    const account = await createConnectedAccount(expertId, expert.user.email);
    stripeAccountId = account.id;
  }

  // Always generate a fresh onboarding link (they expire after ~5 minutes)
  const onboardingUrl = await createOnboardingLink(stripeAccountId);

  return { onboardingUrl };
}
