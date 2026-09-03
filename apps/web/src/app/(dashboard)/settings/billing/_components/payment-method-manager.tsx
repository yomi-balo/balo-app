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
import { getStripe } from '@/lib/stripe-loader';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import { CardCapturePanel } from './card-capture-panel';
import { RemoveCardConfirm } from './remove-card-confirm';

interface PaymentMethodManagerProps {
  /** The EFFECTIVE saved card (coordinator's `cardRemoved` local-optimism already applied). */
  readonly card: SavedCard | null;
  /** The wallet's current low-balance mode, for the remove dialog's copy branch. */
  readonly currentMode: LowBalanceMode;
  /** Fired once `removeSavedCardAction` returns ok — the coordinator owns toast/track/repaint. */
  readonly onRemoved: (lowBalanceMode: LowBalanceMode, modeReconciled: boolean) => void;
}

type Phase = 'idle' | 'capturing' | 'finishing' | 'syncing';

const UNCONFIGURED_MESSAGE = "Card payments aren't configured right now. Please try again later.";
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

/** Strip the Stripe redirect-return query params so a refresh doesn't re-confirm the card. */
function clearRedirectParams(): void {
  globalThis.history.replaceState(null, '', globalThis.location.pathname);
}

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
 * `finishing` and `syncing` mirror `continue-to-mandate.tsx`'s redirect-return handling, adapted
 * for TWO capture entry points (Add empty-state, Change over an existing row) and for refreshing
 * the settings data afterward instead of just showing a static checkmark:
 *  - `finishing` — a mount effect (this component is ALWAYS mounted, unlike the capture panel)
 *    checks `?setup_intent_client_secret=` on mount; `succeeded` moves to `syncing`, `processing`
 *    stays `finishing` (params kept so a refresh re-checks), anything else clears the params and
 *    shows a transient inline retry message.
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
  cardRef.current = card;

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

  // 3DS/SCA redirect return — mirrors `continue-to-mandate.tsx`'s mount effect. Runs once; this
  // component (unlike the capture panel) is always mounted, so it survives the round trip.
  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    const clientSecret = params.get('setup_intent_client_secret');
    if (clientSecret === null) {
      return;
    }
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      return;
    }
    // No card shown at the moment the redirect returns ⇒ this was an Add attempt in flight.
    const inferredIntent: 'add' | 'change' = cardRef.current === null ? 'add' : 'change';
    let cancelled = false;

    // FIX ROUND (review MINOR) — every exit from `finishing` that is NOT a success must recover
    // to `idle`, or the whole Payment method section is a permanent spinner (a refresh re-enters
    // the same URL, hence the same stuck state). Guarded on `cancelled` so an unmounted/re-run
    // effect never fires a state update after the fact.
    const recoverToRetry = (): void => {
      if (cancelled) return;
      clearRedirectParams();
      setPhase('idle');
      setRedirectError(REDIRECT_RETRY_MESSAGE);
    };

    setPhase('finishing');
    getStripe(publishableKey)
      .then(async (stripe): Promise<void> => {
        if (stripe === null) {
          recoverToRetry();
          return;
        }
        if (cancelled) {
          return;
        }
        const { setupIntent } = await stripe.retrieveSetupIntent(clientSecret);
        if (cancelled) {
          return;
        }
        if (setupIntent?.status === 'succeeded') {
          clearRedirectParams();
          setCaptureIntent(inferredIntent);
          enterSyncing();
          return;
        }
        if (setupIntent?.status === 'processing') {
          // Leave the params in place so a refresh re-checks; the webhook finalises it.
          return;
        }
        recoverToRetry();
      })
      .catch(() => {
        recoverToRetry();
      });
    return (): void => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bounded post-capture sync poll — see the docblock.
  //
  // ⚠ FIX ROUND (security LOW) — `BILLING_CARD_SAVED` fires HERE, once the refreshed `card` prop
  // has ACTUALLY changed from the pre-capture snapshot, never from the redirect-return mount
  // effect alone. That effect trusts `?setup_intent_client_secret=` straight off the URL with no
  // binding to a SetupIntent this session started, so firing analytics there let a crafted link
  // make a victim's page report a card save that never happened. Gating on a real prop change —
  // server truth this component did not choose — closes that off cheaply without adding a nonce.
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
        description="The card Balo may charge for top-ups and for consultation time beyond your balance, once you turn that on above."
      >
        {!stripeConfigured && (
          <p className="text-muted-foreground mb-3 text-sm leading-relaxed">
            {UNCONFIGURED_MESSAGE}
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
