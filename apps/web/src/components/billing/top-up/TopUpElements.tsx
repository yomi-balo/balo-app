'use client';

import { useMemo, useRef } from 'react';
import type { StripeElementsOptions } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { getStripe } from '@/lib/stripe/loader';

interface TopUpElementsProps {
  /**
   * The amount the Payment Element is created with. Read ONCE, at first render: the Element
   * is kept in sync afterwards via `elements.update({ amount })` in `PayAction`, and
   * re-creating `options.amount` on every slider tick would re-init the Element and lose typed
   * digits.
   */
  readonly initialAmountMinor: number;
  readonly children: React.ReactNode;
}

/** Whether a Stripe publishable key is configured — without one there is no Elements provider. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}

/**
 * The `<Elements>` provider every top-up surface mounts, so the options are identical wherever
 * `PayAction` and the payment section render. `PayAction` needs `useStripe()`/`useElements()`:
 * a `useStripe()` returning `null` silently disables Pay forever.
 *
 * NOTE: PM creation stays AUTOMATIC (do NOT set `paymentMethodCreation: 'manual'`). Manual PM
 * creation is mutually exclusive with `confirmPayment({ elements, … })` — Stripe.js throws an
 * IntegrationError, so the Pay button never charges.
 *
 * With no publishable key there is no provider to render: the children are returned
 * unwrapped, and the caller decides what to show instead of a payment section.
 */
export function TopUpElements({ initialAmountMinor, children }: Readonly<TopUpElementsProps>) {
  const initialAmount = useRef(initialAmountMinor).current;
  const options = useMemo<StripeElementsOptions>(
    () => ({
      mode: 'payment',
      amount: initialAmount,
      currency: 'aud',
      setupFutureUsage: 'off_session',
    }),
    [initialAmount]
  );
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  /**
   * The shared, per-key-memoised loader. `useMemo` keeps the promise identity stable across
   * renders — `<Elements>` treats a new promise as a new Stripe instance.
   */
  const stripePromise = useMemo(
    () => (publishableKey ? getStripe(publishableKey) : Promise.resolve(null)),
    [publishableKey]
  );

  if (!publishableKey) return <>{children}</>;
  return (
    <Elements stripe={stripePromise} options={options}>
      {children}
    </Elements>
  );
}
