'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BaloCard } from '@/components/balo/card/balo-card';
import { TopUpHero } from './TopUpHero';
import { AmountSlider } from './AmountSlider';
import { PromoField, type AppliedPromo } from './PromoField';
import { LowBalanceModePicker } from './LowBalanceModePicker';
import { PaymentMethodSection } from './PaymentMethodSection';
import { PayAction } from './PayAction';
import { SummaryRail } from './SummaryRail';
import { MobilePayBar } from './MobilePayBar';
import { TopUpReceipt } from './TopUpReceipt';
import { TopUpElements, isStripeConfigured } from './TopUpElements';
import { usePurchaseRequestId } from './use-purchase-request-id';
import { describeSavedCard } from './SavedCardRow';
import { useContainerLayout, type TopUpLayout } from './use-container-layout';
import { DEFAULT_AMOUNT_MINOR, autoTopupConfigErrors } from '@/lib/credit/display-constants';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import type { StartPurchaseInput, LowBalanceMode } from '@/lib/credit/actions';
import type { PaymentMethodSource } from '@/lib/credit/api-client';
import type { WalletSnapshot, DisplayFxSnapshot, PurchaseCompletion } from './types';

interface TopUpComposerProps {
  readonly wallet: WalletSnapshot;
  readonly fx: DisplayFxSnapshot | null;
  readonly onClose?: () => void;
  /**
   * The caller's known-at-render layout. The route passes `'wide'`, the Dialog/Sheet
   * `'stacked'` — see `useContainerLayout` for why the viewport is the wrong signal.
   */
  readonly layoutHint?: TopUpLayout;
}

/**
 * BAL-377 top-up composer, re-laid as the "decide left, confirm right" surface (top-up
 * redesign). The left column carries everything the buyer decides or types — amount → promo →
 * low-balance mode → payment method; the right column is a sticky summary rail carrying the
 * hero, the totals and Pay, so the argument for paying never scrolls away from the button that
 * does it. Below 900px of CONTAINER width (and always inside the dialog) the rail becomes a
 * compact hero on top and a sticky pay bar at the thumb.
 *
 * ⚠ `<Elements>` WRAPS BOTH COLUMNS, and that is the whole reason it lives here rather than in
 * the payment section. `PayAction` needs `useStripe()`/`useElements()`, and it renders in the
 * rail — a SIBLING of the payment section, not a descendant. A `useStripe()` returning `null`
 * silently disables Pay forever, so nothing else was moved along with the provider.
 *
 * Swaps to the receipt on a successful charge. The wallet is credited by the shipped BAL-382
 * webhook; the receipt is optimistic.
 */
