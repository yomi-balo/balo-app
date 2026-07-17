'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadStripe, type Stripe, type StripeElementsOptions } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { ArrowRight, Clock, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import {
  startPurchaseAction,
  type StartPurchaseInput,
  type LowBalanceMode,
} from '@/lib/credit/actions';
import { formatAud, formatIndicative, timeStr } from '@/lib/credit/display-constants';
import type { DisplayFxSnapshot } from './types';

/** Completion facts handed to the receipt (all client-observed; money lands via the webhook). */
export interface PurchaseCompletion {
  amountMinor: number;
  promoMinor: number;
  promoCode: string | null;
  lowBalanceMode: LowBalanceMode;
  mandateCaptured: boolean;
}

interface PaymentSectionProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly promoCode: string | null;
  readonly lowBalanceMode: LowBalanceMode;
  readonly fx: DisplayFxSnapshot | null;
  /**
   * Block Pay when the composer's configuration is invalid (e.g. an out-of-range auto-top-up
   * "Add"/"When below"). The offending field shows its own inline message in the mode picker,
   * so Pay is simply disabled here rather than surfacing a mis-attributed "amount" error.
   */
  readonly disabled?: boolean;
  readonly buildStartInput: () => StartPurchaseInput;
  readonly onComplete: (completion: PurchaseCompletion) => void;
}

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  stripePromise ??= loadStripe(key);
  return stripePromise;
}

const START_ERROR_COPY: Record<string, string> = {
  unauthorized: "You don't have permission to top up this balance.",
  no_wallet: "We couldn't find your team's balance. Please refresh and try again.",
  invalid_input: 'Something looks off with the amount. Please adjust and try again.',
  stripe_error: "We couldn't start the payment just now — no charge was made. Give it another go?",
};

