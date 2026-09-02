'use client';

import { useCallback, useEffect, useState } from 'react';
import { useElements, useStripe } from '@stripe/react-stripe-js';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import {
  startPurchaseAction,
  type StartPurchaseInput,
  type StartPurchaseResult,
  type MandateOutcome,
} from '@/lib/credit/actions';
import { formatAud } from '@/lib/credit/display-constants';
import type { PaymentMethodSource } from '@/lib/credit/api-client';
import type { PurchaseCompletion } from './types';

interface PayActionProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly promoCode: string | null;
  readonly lowBalanceMode: StartPurchaseInput['config']['lowBalanceMode'];
  readonly paymentMethodSource: PaymentMethodSource;
  /**
   * Block Pay when the composer's configuration is invalid (e.g. an out-of-range auto-top-up
   * "Add"/"When below"). The offending field shows its own inline message in the mode picker,
   * so Pay is simply disabled here rather than surfacing a mis-attributed "amount" error.
   */
  readonly disabled?: boolean;
  /** Compact styling for the mobile pay bar (auto width, tighter padding). */
  readonly compact?: boolean;
  readonly buildStartInput: () => StartPurchaseInput;
  readonly onComplete: (completion: PurchaseCompletion) => void;
  /** Offer "Use a different card" after a decline — flips the composer to the new-card path. */
  readonly onUseDifferentCard: () => void;
}

/**
 * Copy per failure code. `stripe_error` and `saved_card_error` are DELIBERATELY different and
 * must never be merged: on the new-card path nothing was charged, but on the saved-card path
 * the charge is attempted inside the Server Action, so "no charge was made" would be a lie
 * about the buyer's money.
 */
/** The two halves of the Server Action's result, named so the charge helpers can take one. */
type StartSuccess = Extract<StartPurchaseResult, { ok: true }>;
type StartFailure = Extract<StartPurchaseResult, { ok: false }>;

const START_ERROR_COPY: Record<string, string> = {
  unauthorized: "You don't have permission to top up this balance.",
  invalid_input: 'Something looks off with the amount. Please adjust and try again.',
  stripe_error: "We couldn't start the payment just now — no charge was made. Give it another go?",
  saved_card_error:
    'Something went wrong finishing your top-up — check your balance before trying again.',
  no_saved_card: "We couldn't find your saved card. Enter a card to continue.",
  card_declined: 'Your card was declined. Try a different card?',
};

/**
 * The Pay button and the whole charge orchestration.
 *
 * ⚠ MUST RENDER INSIDE `<Elements>`: `useStripe()` / `useElements()` only resolve there, and a
 * `useStripe()` that returns `null` silently disables Pay forever. Because this control lives in
 * the summary rail — a SIBLING column of the payment section, not a descendant — the provider is
 * hoisted to the composer root. That hoist is the reason this component exists.
 *
 * Two charge paths, one button:
 *  · NEW CARD  — `elements.submit()` → `startPurchaseAction` → `stripe.confirmPayment`. This is
 *    the shipped flow, lifted verbatim.
 *  · SAVED CARD — no Element to submit and the browser never learns the payment-method id, so
 *    the api creates AND confirms the PaymentIntent. `complete` goes straight to the receipt;
 *    `requires_action` runs 3DS via `handleNextAction`; a decline surfaces inline with a
 *    "use a different card" escape.
 *
 * The wallet is credited by the shipped BAL-382 webhook — NEVER from any return value here.
 */
