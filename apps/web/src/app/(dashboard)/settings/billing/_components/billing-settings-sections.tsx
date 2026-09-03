'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { describeSavedCard } from '@/components/billing/top-up/SavedCardRow';
import type { WalletSnapshot } from '@/components/billing/top-up/types';
import type { LowBalanceMode } from '@/lib/credit/actions';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import { LowBalanceSection, type LowBalanceDraft } from './low-balance-section';
import { PaymentMethodManager } from './payment-method-manager';

interface BillingSettingsSectionsProps {
  readonly wallet: WalletSnapshot;
}

const RECONCILED_REMOVE_TOAST = "Card removed — you're now on Just notify me.";
const PLAIN_REMOVE_TOAST = 'Card removed.';

/**
 * BAL-516 — thin CLIENT coordinator over the two holder-only billing-settings sections
 * ("When your balance runs low" + "Payment method"). Exists because a Server Component page
 * cannot pass callbacks between two client siblings, and card removal must repaint the mode
 * picker in the SAME paint the card disappears in.
 *
 * ⚠ The reconciled mode is NEVER guessed locally. `removeSavedCardAction` (via the `apps/api`
 * transaction) is the ONLY writer of the effective post-removal mode; this component only ever
 * displays what that response said (design "Why this can't be 'confirm now, reconcile silently
 * later'" — the reconciliation must land in the same response the removal does, and the UI must
 * repaint from that response's stated effective mode, never from local optimism).
 *
 * `cardRemoved` is local optimism for the CARD only — that half of the response is unambiguous
 * (the card is gone at Stripe and locally). `LowBalanceSection` is keyed on `reconcileNonce` and
 * re-seeded from `savedConfig` (server truth) so a reconcile REMOUNTS it already showing the
 * effective mode in one paint — not a second render pass, not a prop update the section has to
 * notice and reconcile itself. Ordinary Saves never bump the nonce, so the section is never
 * remounted mid-edit outside a reconcile. A reconcile DOES drop any dirty edit in flight in the
 * low-balance section — acceptable: the client was in the remove-card confirm dialog when it
 * happened, and the server's reconciled mode overrides whatever was mid-edit there.
 *
 * ⚠ FIX ROUND (review + UX CRITICAL) — `savedConfig` is the SOLE source for `currentMode` passed
 * to `PaymentMethodManager` (the remove dialog's mode-consequence copy). It starts seeded from
 * `wallet` at mount and is updated in exactly two places afterward: `LowBalanceSection`'s
 * `onSaved` (an in-session Save) and a reconciled removal (which overwrites just the `mode`
 * field, preserving the saved band). Previously `currentMode` read `wallet.lowBalanceMode`
 * directly — the PAGE-LOAD value — so a Save followed immediately by Remove showed the dialog's
 * NO-CONSEQUENCE branch right before the server silently changed the mode. Never re-seed
 * `savedConfig` from the `wallet` prop after mount — that would reintroduce the same staleness
 * one `router.refresh()` later.
 *
 * ⚠ FIX ROUND 2 (review NEW-1 — this was a REGRESSION, not a hypothetical) — "never re-seed"
 * above is only safe if this component REMOUNTS whenever the wallet's owning party changes. It
 * does not, on its own: the workspace switcher is a bare `router.refresh()` on this SAME route,
 * so a switch reconciles this coordinator IN PLACE and every one of `savedConfig`, `cardRemoved`
 * and `skipNextWalletUpdateRef` below would otherwise survive into a DIFFERENT company's wallet.
 * The fix is NOT here — it is the caller keying this component to the owning party
 * (`key={user.companyId}` in `settings/billing/page.tsx`), so a switch forces exactly the
 * fresh-mount this component's whole model assumes. Do not "fix" this file in isolation; if you
 * find this component reading stale state across a switch, the missing `key` upstream is almost
 * certainly why.
 *
 * ⚠ FIX ROUND (UX CRITICAL) — `cardRemoved` is reset back to `false` once a LATER Add/Change
 * flow's `router.refresh()` lands, so removing a card and then adding a new one in the SAME
 * visit can render the new card instead of pinning `effectiveCard` to `null` forever (the
 * original bug: the sync poll compared `null` to `null` and never saw a change, un-recoverable
 * short of a full reload). Detecting "landed" is NOT "the incoming `savedCard` is non-null" —
 * removal's OWN `router.refresh()` (called at the end of `handleRemoved`, AFTER
 * `removeSavedCardAction` has already awaited the server's detach) is what produces the very
 * next `wallet` prop update, and by the time that refetch resolves, the detach has already
 * committed server-side — so THAT specific update is guaranteed to carry `savedCard: null`. That
 * is a guarantee about SERVER-STATE ordering, not about this effect's own timing: `router.
 * refresh()` runs inside `handleRemoved`, not inside this effect, and this effect only sees the
 * result once React re-renders with the refetched `wallet`. A client can also legitimately
 * re-add the EXACT same physical card (same brand/last4/exp), so comparing card VALUES can't
 * distinguish "this is just the stale pre-removal snapshot" from "this is a genuinely re-added
 * card that happens to look identical". Instead, `skipNextWalletUpdateRef` unconditionally
 * consumes exactly the ONE `wallet` update immediately following a removal — regardless of what
 * it carries — and only reconciles `cardRemoved` against updates AFTER that; see the pinning
 * test in `billing-settings-sections.test.tsx` for why this must NOT be simplified to a bare
 * `cardRemoved && wallet.savedCard !== null` value check.
 */