/** Inner form — must live inside <Elements> to use `useStripe` / `useElements`. */
function PaymentForm({
  amountMinor,
  promoMinor,
  promoCode,
  lowBalanceMode,
  fx,
  disabled = false,
  buildStartInput,
  onComplete,
}: Readonly<PaymentSectionProps>) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState<'idle' | 'processing'>('idle');
  const [error, setError] = useState<string | null>(null);
  // One-shot shake on a charge error (reset on animationend); motion-reduce viewers get the
  // straight red highlight (the error line) instead of the shake.
  const [shake, setShake] = useState(false);
  const stopShake = useCallback(() => setShake(false), []);

  // Keep the PaymentElement's displayed amount in sync as the slider moves (deferred flow).
  useEffect(() => {
    if (elements) elements.update({ amount: amountMinor });
  }, [elements, amountMinor]);

  const fail = useCallback((message: string | null) => {
    setShake(true);
    setError(message ?? "That didn't go through — no charge was made. Want to try again?");
    setStatus('idle');
  }, []);

  const onPay = useCallback(async () => {
    if (!stripe || !elements || status === 'processing') return;

    track(CREDIT_EVENTS.PURCHASE_STARTED, {
      amount_minor: amountMinor,
      promo_applied: promoMinor > 0,
      funding_method: 'card',
      low_balance_mode: lowBalanceMode,
    });

    setStatus('processing');
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      fail(submitError.message ?? null);
      return;
    }

    const start = await startPurchaseAction(buildStartInput());
    if (!start.ok) {
      fail(START_ERROR_COPY[start.error] ?? START_ERROR_COPY.stripe_error ?? null);
      return;
    }

    const { error: payError, paymentIntent } = await stripe.confirmPayment({
      elements,
      clientSecret: start.clientSecret,
      confirmParams: { return_url: globalThis.location.href },
      redirect: 'if_required',
    });
    if (payError) {
      fail(payError.message ?? null);
      return;
    }
    if (
      paymentIntent &&
      paymentIntent.status !== 'succeeded' &&
      paymentIntent.status !== 'processing'
    ) {
      fail(null);
      return;
    }

    // Card-backed mode: capture the reusable off-session mandate with the just-saved payment
    // method (SetupIntent → webhook `applyMandate`). A mandate hiccup does NOT fail the
    // purchase — the money is already charged; the mode simply stays pending.
    let mandateCaptured = false;
    const savedPm =
      typeof paymentIntent?.payment_method === 'string'
        ? paymentIntent.payment_method
        : (paymentIntent?.payment_method?.id ?? null);
    if (start.setupClientSecret && savedPm) {
      const { error: setupError } = await stripe.confirmSetup({
        clientSecret: start.setupClientSecret,
        confirmParams: { payment_method: savedPm, return_url: globalThis.location.href },
        redirect: 'if_required',
      });
      mandateCaptured = !setupError;
    }

    onComplete({ amountMinor, promoMinor, promoCode, lowBalanceMode, mandateCaptured });
  }, [
    stripe,
    elements,
    status,
    amountMinor,
    promoMinor,
    promoCode,
    lowBalanceMode,
    buildStartInput,
    onComplete,
    fail,
  ]);

  const handlePayClick = useCallback(() => {
    onPay().catch(() => undefined);
  }, [onPay]);
  const totalMinor = amountMinor + promoMinor;

  return (
    <div className="space-y-4">
      <style>{`
        @keyframes topupShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
      `}</style>
      <PaymentElement />

      {error && (
        <p role="alert" className="text-destructive text-sm font-medium">
          {error}
        </p>
      )}

      <div className="border-border border-t pt-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px] font-semibold">
            <Clock className="size-3.5" strokeWidth={2.3} aria-hidden="true" /> Buys ≈{' '}
            {timeStr(totalMinor)}
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-foreground text-xl font-semibold tabular-nums">
              {formatAud(amountMinor)}
            </span>
            {fx && (
              <span className="text-muted-foreground text-xs font-medium">
                ≈ {formatIndicative(amountMinor, fx.currency, fx.audToQuote)}
              </span>
            )}
          </span>
        </div>

        <Button
          type="button"
          size="lg"
          onClick={handlePayClick}
          onAnimationEnd={stopShake}
          disabled={status === 'processing' || !stripe || disabled}
          className={cn(
            'from-primary w-full bg-gradient-to-br to-violet-600 text-white transition-transform active:scale-[0.98] motion-reduce:active:scale-100',
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

        <p className="text-muted-foreground mt-2.5 text-center text-[11px] leading-relaxed font-medium">
          {fx
            ? `You'll be charged approximately ${formatIndicative(amountMinor, fx.currency, fx.audToQuote)} in your local currency — the final amount is set at payment.`
            : "You'll be charged in AUD — your bank sets the final rate."}
        </p>
      </div>
    </div>
  );
}

/**
 * BAL-377 payment section — the inline Stripe Payment Element (deferred-PaymentIntent flow)
 * plus the Pay footer with the honest estimate. On Pay, the card is collected once and used to
 * (a) confirm the PaymentIntent (charge, SCA handled inline) and (b) for a card-backed mode,
 * confirm the SetupIntent with the saved payment method (reusable off-session mandate). The
 * wallet is credited by the shipped BAL-382 webhook — never here.
 */
export function PaymentSection(props: Readonly<PaymentSectionProps>) {
  const initialAmount = useRef(props.amountMinor).current;
  // NOTE: PM creation stays AUTOMATIC (do NOT set `paymentMethodCreation: 'manual'`). Manual
  // PM creation is mutually exclusive with `confirmPayment({ elements, … })` — Stripe.js throws
  // an IntegrationError, so the Pay button never charges. With automatic creation,
  // `confirmPayment` creates + confirms the PI from the Element and, because Elements + the PI
  // carry `setup_future_usage: 'off_session'`, saves/attaches the payment method; that saved PM
  // id is then reused to confirm the mandate SetupIntent.
  const options = useMemo<StripeElementsOptions>(
    () => ({
      mode: 'payment',
      amount: initialAmount,
      currency: 'aud',
      setupFutureUsage: 'off_session',
    }),
    [initialAmount]
  );

  if (!process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    return (
      <p className="text-muted-foreground text-sm font-medium">
        Card payments aren&apos;t configured right now. Please try again later.
      </p>
    );
  }

  return (
    <Elements stripe={getStripe()} options={options}>
      <PaymentForm {...props} />
    </Elements>
  );
}
