'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { toast } from 'sonner';
import { CheckCircle2, CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, PROMO_EVENTS } from '@/lib/analytics';
import { startContinueToMandate } from '../_actions/start-continue-to-mandate';

/**
 * ContinueToMandate — the Model-C hand-off (BAL-383). Rendered on the redeem success
 * screen: "when your promo balance runs out, add a card to keep going — no charge until
 * then." `promo_continue_prompt_shown` fires when this prompt renders (locked decision #3).
 *
 * On "Add a card" it calls `startContinueToMandate()` (internal seam →
 * `createSetupIntent`), mounts Stripe Elements with the returned client secret, and
 * confirms the card with `confirmSetup({ redirect: 'if_required' })`. Success fires
 * `promo_continue_card_captured` + a toast; the mandate itself is persisted by the
 * BAL-382 `setup_intent.succeeded` webhook (this component writes no mandate state).
 *
 * Any `@stripe/*` value import is browser-safe; there is NO `@balo/db` value import here
 * (the bundle footgun) — the Server Action owns all repository access.
 */

interface ContinueToMandateProps {
  readonly companyId: string;
}

type Phase =
  | { kind: 'prompt' }
  | { kind: 'form'; clientSecret: string; publishableKey: string }
  | { kind: 'active' }
  | { kind: 'finishing' }
  | { kind: 'captured' }
  | { kind: 'error'; message: string };

const GENERIC_START_ERROR = "We couldn't start card setup just now. Please try again in a moment.";
const FORBIDDEN_MESSAGE = 'Ask an owner or admin to add a card for your team.';
const REDIRECT_RETRY_MESSAGE =
  "That card couldn't be confirmed. You can add another to keep going.";

/** Strip the Stripe redirect-return query params so a refresh doesn't re-confirm the card. */
function clearRedirectParams(): void {
  globalThis.history.replaceState(null, '', globalThis.location.pathname);
}

// Memoise the Stripe.js loader per publishable key — calling `loadStripe` on every render
// would re-inject the script. A Map keyed on the key keeps a single promise per key.
const stripeLoaderCache = new Map<string, Promise<Stripe | null>>();
function getStripe(publishableKey: string): Promise<Stripe | null> {
  const cached = stripeLoaderCache.get(publishableKey);
  if (cached !== undefined) {
    return cached;
  }
  const created = loadStripe(publishableKey);
  stripeLoaderCache.set(publishableKey, created);
  return created;
}

/**
 * The card-capture form, mounted inside <Elements>. Confirms the SetupIntent and calls
 * `onCaptured` on success. `useStripe`/`useElements` are null until Elements is ready.
 */
function MandateCardForm({ onCaptured }: Readonly<{ onCaptured: () => void }>): React.JSX.Element {
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
        confirmParams: { return_url: globalThis.location.href },
        redirect: 'if_required',
      });
      if (confirmError) {
        setError(confirmError.message ?? "We couldn't save that card. Please try again.");
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCaptured();
    } catch {
      setError("We couldn't save that card. Please try again.");
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
      <PaymentElement />
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!stripe || submitting} className="w-full">
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : (
          'Save card'
        )}
      </Button>
    </form>
  );
}