export function PayAction({
  amountMinor,
  promoMinor,
  promoCode,
  lowBalanceMode,
  paymentMethodSource,
  disabled = false,
  compact = false,
  buildStartInput,
  onComplete,
  onUseDifferentCard,
}: Readonly<PayActionProps>) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState<'idle' | 'processing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  // One-shot shake on a charge error (reset on animationend); motion-reduce viewers get the
  // straight red highlight (the error line) instead of the shake.
  const [shake, setShake] = useState(false);
  const stopShake = useCallback(() => setShake(false), []);

  const usingSavedCard = paymentMethodSource === 'saved_card';

  // Keep the PaymentElement's displayed amount in sync as the slider moves (deferred flow).
  useEffect(() => {
    if (elements) elements.update({ amount: amountMinor });
  }, [elements, amountMinor]);

  const fail = useCallback((message: string | null) => {
    setShake(true);
    setError(message ?? "That didn't go through — no charge was made. Want to try again?");
    setStatus('idle');
  }, []);

  /**
   * Finish the card-backed mandate and report whether it is genuinely captured.
   *
   * ⚠ THE ANSWER COMES FROM THE STATED OUTCOME, NEVER FROM A NULLABLE SECRET. `succeeded`,
   * `failed` and a secret-less `requires_action` all used to arrive as `null`, and treating any
   * null on the saved-card path as "captured" told a buyer whose mandate had just been REFUSED
   * that automatic charging was on — the receipt's warning suppressed, `MANDATE_CAPTURED` fired,
   * the wallet stuck at `pending` with nothing to ever tell them.
   *
   * A hiccup in the browser step still never fails the purchase — the money is already charged;
   * the mode simply stays uncaptured and the receipt surfaces its warning.
   */
  const captureMandate = useCallback(
    async (mandate: MandateOutcome, savedPaymentMethodId: string | null): Promise<boolean> => {
      if (mandate.outcome !== 'requires_action') {
        return mandate.outcome === 'captured';
      }
      if (!stripe) return false;
      if (usingSavedCard) {
        // 3DS on a mandate the api already confirmed server-side against the stored card.
        const { error: actionError } = await stripe.handleNextAction({
          clientSecret: mandate.clientSecret,
        });
        return !actionError;
      }
      if (savedPaymentMethodId === null) return false;
      const { error: setupError } = await stripe.confirmSetup({
        clientSecret: mandate.clientSecret,
        confirmParams: {
          payment_method: savedPaymentMethodId,
          return_url: globalThis.location.href,
        },
        redirect: 'if_required',
      });
      return !setupError;
    },
    [stripe, usingSavedCard]
  );

  /**
   * NEW CARD — confirm the PaymentIntent against the mounted Payment Element. Resolves to the
   * payment-method id Stripe saved (the mandate SetupIntent must be confirmed against the SAME
   * card), or `null` when the charge did not go through, with the buyer-facing error already set.
   */
  const confirmNewCard = useCallback(
    async (clientSecret: string): Promise<{ paymentMethodId: string | null } | null> => {
      if (!stripe || !elements) {
        fail(null);
        return null;
      }
      const { error: payError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: { return_url: globalThis.location.href },
        redirect: 'if_required',
      });
      if (payError) {
        fail(payError.message ?? null);
        return null;
      }
      if (
        paymentIntent &&
        paymentIntent.status !== 'succeeded' &&
        paymentIntent.status !== 'processing'
      ) {
        fail(null);
        return null;
      }
      const method = paymentIntent?.payment_method;
      return { paymentMethodId: typeof method === 'string' ? method : (method?.id ?? null) };
    },
    [stripe, elements, fail]
  );

  /**
   * SAVED CARD — the api already created AND confirmed the PaymentIntent; the browser only
   * answers the 3DS challenge. `handleNextAction` never needs the payment-method id, which is
   * why the browser is never told it.
   */
  const confirmSavedCard = useCallback(
    async (clientSecret: string): Promise<boolean> => {
      if (!stripe) return false;
      const { error: actionError } = await stripe.handleNextAction({ clientSecret });
      if (actionError) {
        fail(actionError.message ?? null);
        return false;
      }
      return true;
    },
    [stripe, fail]
  );

  /** Take the Server Action's outcome to a settled charge, whichever arm it came back on. */
  const confirmCharge = useCallback(
    async (start: StartSuccess): Promise<{ paymentMethodId: string | null } | null> => {
      if (start.outcome === 'needs_client_confirmation') {
        return confirmNewCard(start.clientSecret);
      }
      if (start.outcome === 'requires_action') {
        return (await confirmSavedCard(start.clientSecret)) ? { paymentMethodId: null } : null;
      }
      // 'complete' — settled server-side, nothing for the browser to do.
      return { paymentMethodId: null };
    },
    [confirmNewCard, confirmSavedCard]
  );

  /** Surface a start-time failure, with the decline escape hatch when the card was refused. */
  const reportStartFailure = useCallback(
    (start: StartFailure) => {
      if (start.error === 'card_declined') {
        setDeclined(true);
        track(CREDIT_EVENTS.PURCHASE_DECLINED, {
          amount_minor: amountMinor,
          decline_code: start.declineCode ?? null,
        });
      }
      fail(START_ERROR_COPY[start.error] ?? START_ERROR_COPY.stripe_error ?? null);
    },
    [amountMinor, fail]
  );

  const onPay = useCallback(async () => {
    if (!stripe || status === 'processing') return;
    // The new-card path needs an Elements instance to submit; the saved-card path does not.
    if (!usingSavedCard && !elements) return;

    track(CREDIT_EVENTS.PURCHASE_STARTED, {
      amount_minor: amountMinor,
      promo_applied: promoMinor > 0,
      funding_method: 'card',
      low_balance_mode: lowBalanceMode,
      payment_method_source: paymentMethodSource,
    });

    setStatus('processing');
    setError(null);
    setDeclined(false);

    if (!usingSavedCard && elements) {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        fail(submitError.message ?? null);
        return;
      }
    }

    const start = await startPurchaseAction(buildStartInput());
    if (!start.ok) {
      reportStartFailure(start);
      return;
    }

    const charged = await confirmCharge(start);
    if (charged === null) return;

    const mandateCaptured = await captureMandate(start.mandate, charged.paymentMethodId);

    // ⚠ `paymentIntentId` RIDES ALONG ON EVERY `ok` ARM — it is present on all three by
    // construction, and dropping it here is exactly what left the receipt unable to ask the
    // wallet whether the credit landed. It is the poll's terminal key, not a credit grant.
    onComplete({
      amountMinor,
      promoMinor,
      promoCode,
      lowBalanceMode,
      mandateCaptured,
      paymentIntentId: start.paymentIntentId,
    });
  }, [
    stripe,
    elements,
    status,
    usingSavedCard,
    amountMinor,
    promoMinor,
    promoCode,
    lowBalanceMode,
    paymentMethodSource,
    buildStartInput,
    onComplete,
    confirmCharge,
    captureMandate,
    reportStartFailure,
    fail,
  ]);

  const handlePayClick = useCallback(() => {
    onPay().catch(() => undefined);
  }, [onPay]);

  return (
    <div>
      <style>{`
        @keyframes topupShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
      `}</style>

      {error && (
        <p role="alert" className="text-destructive mb-2.5 text-sm font-medium">
          {error}
        </p>
      )}

      {declined && (
        <div className="mb-2.5">
          <button
            type="button"
            onClick={onUseDifferentCard}
            className="text-primary focus-visible:ring-ring relative rounded text-sm font-semibold before:absolute before:-inset-2 before:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
          >
            Use a different card
          </button>
        </div>
      )}

      <Button
        type="button"
        size="lg"
        onClick={handlePayClick}
        onAnimationEnd={stopShake}
        disabled={status === 'processing' || !stripe || disabled}
        className={cn(
          'from-primary bg-gradient-to-br to-violet-600 text-white transition-transform active:scale-[0.98] motion-reduce:active:scale-100',
          compact ? 'w-auto whitespace-nowrap' : 'w-full',
          shake && 'motion-safe:animate-[topupShake_0.4s_ease-in-out] motion-reduce:animate-none'
        )}
      >
        {status === 'processing' ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Processing…
          </>
        ) : (
          <>
            Pay {formatAud(amountMinor)}{' '}
            <ArrowRight className="size-4" strokeWidth={2.6} aria-hidden="true" />
          </>
        )}
      </Button>
    </div>
  );
}
