'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';
import { SectionCard } from '@/components/balo/section/section-states';
import { SavedCardRow } from '@/components/billing/top-up/SavedCardRow';
import type { SavedCard } from '@/components/billing/top-up/types';
import type { LowBalanceMode } from '@/lib/credit/actions';
import { removeSavedCardAction } from '@/lib/credit/actions';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import { useSetupIntentRedirectReturn } from '@/lib/stripe/use-setup-intent-redirect-return';
import { CardCapturePanel } from './card-capture-panel';
import { RemoveCardConfirm } from './remove-card-confirm';
import { STRIPE_UNCONFIGURED_MESSAGE } from './messages';

interface PaymentMethodManagerProps {
  /** The EFFECTIVE saved card (coordinator's `cardRemoved` local-optimism already applied). */
  readonly card: SavedCard | null;
  /** The wallet's current low-balance mode, for the remove dialog's copy branch. */
  readonly currentMode: LowBalanceMode;
  /** Fired once `removeSavedCardAction` returns ok — the coordinator owns toast/track/repaint. */
  readonly onRemoved: (lowBalanceMode: LowBalanceMode, modeReconciled: boolean) => void;
}

type Phase = 'idle' | 'capturing' | 'finishing' | 'syncing';

const REMOVE_FAILURE_MESSAGE = "We couldn't remove that card — please try again.";
const REDIRECT_RETRY_MESSAGE = "That card couldn't be confirmed. You can try again.";
const SYNC_FALLBACK_MESSAGE = "Your card was saved — refresh if you don't see it in a moment.";
/**
 * FIX ROUND (security MEDIUM) — the server refused removal because the wallet has unsettled
 * consultation time on this card (a live overdraft-grace session, or an open receivable). Warm
 * and factual per CLAUDE.md's copy rules, never adversarial.
 *
 * FIX ROUND 2 (security LOW — review NEW-2 / G3) — the original copy promised "Once that
 * settles you can remove it", naming an event the product cannot currently produce for the
 * OPEN-RECEIVABLE arm of this guard: a receivable is only ever cleared by a successful
 * settlement PaymentIntent, the dunning sweep only re-notifies (it never re-charges), and there
 * is no in-product "settle now" — so that promise can go unfulfilled indefinitely. This wording
 * names a REAL exit (reach out) instead of a guarantee nothing enforces — the same standard the
 * F5/F12 fixes held copy to. It does not drop the receivable arm of the guard.
 */
const SETTLEMENT_OUTSTANDING_MESSAGE =
  "There's unsettled consultation time on this card. Reach out and we'll get it squared away, then you can remove it.";

/** Bounded refresh-poll budget for the post-capture sync (design: "a few seconds total"). */
const SYNC_MAX_RETRIES = 2;
const SYNC_RETRY_DELAY_MS = 1500;

/**
 * Compare the display-relevant fields only — enough to detect "the refreshed prop is the new
 * card".
 *
 * ⚠ ACCEPTED COST (review NEW-3, fix round 2 G6) — this is a coarse brand/last4/exp compare, not
 * a Stripe payment-method id compare, so a client who replaces their card with a DIFFERENT
 * physical card that happens to share all four (rare, but possible — e.g. two cards from the
 * same issuer/product) sees NO `BILLING_CARD_SAVED` analytics event and the section falls
 * through to the "refresh if you don't see it" copy instead of the syncing message. This is the
 * deliberate, cheap trade F10's anti-spoof gate made (gate the event on a real prop change
 * rather than firing it unconditionally, which is what let a crafted redirect link report a
 * card save that never happened) — do not "fix" the false-negative by widening the compare or
 * redesigning the gate; ticket it if it needs to change.
 */
function sameSavedCard(a: SavedCard | null, b: SavedCard | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.brand === b.brand &&
    a.last4 === b.last4 &&
    a.expMonth === b.expMonth &&
    a.expYear === b.expYear
  );
}