export function BillingSettingsSections({
  wallet,
}: Readonly<BillingSettingsSectionsProps>): React.JSX.Element {
  const router = useRouter();
  const [cardRemoved, setCardRemoved] = useState(false);
  const [savedConfig, setSavedConfig] = useState<LowBalanceDraft>({
    mode: wallet.lowBalanceMode,
    reloadMinor: wallet.topupReloadMinor,
    thresholdMinor: wallet.topupThresholdMinor,
  });
  const [reconcileNonce, setReconcileNonce] = useState(0);

  const effectiveCard = cardRemoved ? null : wallet.savedCard;

  // See the docblock's C2 paragraph. Set alongside `cardRemoved`; consumed by the effect below.
  const skipNextWalletUpdateRef = useRef(false);

  useEffect(() => {
    if (skipNextWalletUpdateRef.current) {
      skipNextWalletUpdateRef.current = false;
      return;
    }
    if (cardRemoved && wallet.savedCard !== null) {
      setCardRemoved(false);
    }
    // `wallet` (object identity) is the deliberate sole dependency — see the docblock. A fresh
    // Server Component render always produces a new `wallet` object, so its identity IS "a
    // round trip landed"; `cardRemoved` is read from the latest render's closure without being
    // a dependency, precisely so this does NOT also re-run on the `setCardRemoved` call itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  const handleSaved = useCallback((config: LowBalanceDraft): void => {
    setSavedConfig(config);
  }, []);

  const handleRemoved = useCallback(
    (mode: LowBalanceMode, modeReconciled: boolean): void => {
      setCardRemoved(true);
      skipNextWalletUpdateRef.current = true;
      if (modeReconciled) {
        setSavedConfig((prev) => ({ ...prev, mode }));
        setReconcileNonce((n) => n + 1);
      }
      toast.success(modeReconciled ? RECONCILED_REMOVE_TOAST : PLAIN_REMOVE_TOAST);
      track(SETTINGS_EVENTS.BILLING_CARD_REMOVED, { mode_reconciled: modeReconciled });
      // Props catch up with the same server truth already reflected above — not the source of
      // the repaint, just eventual consistency for the rest of the (server-rendered) page tree.
      router.refresh();
    },
    [router]
  );

  return (
    <>
      <LowBalanceSection
        key={reconcileNonce}
        initialConfig={savedConfig}
        cardAvailable={effectiveCard !== null}
        cardLabel={effectiveCard ? describeSavedCard(effectiveCard) : null}
        mandateActive={effectiveCard?.mandateActive === true}
        onSaved={handleSaved}
      />
      <PaymentMethodManager
        card={effectiveCard}
        currentMode={savedConfig.mode}
        onRemoved={handleRemoved}
      />
    </>
  );
}
