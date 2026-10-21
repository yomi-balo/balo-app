import type { Stripe, StripeElements } from '@stripe/stripe-js';
import {
  armSavedCardMandateAction,
  saveLowBalanceConfigAction,
  startCardCaptureAction,
} from '@/lib/credit/actions';
import type { BookingTopUpWallet } from '@/lib/booking/actions/booking-funding-types';
import { resolveSetupIntentNextAction } from '@/lib/stripe/resolve-setup-next-action';

export type PayAfterFailure =
  | 'declined'
  | 'auth_failed'
  | 'setup_failed'
  | 'arm_failed'
  | 'settlement_outstanding'
  | 'error';

/** `silent` marks a failure the Payment Element already explains itself, so no copy is added. */
export type StepResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PayAfterFailure; readonly silent?: true };

type Figures = BookingTopUpWallet['lowBalanceFigures'];

const OK: StepResult = { ok: true };

/**
 * Switches the wallet to Keep me going, sending the wallet's stored figures back unchanged. A
 * refusal (no card on file, no permission, invalid input) is a failed setup.
 */
export async function switchToKeepGoing(figures: Figures): Promise<StepResult> {
  const saved = await saveLowBalanceConfigAction({
    lowBalanceMode: 'keep_going',
    topupReloadMinor: figures.topupReloadMinor,
    topupThresholdMinor: figures.topupThresholdMinor,
  });
  return saved.ok ? OK : { ok: false, reason: 'setup_failed' };
}

export interface ArmSavedCardHooks {
  /** Called once the bank's challenge is about to open, so the block can say it is waiting. */
  readonly onAuthenticating: () => void;
}

/**
 * The saved-card path: switch to Keep me going, then arm the mandate on the card already on file,
 * resolving a bank challenge inline. The mandate is live only when the wallet says so; the
 * caller waits for that.
 */
export async function armSavedCard(
  figures: Figures,
  hooks: ArmSavedCardHooks
): Promise<StepResult> {
  const switched = await switchToKeepGoing(figures);
  if (!switched.ok) return switched;
  const armed = await armSavedCardMandateAction({ clientRequestId: crypto.randomUUID() });
  if (!armed.ok) return { ok: false, reason: 'arm_failed' };
  if (armed.outcome === 'captured') return OK;
  hooks.onAuthenticating();
  const confirmed = await resolveSetupIntentNextAction(armed.clientSecret);
  return confirmed ? OK : { ok: false, reason: 'auth_failed' };
}

/**
 * The new-card path: validate the Element, open a SetupIntent, confirm it inline. Validation
 * errors return `error` with no copy, because the Element shows its own message. The low-balance
 * setting is NOT written here; the caller writes it only once the mandate is seen active.
 */
export async function captureNewCard(
  stripe: Stripe,
  elements: StripeElements
): Promise<StepResult> {
  const submitted = await elements.submit();
  if (submitted.error) return { ok: false, reason: 'error', silent: true };
  const started = await startCardCaptureAction();
  if (!started.ok) {
    return {
      ok: false,
      reason:
        started.error === 'settlement_outstanding' ? 'settlement_outstanding' : 'setup_failed',
    };
  }
  const { error } = await stripe.confirmSetup({
    elements,
    clientSecret: started.clientSecret,
    confirmParams: {
      return_url: `${globalThis.location.origin}${globalThis.location.pathname}`,
    },
    redirect: 'if_required',
  });
  if (!error) return OK;
  if (error.code === 'setup_intent_authentication_failure') {
    return { ok: false, reason: 'auth_failed' };
  }
  return { ok: false, reason: error.type === 'card_error' ? 'declined' : 'error' };
}
