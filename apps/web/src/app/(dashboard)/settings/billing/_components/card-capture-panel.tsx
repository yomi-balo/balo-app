'use client';

import { useCallback, useEffect, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getStripe } from '@/lib/stripe-loader';
import { startCardCaptureAction } from '@/lib/credit/actions';
import { forgetSetupIntent, rememberSetupIntent } from '@/lib/stripe/setup-intent-return';
import { STRIPE_UNCONFIGURED_MESSAGE } from './messages';

interface CardCapturePanelProps {
  readonly onCancel: () => void;
  readonly onCaptured: () => void;
}

/**
 * The capture-moment mandate disclosure (design "Mandate consent copy") — distinct from
 * `LowBalanceModePicker`'s usage-moment disclosure. Shown above the Payment Element every time,
 * Add and Change alike, because saving a card via this panel always arms the mandate capability.
 */
const CONSENT_LINE =
  "This card won't be charged today. Saving it lets Balo settle consultation time you use " +
  'beyond your balance, and buy credit for you automatically if you turn on Auto top-up. ' +
  'You can remove the card anytime to stop both.';

const START_ERROR_MESSAGE = "We couldn't start card setup just now. Please try again in a moment.";
const CONFIRM_FAILURE_MESSAGE = "We couldn't save that card. Please try again.";
/**
 * FIX ROUND 2 (security MEDIUM — NEW-1) — the server refused a card CHANGE because the wallet
 * has a live overdraft-grace session; see `startCardCaptureAction`'s docblock. Warm and factual
 * per CLAUDE.md's copy rules — this is a wait, not a dead end (the session ends on its own).
 */
const SETTLEMENT_OUTSTANDING_MESSAGE =
  "There's unsettled consultation time in progress on this card. Once that session ends you can change it.";

type StartPhase =
  | { kind: 'starting' }
  | { kind: 'ready'; clientSecret: string; publishableKey: string }
  | { kind: 'error'; message: string };

/** The Save/Cancel form, mounted INSIDE `<Elements>`. `useStripe`/`useElements` are null until
 * Elements is ready. */
function CaptureForm({
  onCancel,
  onCaptured,
}: Readonly<{ onCancel: () => void; onCaptured: () => void }>): React.JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runConfirm = useCallback(async (): Promise<void> => {
    if (!stripe || !elements) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { error: confirmError } = await stripe.confirmSetup({
        elements,
        // A2 (security) — NEVER `location.href`. An unbound return is now deliberately LEFT in
        // the URL (correct for the griefing threat this ticket closes), so `location.href` would
        // bake any crafted `?setup_intent=…` already present into `return_url`, and Stripe would
        // append a SECOND, genuine pair after it. `URLSearchParams.get` reads the FIRST
        // (attacker's) pair, so the real return would go unmatched — the user's own capture would
        // silently vanish. Origin + pathname only, never the query string.
        confirmParams: {
          return_url: `${globalThis.location.origin}${globalThis.location.pathname}`,
        },
        redirect: 'if_required',
      });
      if (confirmError) {
        setError(confirmError.message ?? CONFIRM_FAILURE_MESSAGE);
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCaptured();
    } catch {
      setError(CONFIRM_FAILURE_MESSAGE);
      setSubmitting(false);
    }
  }, [stripe, elements, onCaptured]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      runConfirm().catch(() => undefined);
    },
    [runConfirm]
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-muted-foreground text-xs leading-relaxed">{CONSENT_LINE}</p>
      <PaymentElement />
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={!stripe || submitting} className="w-full sm:w-auto">
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save card'
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
          className="w-full sm:w-auto"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * BAL-516 — the settings Add/Change card capture panel. Mirrors `continue-to-mandate.tsx`'s
 * `MandateCardForm` structurally: a FRESH `<Elements>` instance, mounted only once
 * `startCardCaptureAction()` resolves `ok`, so "Cancel" here makes zero server calls — this
 * Elements instance is dedicated to this panel and nothing else depends on it staying mounted
 * (unlike the composer's purchase-scoped instance, which must never unmount).
 *
 * The 3DS/SCA redirect-return check lives on `PaymentMethodManager` (always mounted, unlike this
 * panel), not here — see that component's docblock.
 */
export function CardCapturePanel({
  onCancel,
  onCaptured,
}: Readonly<CardCapturePanelProps>): React.JSX.Element {
  const [phase, setPhase] = useState<StartPhase>({ kind: 'starting' });

  useEffect(() => {
    let cancelled = false;
    startCardCaptureAction()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          // BAL-526 — bind the SetupIntent BEFORE `<Elements>` can mount, so the binding always
          // exists before any `confirmSetup` can redirect.
          rememberSetupIntent(result.setupIntentId);
          setPhase({
            kind: 'ready',
            clientSecret: result.clientSecret,
            publishableKey: result.publishableKey,
          });
          return;
        }
        let message = START_ERROR_MESSAGE;
        if (result.error === 'unconfigured') {
          message = STRIPE_UNCONFIGURED_MESSAGE;
        } else if (result.error === 'settlement_outstanding') {
          message = SETTLEMENT_OUTSTANDING_MESSAGE;
        }
        setPhase({ kind: 'error', message });
      })
      .catch(() => {
        if (!cancelled) setPhase({ kind: 'error', message: START_ERROR_MESSAGE });
      });
    return (): void => {
      cancelled = true;
    };
    // A fresh panel mount is a fresh capture attempt — deliberately run once per mount.
  }, []);

  // BAL-526 — the writer is the clearer: `redirect: 'if_required'` resolving inline (no 3DS
  // redirect) means the binding written above will never see a redirect-return hook, so this
  // path must clear it itself or it becomes an inert orphan (harmless, but hygiene per the
  // lifecycle table). The redirect-return path clears via the shared hook instead.
  const handleCaptured = useCallback((): void => {
    forgetSetupIntent();
    onCaptured();
  }, [onCaptured]);

  if (phase.kind === 'starting') {
    return (
      <output aria-label="Loading" className="block space-y-3">
        <span className="bg-muted/50 block h-11 w-full animate-pulse rounded-md" />
        <span className="sr-only">Starting card setup…</span>
      </output>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-destructive text-sm">
          {phase.message}
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Elements
      stripe={getStripe(phase.publishableKey)}
      options={{ clientSecret: phase.clientSecret }}
    >
      <CaptureForm onCancel={onCancel} onCaptured={handleCaptured} />
    </Elements>
  );
}
