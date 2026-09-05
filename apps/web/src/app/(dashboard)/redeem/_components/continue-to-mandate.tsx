'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { toast } from 'sonner';
import { CheckCircle2, CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, PROMO_EVENTS } from '@/lib/analytics';
import { getStripe } from '@/lib/stripe-loader';
import { useSetupIntentRedirectReturn } from '@/lib/stripe/use-setup-intent-redirect-return';
import {
  forgetSetupIntent,
  isSetupIntentReturnBound,
  rememberSetupIntent,
} from '@/lib/stripe/setup-intent-return';
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
    // A 3DS/SCA redirect return re-mounts this component with the SetupIntent params in the
    // URL — that is a card confirmation, not a fresh prompt render, so the prompt-shown event
    // must not fire again for it. BAL-526 — this is now BOUND, not a raw params check: a
    // crafted `/redeem` link is no longer treated as a confirmation return, so the component
    // really is rendering a fresh prompt and PROMO_CONTINUE_PROMPT_SHOWN correctly fires for it.
    // Genuine returns are still suppressed. Declared before the redirect hook — both read the
    // binding synchronously on mount, before any `await` resolves, so ordering is safe either
    // way, but this makes the read-then-clear sequence obvious.
    if (isSetupIntentReturnBound()) {
      return;
    }
    track(PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN, { company_id: companyId });
  }, [companyId]);

  const handleAddCard = useCallback(() => {
    startTransition(async () => {
      const result = await startContinueToMandate();
      if (result.status === 'ready') {
        // BAL-526 — bind the SetupIntent BEFORE `<Elements>` can mount, so the binding always
        // exists before any `confirmSetup` can redirect.
        rememberSetupIntent(result.setupIntentId);
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
    // BAL-526 — the writer is the clearer for the non-redirect path; idempotent, so the
    // double-clear on the redirect path (the hook already cleared it) is harmless. Guarded —
    // cannot throw — so it stays ahead of the phase update.
    forgetSetupIntent();
    // F-B — `setPhase` MUST run before anything that can throw. `track()` → `posthog.capture` is
    // unguarded (no try/catch anywhere on that path), and this is also the hook's `onSucceeded`:
    // a throw here used to run BEFORE the phase update, so a posthog failure left the redirect
    // path stuck on "Finishing up…" forever even though the card was already saved server-side.
    // The hook's own docblock (see B3/F-E) deliberately lets that throw escape as an unhandled
    // rejection rather than swallowing it — Sentry still sees it — but only because callers are
    // expected to set their state first, which is what this ordering now guarantees.
    setPhase({ kind: 'captured' });
    track(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, { company_id: companyId });
    toast.success("Card added — you're set to keep going.");
  }, [companyId]);

  // BAL-526 — the shared 3DS/SCA redirect-return hook, bound to the SetupIntent this tab
  // actually started. An unbound/crafted return is completely inert (see the hook's docblock).
  // `handleCaptured` is both the inline (non-redirect) success handler AND the hook's
  // `onSucceeded`.
  const handleRedirectStarted = useCallback(() => setPhase({ kind: 'finishing' }), []);
  const handleRedirectProcessing = useCallback(() => setPhase({ kind: 'finishing' }), []);
  const handleRedirectFailed = useCallback(
    (message: string) => setPhase({ kind: 'error', message }),
    []
  );

  useSetupIntentRedirectReturn({
    retryMessage: REDIRECT_RETRY_MESSAGE,
    onStarted: handleRedirectStarted,
    onSucceeded: handleCaptured,
    onProcessing: handleRedirectProcessing,
    onFailed: handleRedirectFailed,
  });

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