/**
 * BAL-516 — "Payment method" section: `SavedCardRow` / empty state / capture panel / remove
 * dialog, as one phase machine (`idle | capturing | finishing | syncing`, plus the remove
 * dialog's own open/pending flags — a removal overlays `idle`, it does not replace it).
 *
 * `finishing` and `syncing` mirror `continue-to-mandate.tsx`'s redirect-return handling — both
 * consume the shared `useSetupIntentRedirectReturn` hook (BAL-526), which is bound to the
 * SetupIntent this tab actually started (`@/lib/stripe/setup-intent-return`) so a crafted
 * `?setup_intent=` link cannot paint a false "Card saved" here — adapted for TWO capture entry
 * points (Add empty-state, Change over an existing row) and for refreshing the settings data
 * afterward instead of just showing a static checkmark:
 *  - `finishing` — entered when the hook's `onStarted` fires for a BOUND return (this component
 *    is ALWAYS mounted, unlike the capture panel); `onSucceeded` moves to `syncing`,
 *    `onProcessing` stays `finishing` (params + binding kept so a refresh re-checks), `onFailed`
 *    shows a transient inline retry message. An unbound/crafted return is completely inert — no
 *    phase change at all.
 *  - `syncing` — `router.refresh()` was just called; if the incoming `card` prop still equals the
 *    PRE-capture snapshot after up to two more refreshes (1500ms apart), fall back to an honest
 *    "refresh if you don't see it" line rather than spinning forever.
 *
 * Stripe-unconfigured (`!NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`): the empty-state "Add a card"
 * button is a real `disabled` HTML button; "Change" (part of the REUSED, unmodified
 * `SavedCardRow`) has no external disabled hook, so it is made INERT here instead — pressing it
 * while unconfigured does not open the capture panel. Removal never needs Stripe.js client-side,
 * so it stays live either way.
 */
