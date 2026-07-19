'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TopUpHero } from './TopUpHero';
import { AmountSlider } from './AmountSlider';
import { PromoField, type AppliedPromo } from './PromoField';
import { FundingChoice } from './FundingChoice';
import { LowBalanceModePicker } from './LowBalanceModePicker';
import { PaymentSection, type PurchaseCompletion } from './PaymentSection';
import { TopUpReceipt } from './TopUpReceipt';
import { DEFAULT_AMOUNT_MINOR, autoTopupConfigErrors } from '@/lib/credit/display-constants';
import type { StartPurchaseInput, LowBalanceMode } from '@/lib/credit/actions';
import type { WalletSnapshot, DisplayFxSnapshot, FundingMethod } from './types';

interface TopUpComposerProps {
  readonly wallet: WalletSnapshot;
  readonly fx: DisplayFxSnapshot | null;
  readonly onClose?: () => void;
}

/**
 * BAL-377 top-up composer — the single decision surface (not a wizard). Owns the amount /
 * promo / funding / mode / reload / threshold state and orchestrates the zones: dark hero →
 * amount → options → inline Stripe payment. Swaps to the receipt (Step 2) on a successful
 * charge. The wallet is credited by the shipped BAL-382 webhook; the receipt is optimistic.
 */
export function TopUpComposer({ wallet, fx, onClose }: Readonly<TopUpComposerProps>) {
  const router = useRouter();
  const [amountMinor, setAmountMinor] = useState(DEFAULT_AMOUNT_MINOR);
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [funding] = useState<FundingMethod>('card'); // Invoice is v1-disabled (LOCKED)
  // Default to a card-backed mode — under Card funding a card is captured inline at Pay.
  const [mode, setMode] = useState<LowBalanceMode>(wallet.lowBalanceMode);
  const [reloadMinor, setReloadMinor] = useState(wallet.topupReloadMinor);
  const [thresholdMinor, setThresholdMinor] = useState(wallet.topupThresholdMinor);
  const [completion, setCompletion] = useState<PurchaseCompletion | null>(null);

  const promoMinor = promo?.minor ?? 0;
  // Under Card funding, a first-time card is captured inline, so card-backed modes are usable.
  const cardAvailable = funding === 'card';

  // Inline validation of the auto-top-up "Add"/"When below" inputs. A bad combo shows a
  // field-level message in the mode picker AND blocks Pay — so a config error never surfaces as
  // a mis-attributed "amount looks off" error under the Pay button (server `invalid_input`).
  const configErrors = autoTopupConfigErrors(mode, reloadMinor, thresholdMinor);
  const configValid = configErrors.reload === undefined && configErrors.threshold === undefined;

  // Stable across double-submits of the SAME configuration; regenerated when the amount /
  // mode / promo / reload / threshold change → the server idempotency key stays honest. Held
  // in a ref keyed by a config signature (a lint-clean derived value — no hook deps array),
  // so a re-render with the same configuration reuses the same UUID and a double-click returns
  // the same PaymentIntent.
  const signature = `${amountMinor}:${mode}:${promo?.code ?? ''}:${reloadMinor}:${thresholdMinor}`;
  const requestIdRef = useRef({ signature, id: globalThis.crypto.randomUUID() });
  if (requestIdRef.current.signature !== signature) {
    requestIdRef.current = { signature, id: globalThis.crypto.randomUUID() };
  }
  const clientRequestId = requestIdRef.current.id;

  const handleApplied = useCallback((applied: AppliedPromo) => setPromo(applied), []);
  const handleRemoved = useCallback(() => setPromo(null), []);

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
    }),
    [amountMinor, clientRequestId, promo?.code, mode, reloadMinor, thresholdMinor]
  );

  // Invoice is v1-disabled, so Card stays selected — funding never actually changes.
  const noopFunding = useCallback(() => undefined, []);
  const handleComplete = useCallback((result: PurchaseCompletion) => setCompletion(result), []);
  const handleDone = useCallback(() => {
    if (onClose) onClose();
    else router.push('/dashboard');
  }, [onClose, router]);
  const handleFindExpert = useCallback(() => router.push('/experts'), [router]);

  const shellClass =
    'w-full max-w-[540px] overflow-hidden rounded-2xl border border-border bg-card shadow-sm';

  if (completion) {
    return (
      <div className={shellClass}>
        <TopUpReceipt
          completion={completion}
          previousBalanceMinor={wallet.balanceMinor}
          onFindExpert={handleFindExpert}
          onDone={handleDone}
        />
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <TopUpHero amountMinor={amountMinor} promoMinor={promoMinor} funding={funding} fx={fx} />

      <div className="px-6 pt-5 pb-1.5">
        <AmountSlider
          amountMinor={amountMinor}
          promoMinor={promoMinor}
          onAmountChange={setAmountMinor}
        />
      </div>

      <div className="flex flex-col gap-5 px-6 py-5">
        <PromoField promo={promo} onApplied={handleApplied} onRemoved={handleRemoved} />
        <FundingChoice funding={funding} onFundingChange={noopFunding} />
        <LowBalanceModePicker
          mode={mode}
          onModeChange={setMode}
          reloadMinor={reloadMinor}
          thresholdMinor={thresholdMinor}
          onReloadChange={setReloadMinor}
          onThresholdChange={setThresholdMinor}
          cardAvailable={cardAvailable}
          errors={configErrors}
        />
      </div>

      <div className="border-border bg-muted/20 border-t px-6 py-5">
        <PaymentSection
          amountMinor={amountMinor}
          promoMinor={promoMinor}
          promoCode={promo?.code ?? null}
          lowBalanceMode={mode}
          fx={fx}
          disabled={!configValid}
          buildStartInput={buildStartInput}
          onComplete={handleComplete}
        />
      </div>
    </div>
  );
}