export function ContinueToMandate({
  companyId,
}: Readonly<ContinueToMandateProps>): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'prompt' });
  const [isPending, startTransition] = useTransition();

  // Locked decision #3: fire when the continue prompt renders (BAL-378 owns the true
  // consume-time "balance exhausted" trigger).
  useEffect(() => {
    // A 3DS/SCA redirect return re-mounts this component with `setup_intent_client_secret`
    // in the URL — that is a card confirmation, not a fresh prompt render, so the
    // prompt-shown event must not fire again for it.
    const params = new URLSearchParams(globalThis.location.search);
    if (params.get('setup_intent_client_secret') !== null) {
      return;
    }
    track(PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN, { company_id: companyId });
  }, [companyId]);

  const handleAddCard = useCallback(() => {
    startTransition(async () => {
      const result = await startContinueToMandate();
      if (result.status === 'ready') {
        setPhase({
          kind: 'form',
          clientSecret: result.clientSecret,
          publishableKey: result.publishableKey,
        });
        return;
      }
      if (result.status === 'already_active') {
        setPhase({ kind: 'active' });
        return;
      }
      if (result.status === 'forbidden') {
        setPhase({ kind: 'error', message: FORBIDDEN_MESSAGE });
        return;
      }
      setPhase({ kind: 'error', message: GENERIC_START_ERROR });
    });
  }, []);

  const handleCaptured = useCallback(() => {
    track(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, { company_id: companyId });
    toast.success("Card added — you're set to keep going.");
    setPhase({ kind: 'captured' });
  }, [companyId]);

  // 3DS/SCA return (BAL-383). A card that needs authentication on mandate setup redirects the
  // browser away and back to /redeem with `setup_intent_client_secret` + `redirect_status`; the
  // inline confirm path never runs on that return. Retrieve the SetupIntent and mirror the same
  // success side-effects. The BAL-382 `setup_intent.succeeded` webhook stays the source of truth
  // for the mandate — this only confirms in the UI a card the webhook persists.
  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    const clientSecret = params.get('setup_intent_client_secret');
    if (clientSecret === null) {
      return;
    }
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      // Unconfigured (e.g. a preview env): skip the retrieve rather than crash the page.
      return;
    }
    let cancelled = false;
    setPhase({ kind: 'finishing' });
    getStripe(publishableKey)
      .then(async (stripe): Promise<void> => {
        if (stripe === null || cancelled) {
          return;
        }
        const { setupIntent } = await stripe.retrieveSetupIntent(clientSecret);
        if (cancelled) {
          return;
        }
        if (setupIntent?.status === 'succeeded') {
          clearRedirectParams();
          handleCaptured();
          return;
        }
        if (setupIntent?.status === 'processing') {
          // Leave the params in place so a refresh re-checks; the webhook finalises it.
          setPhase({ kind: 'finishing' });
          return;
        }
        clearRedirectParams();
        setPhase({ kind: 'error', message: REDIRECT_RETRY_MESSAGE });
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [handleCaptured]);

  if (phase.kind === 'captured' || phase.kind === 'active') {
    const message =
      phase.kind === 'captured'
        ? "Card added — you're all set to keep going when your promo balance runs out."
        : "You already have a card on file — you're all set to keep going.";
    return (
      <div className="border-success/30 bg-success/5 flex items-start gap-3 rounded-xl border p-5">
        <CheckCircle2 className="text-success mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p className="text-foreground text-sm leading-relaxed">{message}</p>
      </div>
    );
  }

  if (phase.kind === 'form') {
    return (
      <div className="border-border bg-card rounded-xl border p-5">
        <div className="mb-4 flex items-center gap-2">
          <CreditCard className="text-primary h-4 w-4" aria-hidden="true" />
          <h3 className="text-foreground text-sm font-semibold">Add a card to keep going</h3>
        </div>
        <p className="text-muted-foreground mb-4 text-sm leading-relaxed">
          Nothing is charged now. We&apos;ll only use this card once your promo balance runs out —
          and only when you choose to continue.
        </p>
        <Elements
          stripe={getStripe(phase.publishableKey)}
          options={{ clientSecret: phase.clientSecret }}
        >
          <MandateCardForm onCaptured={handleCaptured} />
        </Elements>
      </div>
    );
  }

  if (phase.kind === 'finishing') {
    return (
      <div className="border-border bg-card flex items-start gap-3 rounded-xl border p-5">
        <Loader2 className="text-primary mt-0.5 h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
        <p className="text-foreground text-sm leading-relaxed">
          Finishing up — just confirming your card…
        </p>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted/30 rounded-xl border p-5">
      <div className="mb-2 flex items-center gap-2">
        <CreditCard className="text-primary h-4 w-4" aria-hidden="true" />
        <h3 className="text-foreground text-sm font-semibold">
          Keep going when your credit runs out
        </h3>
      </div>
      <p className="text-muted-foreground mb-4 text-sm leading-relaxed">
        When your promo balance runs out, add a card to keep going — no charge until then.
      </p>
      {phase.kind === 'error' && (
        <p role="alert" className="text-destructive mb-3 text-sm">
          {phase.message}
        </p>
      )}
      <Button variant="outline" onClick={handleAddCard} disabled={isPending}>
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Starting…
          </>
        ) : (
          <>
            <CreditCard className="h-4 w-4" aria-hidden="true" />
            Add a card
          </>
        )}
      </Button>
    </div>
  );
}