export function TopUpComposer({
  wallet,
  fx,
  onClose,
  layoutHint = 'wide',
}: Readonly<TopUpComposerProps>) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const layout = useContainerLayout(containerRef, layoutHint);

  const [amountMinor, setAmountMinor] = useState(DEFAULT_AMOUNT_MINOR);
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [mode, setMode] = useState<LowBalanceMode>(wallet.lowBalanceMode);
  const [reloadMinor, setReloadMinor] = useState(wallet.topupReloadMinor);
  const [thresholdMinor, setThresholdMinor] = useState(wallet.topupThresholdMinor);
  // A returning buyer starts on their saved card; a first-timer has only the new-card path.
  const [paymentMethodSource, setPaymentMethodSource] = useState<PaymentMethodSource>(
    wallet.savedCard === null ? 'new_card' : 'saved_card'
  );
  const [completion, setCompletion] = useState<PurchaseCompletion | null>(null);

  const promoMinor = promo?.minor ?? 0;
  // Every path is a card now (Invoice is gone from the UI), so card-backed modes are always
  // usable — a first-time card is captured inline at Pay, a returning card is already on file.
  const cardAvailable = true;
  /**
   * BAL-535 fix round 2 (F3) — will an overrun actually settle to a card afterward? This is the
   * wallet's REAL state, never `cardAvailable`. `projectSavedCard` yields a non-null `savedCard`
   * only when a Stripe customer AND payment method are both on file, and stamps `mandateActive`
   * from `mandate_status === 'active'` — together exactly `isWalletMandateActive`, the predicate
   * `settleOverdraft` itself gates on.
   *
   * A first-time buyer therefore reads `false` and is NOT told their overrun "settles to the card
   * on file", which was false at the moment they read it: the card they are about to enter is
   * captured inline at Pay, and the off-session mandate is captured separately after that.
   */
  const settlesToCardOnFile = wallet.savedCard?.mandateActive === true;

  // Inline validation of the auto-top-up "Add"/"When below" inputs. A bad combo shows a
  // field-level message in the mode picker AND blocks Pay — so a config error never surfaces as
  // a mis-attributed "amount looks off" error under the Pay button (server `invalid_input`).
  const configErrors = autoTopupConfigErrors(mode, reloadMinor, thresholdMinor);
  const configValid = configErrors.reload === undefined && configErrors.threshold === undefined;

  // Stable across double-submits of the SAME configuration; regenerated when the amount /
  // mode / promo / reload / threshold / PAYMENT-METHOD SOURCE change, and rotated on a decline
  // (see `usePurchaseRequestId` for why both matter).
  const { clientRequestId, rotate: handleCardDeclined } = usePurchaseRequestId(
    `${amountMinor}:${mode}:${promo?.code ?? ''}:${reloadMinor}:${thresholdMinor}:${paymentMethodSource}`
  );
  const handleApplied = useCallback((applied: AppliedPromo) => setPromo(applied), []);
  const handleRemoved = useCallback(() => setPromo(null), []);

  const handleSourceChange = useCallback((next: PaymentMethodSource) => {
    setPaymentMethodSource(next);
    track(CREDIT_EVENTS.PAYMENT_METHOD_CHANGED, { to: next, surface: 'billing' });
  }, []);
  const handleUseDifferentCard = useCallback(
    () => handleSourceChange('new_card'),
    [handleSourceChange]
  );

  const buildStartInput = useCallback(
    (): StartPurchaseInput => ({
      amountMinor,
      clientRequestId,
      promoCode: promo?.code,
      config: {
        lowBalanceMode: mode,
        topupReloadMinor: reloadMinor,
        topupThresholdMinor: thresholdMinor,
      },
      paymentMethodSource,
    }),
    [
      amountMinor,
      clientRequestId,
      promo?.code,
      mode,
      reloadMinor,
      thresholdMinor,
      paymentMethodSource,
    ]
  );

  const handleComplete = useCallback((result: PurchaseCompletion) => setCompletion(result), []);
  const handleDone = useCallback(() => {
    if (onClose) onClose();
    else router.push('/dashboard');
  }, [onClose, router]);
  const handleFindExpert = useCallback(() => router.push('/experts'), [router]);

  const usingSavedCard = wallet.savedCard !== null && paymentMethodSource === 'saved_card';
  const payingWith =
    usingSavedCard && wallet.savedCard !== null ? describeSavedCard(wallet.savedCard) : 'New card';
  const stripeConfigured = isStripeConfigured();

  if (completion) {
    return (
      <BaloCard className="w-full overflow-hidden">
        <TopUpReceipt
          completion={completion}
          previousBalanceMinor={wallet.balanceMinor}
          onFindExpert={handleFindExpert}
          onDone={handleDone}
        />
      </BaloCard>
    );
  }

  const decisions = (
    <div className="flex flex-col gap-[22px]">
      <AmountSlider
        amountMinor={amountMinor}
        promoMinor={promoMinor}
        onAmountChange={setAmountMinor}
      />
      <PromoField promo={promo} onApplied={handleApplied} onRemoved={handleRemoved} />
      <LowBalanceModePicker
        mode={mode}
        onModeChange={setMode}
        reloadMinor={reloadMinor}
        thresholdMinor={thresholdMinor}
        onReloadChange={setReloadMinor}
        onThresholdChange={setThresholdMinor}
        cardAvailable={cardAvailable}
        settlesToCardOnFile={settlesToCardOnFile}
        errors={configErrors}
        cardLabel={usingSavedCard && wallet.savedCard ? describeSavedCard(wallet.savedCard) : null}
      />
      {stripeConfigured ? (
        <PaymentMethodSection
          savedCard={wallet.savedCard}
          source={paymentMethodSource}
          onSourceChange={handleSourceChange}
        />
      ) : (
        <p className="text-muted-foreground text-sm font-medium">
          Card payments aren&apos;t configured right now. Please try again later.
        </p>
      )}
    </div>
  );

  const payAction = (compact: boolean): React.ReactNode =>
    stripeConfigured ? (
      <PayAction
        amountMinor={amountMinor}
        promoMinor={promoMinor}
        promoCode={promo?.code ?? null}
        promoCodeId={promo?.promoCodeId ?? null}
        lowBalanceMode={mode}
        paymentMethodSource={paymentMethodSource}
        disabled={!configValid}
        compact={compact}
        buildStartInput={buildStartInput}
        onComplete={handleComplete}
        onUseDifferentCard={handleUseDifferentCard}
        onCardDeclined={handleCardDeclined}
      />
    ) : null;

  const body =
    layout === 'wide' ? (
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6">
        <BaloCard className="p-6">{decisions}</BaloCard>
        <div className="sticky top-5">
          <SummaryRail
            amountMinor={amountMinor}
            promoMinor={promoMinor}
            promoCode={promo?.code ?? null}
            fx={fx}
            payingWith={payingWith}
            payAction={payAction(false)}
          />
        </div>
      </div>
    ) : (
      <BaloCard className="flex w-full flex-col overflow-hidden">
        <TopUpHero amountMinor={amountMinor} promoMinor={promoMinor} fx={fx} compact />
        <div className="px-5 pt-[18px] pb-6">{decisions}</div>
        <MobilePayBar
          amountMinor={amountMinor}
          promoMinor={promoMinor}
          payAction={payAction(true)}
        />
      </BaloCard>
    );

  // With no publishable key there is no Elements provider to render — the payment section is
  // replaced by the "not configured" line above and Pay is omitted entirely.
  return (
    <div ref={containerRef} className="w-full">
      <TopUpElements initialAmountMinor={amountMinor}>{body}</TopUpElements>
    </div>
  );
}