export function PaymentMethodManager({
  card,
  currentMode,
  onRemoved,
}: Readonly<PaymentMethodManagerProps>): React.JSX.Element {
  const router = useRouter();
  const stripeConfigured = Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

  const [phase, setPhase] = useState<Phase>('idle');
  const [captureIntent, setCaptureIntent] = useState<'add' | 'change'>('add');
  const [redirectError, setRedirectError] = useState<string | null>(null);
  const [syncFallback, setSyncFallback] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [removeBlockedReason, setRemoveBlockedReason] = useState<string | null>(null);

  const preCaptureSnapshotRef = useRef<SavedCard | null>(null);
  const syncRetriesRef = useRef(0);
  const cardRef = useRef(card);
  // BAL-526 (bundled (b)) — AN EFFECT, NOT A RENDER-PHASE WRITE. Declared before the redirect
  // hook so the ref is current before `handleRedirectStarted` reads it. `useRef(card)` above
  // already seeds it on the first render, so mount ordering is safe either way — this effect
  // exists for every render after.
  //
  // ⚠ HONESTY NOTE (FIX ROUND 1, B2) — this is the CORRECT React pattern (a render pass must not
  // have side effects; a bare `cardRef.current = card` statement in the render body is one), but
  // no test in this file actually PINS it. The two candidate pins were tried and rejected:
  //   · a React "Cannot update … during render" warning — that warning fires only for a
  //     `setState` call during a DIFFERENT component's render, never for a ref mutation;
  //   · a rerender-before-the-retrieve-resolves race (mount with `card={null}`, rerender to a
  //     real card while `retrieveSetupIntent` is still pending, then resolve `succeeded`) —
  //     verified EMPIRICALLY to behave IDENTICALLY whether this write is a render-phase
  //     statement or this effect: `enterSyncing()`'s snapshot always runs strictly after the
  //     rerender's synchronous commit+effects have already landed, in both versions, so
  //     `cardRef.current` is already the new prop either way by the time it is read.
  // No claim of "verified by a test that bites" is made here. FIX ROUND 2 (F-D) — nothing
  // catches a regression here: not this suite, and not `pnpm lint` — verified clean with the
  // render-phase write restored (`eslint-plugin-react-hooks`'s recommended config here is
  // rules-of-hooks + exhaustive-deps only, no compiler rule that flags this), and
  // `pnpm lint:sonar:diff` was clean over the same restoration too. This rests on review.
  useEffect(() => {
    cardRef.current = card;
  }, [card]);

  const enterSyncing = useCallback((): void => {
    preCaptureSnapshotRef.current = cardRef.current;
    syncRetriesRef.current = 0;
    setSyncFallback(false);
    setRedirectError(null);
    setPhase('syncing');
    router.refresh();
  }, [router]);

  const handleAdd = useCallback(() => {
    if (!stripeConfigured) return;
    setCaptureIntent('add');
    setRedirectError(null);
    setPhase('capturing');
  }, [stripeConfigured]);

  const handleChange = useCallback(() => {
    if (!stripeConfigured) return;
    setCaptureIntent('change');
    setRedirectError(null);
    setPhase('capturing');
  }, [stripeConfigured]);

  const handleCancelCapture = useCallback(() => {
    setPhase('idle');
  }, []);

  const handleCaptured = useCallback(() => {
    enterSyncing();
  }, [enterSyncing]);

  const handleOpenRemove = useCallback(() => {
    setRemoveBlockedReason(null);
    setRemoveDialogOpen(true);
  }, []);

  const handleRemoveDialogOpenChange = useCallback((nextOpen: boolean) => {
    setRemoveDialogOpen(nextOpen);
    if (!nextOpen) {
      setRemoveBlockedReason(null);
    }
  }, []);

  const handleRemoveConfirm = useCallback(() => {
    setRemovePending(true);
    removeSavedCardAction()
      .then((result) => {
        setRemovePending(false);
        if (result.ok) {
          setRemoveDialogOpen(false);
          onRemoved(result.lowBalanceMode, result.modeReconciled);
          return;
        }
        if (result.error === 'settlement_outstanding') {
          // FIX ROUND (security MEDIUM) — the server refused: an active overdraft session or an
          // open receivable is still outstanding on this wallet. Block, don't just toast — the
          // dialog stays open with factual copy rather than the generic failure message.
          setRemoveBlockedReason(SETTLEMENT_OUTSTANDING_MESSAGE);
          return;
        }
        toast.error(REMOVE_FAILURE_MESSAGE);
      })
      .catch(() => {
        setRemovePending(false);
        toast.error(REMOVE_FAILURE_MESSAGE);
      });
  }, [onRemoved]);

  // BAL-526 — the shared 3DS/SCA redirect-return hook, bound to the SetupIntent this tab
  // actually started. An unbound/crafted return is completely inert (see the hook's docblock);
  // these callbacks only ever run for a genuine return.
  const handleRedirectStarted = useCallback((): void => {
    // ⚠ THE INFERENCE SNAPSHOT INSTANT IS PRESERVED. The shipped code computed add-vs-change at
    // MOUNT (before any `router.refresh()` could land a new card and flip the label). `onStarted`
    // fires synchronously inside the same mount effect, so this is the same instant. Reading it
    // in `onSucceeded` instead would be a behaviour change (a webhook that lands mid-retrieve
    // could relabel 'add' as 'change').
    setCaptureIntent(cardRef.current === null ? 'add' : 'change');
    setPhase('finishing');
  }, []);

  const handleRedirectSucceeded = useCallback((): void => {
    enterSyncing();
  }, [enterSyncing]);

  const handleRedirectProcessing = useCallback((): void => {
    setPhase('finishing'); // stay put; params + binding kept so a refresh re-checks
  }, []);

  const handleRedirectFailed = useCallback((message: string): void => {
    setPhase('idle');
    setRedirectError(message);
  }, []);

  useSetupIntentRedirectReturn({
    retryMessage: REDIRECT_RETRY_MESSAGE,
    onStarted: handleRedirectStarted,
    onSucceeded: handleRedirectSucceeded,
    onProcessing: handleRedirectProcessing,
    onFailed: handleRedirectFailed,
  });

  // Bounded post-capture sync poll — see the docblock.
  //
  // ⚠ FIX ROUND (security LOW) — `BILLING_CARD_SAVED` fires HERE, once the refreshed `card` prop
  // has ACTUALLY changed from the pre-capture snapshot, never from the redirect-return mount
  // effect alone. BEFORE BAL-526, that effect trusted `?setup_intent_client_secret=` straight off
  // the URL with no binding to a SetupIntent this session started, so firing analytics there let a
  // crafted link make a victim's page report a card save that never happened. BAL-526 now binds
  // every redirect return to a SetupIntent this tab actually started (see
  // `@/lib/stripe/setup-intent-return`) — but the gate below stays regardless: it is a second,
  // independent check on server truth this component did not choose, and dropping it would leave
  // `BILLING_CARD_SAVED` trusting the redirect-return path alone again.
  useEffect(() => {
    if (phase !== 'syncing') {
      return;
    }
    if (!sameSavedCard(card, preCaptureSnapshotRef.current)) {
      track(SETTINGS_EVENTS.BILLING_CARD_SAVED, { intent: captureIntent });
      setPhase('idle');
      return;
    }
    if (syncRetriesRef.current >= SYNC_MAX_RETRIES) {
      setSyncFallback(true);
      return;
    }
    const timer = setTimeout(() => {
      syncRetriesRef.current += 1;
      router.refresh();
    }, SYNC_RETRY_DELAY_MS);
    return (): void => clearTimeout(timer);
  }, [phase, card, router, captureIntent]);

  return (
    <>
      <SectionCard
        title="Payment method"
        description="The card Balo may charge to settle consultation time beyond your balance, and for automatic top-ups if you turn those on."
      >
        {!stripeConfigured && (
          <p className="text-muted-foreground mb-3 text-sm leading-relaxed">
            {STRIPE_UNCONFIGURED_MESSAGE}
          </p>
        )}

        {phase === 'capturing' && (
          <CardCapturePanel onCancel={handleCancelCapture} onCaptured={handleCaptured} />
        )}

        {phase === 'finishing' && (
          <div className="flex items-center gap-3">
            <Loader2 className="text-primary size-5 shrink-0 animate-spin" aria-hidden="true" />
            <p className="text-foreground text-sm leading-relaxed">
              Finishing up — just confirming your card…
            </p>
          </div>
        )}

        {phase === 'syncing' && (
          <div className="flex items-center gap-3">
            {!syncFallback && (
              <Loader2 className="text-primary size-5 shrink-0 animate-spin" aria-hidden="true" />
            )}
            <p className="text-foreground text-sm leading-relaxed">
              {syncFallback ? SYNC_FALLBACK_MESSAGE : 'Card saved — updating your payment method…'}
            </p>
          </div>
        )}

        {phase === 'idle' && (
          <>
            {redirectError !== null && (
              <p role="alert" className="text-destructive mb-3 text-sm">
                {redirectError}
              </p>
            )}
            {card === null ? (
              <button
                type="button"
                onClick={handleAdd}
                disabled={!stripeConfigured}
                className="border-primary/40 text-primary hover:bg-primary/5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus className="size-4" aria-hidden="true" />
                Add a card
              </button>
            ) : (
              <SavedCardRow card={card} onChange={handleChange} onRemove={handleOpenRemove} />
            )}
          </>
        )}
      </SectionCard>

      {card !== null && (
        <RemoveCardConfirm
          card={card}
          mode={currentMode}
          open={removeDialogOpen}
          onOpenChange={handleRemoveDialogOpenChange}
          pending={removePending}
          onConfirm={handleRemoveConfirm}
          blockedReason={removeBlockedReason}
        />
      )}
    </>
  );
}
