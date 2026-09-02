'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadStripe, type Stripe, type StripeElementsOptions } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { TopUpHero } from './TopUpHero';
import { AmountSlider } from './AmountSlider';
import { PromoField, type AppliedPromo } from './PromoField';
import { LowBalanceModePicker } from './LowBalanceModePicker';
import { PaymentMethodSection } from './PaymentMethodSection';
import { PayAction } from './PayAction';
import { SummaryRail } from './SummaryRail';
import { MobilePayBar } from './MobilePayBar';
import { TopUpReceipt } from './TopUpReceipt';
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

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  stripePromise ??= loadStripe(key);
  return stripePromise;
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

  // Inline validation of the auto-top-up "Add"/"When below" inputs. A bad combo shows a
  // field-level message in the mode picker AND blocks Pay — so a config error never surfaces as
  // a mis-attributed "amount looks off" error under the Pay button (server `invalid_input`).
  const configErrors = autoTopupConfigErrors(mode, reloadMinor, thresholdMinor);
  const configValid = configErrors.reload === undefined && configErrors.threshold === undefined;

  // Stable across double-submits of the SAME configuration; regenerated when the amount /
  // mode / promo / reload / threshold / PAYMENT-METHOD SOURCE change → the server idempotency
  // key stays honest. Held in a ref keyed by a config signature (a lint-clean derived value —
  // no hook deps array), so a re-render with the same configuration reuses the same UUID and a
  // double-click returns the same PaymentIntent.
  //
  // ⚠ `paymentMethodSource` IS PART OF THE SIGNATURE ON PURPOSE. The two sources build
  // PaymentIntents with DIFFERENT params (one carries `payment_method` + `confirm: true`), and
  // Stripe 400s on the same idempotency key with different params — so without this, Pay would
  // die permanently the moment a buyer pressed "Change".
  //
  // ⚠ SO IS `declineNonce`. Stripe caches a 402 `card_declined` against the key (the endpoint
  // DID execute), so retrying the same configuration replays the cached decline for 24h
  // without ever contacting the issuer — `insufficient_funds` and try-again-later declines
  // would be permanent for this amount/card. PayAction bumps the nonce on every decline, so
  // the next Pay press is a genuinely new attempt.
  const [declineNonce, setDeclineNonce] = useState(0);
  const signature = `${amountMinor}:${mode}:${promo?.code ?? ''}:${reloadMinor}:${thresholdMinor}:${paymentMethodSource}:${declineNonce}`;
  const requestIdRef = useRef({ signature, id: globalThis.crypto.randomUUID() });
  if (requestIdRef.current.signature !== signature) {
    requestIdRef.current = { signature, id: globalThis.crypto.randomUUID() };
  }
  const clientRequestId = requestIdRef.current.id;

  const handleCardDeclined = useCallback(() => setDeclineNonce((n) => n + 1), []);
  const handleApplied = useCallback((applied: AppliedPromo) => setPromo(applied), []);
  const handleRemoved = useCallback(() => setPromo(null), []);

  const handleSourceChange = useCallback((next: PaymentMethodSource) => {
    setPaymentMethodSource(next);
    track(CREDIT_EVENTS.PAYMENT_METHOD_CHANGED, { to: next });
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

  // Frozen at first render: the Payment Element is created once with this amount and then kept
  // in sync via `elements.update({ amount })` in PayAction. Re-creating `options.amount` on
  // every slider tick would re-init the Element (and lose typed digits).
  const initialAmount = useRef(amountMinor).current;
  // NOTE: PM creation stays AUTOMATIC (do NOT set `paymentMethodCreation: 'manual'`). Manual
  // PM creation is mutually exclusive with `confirmPayment({ elements, … })` — Stripe.js throws
  // an IntegrationError, so the Pay button never charges.
  const options = useMemo<StripeElementsOptions>(
    () => ({
      mode: 'payment',
      amount: initialAmount,
      currency: 'aud',
      setupFutureUsage: 'off_session',
    }),
    [initialAmount]
  );

  const usingSavedCard = wallet.savedCard !== null && paymentMethodSource === 'saved_card';
  const payingWith =
    usingSavedCard && wallet.savedCard !== null ? describeSavedCard(wallet.savedCard) : 'New card';
  const stripeConfigured = Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

  if (completion) {
    return (
      <div className="border-border bg-card w-full overflow-hidden rounded-2xl border shadow-sm">
        <TopUpReceipt
          completion={completion}
          previousBalanceMinor={wallet.balanceMinor}
          onFindExpert={handleFindExpert}
          onDone={handleDone}
        />
      </div>
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
        <div className="border-border bg-card rounded-2xl border p-6 shadow-sm">{decisions}</div>
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
      <div className="border-border bg-card flex w-full flex-col overflow-hidden rounded-2xl border shadow-sm">
        <TopUpHero amountMinor={amountMinor} promoMinor={promoMinor} fx={fx} compact />
        <div className="px-5 pt-[18px] pb-6">{decisions}</div>
        <MobilePayBar
          amountMinor={amountMinor}
          promoMinor={promoMinor}
          payAction={payAction(true)}
        />
      </div>
    );

  // With no publishable key there is no Elements provider to render — the payment section is
  // replaced by the "not configured" line above and Pay is omitted entirely.
  return (
    <div ref={containerRef} className="w-full">
      {stripeConfigured ? (
        <Elements stripe={getStripe()} options={options}>
          {body}
        </Elements>
      ) : (
        body
      )}
    </div>
  );
}
