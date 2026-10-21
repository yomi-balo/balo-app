import { getStripe } from '@/lib/stripe/loader';

/**
 * Resolve a `requires_action` mandate confirmation inline via `stripe.handleNextAction` (3DS),
 * mirroring `PayAction.captureMandate`'s abandoned-challenge rule: an abandoned challenge comes
 * back with NO error but the intent still `requires_action`, which must NOT count as captured —
 * that would tell the client automatic charging is on when it is not. Never throws; an
 * unconfigured key, a null Stripe instance, or a rejected `handleNextAction` all resolve `false`
 * (the warning state), never an unhandled rejection.
 */
export async function resolveSetupIntentNextAction(clientSecret: string): Promise<boolean> {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return false;
  }
  try {
    const stripe = await getStripe(publishableKey);
    if (stripe === null) {
      return false;
    }
    const { setupIntent, error } = await stripe.handleNextAction({ clientSecret });
    return !error && setupIntent?.status === 'succeeded';
  } catch {
    return false;
  }
}
