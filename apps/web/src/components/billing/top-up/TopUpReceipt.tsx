'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Check, ArrowRight, Gift, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import { formatAud, formatAudShort, timeStr } from '@/lib/credit/display-constants';
import type { PurchaseCompletion } from './PaymentSection';

interface TopUpReceiptProps {
  readonly completion: PurchaseCompletion;
  readonly previousBalanceMinor: number;
  readonly onFindExpert: () => void;
  readonly onDone: () => void;
}

/**
 * BAL-377 receipt (Step 2) — a restrained triumph. Fires the client-observed completion
 * analytics on mount (PURCHASE_COMPLETED, plus PROMO_REDEEMED / MANDATE_CAPTURED when
 * relevant), shows the new balance (optimistic — the webhook is the authoritative source),
 * the rolling-expiry reassurance, and a "Find an expert" next-best-action. A Sonner toast
 * confirms in parallel. NO fee figure (BAL-357).
 */
export function TopUpReceipt({
  completion,
  previousBalanceMinor,
  onFindExpert,
  onDone,
}: Readonly<TopUpReceiptProps>) {
  const fired = useRef(false);
  const { amountMinor, promoMinor, promoCode, lowBalanceMode, mandateCaptured } = completion;
  const newBalanceMinor = previousBalanceMinor + amountMinor + promoMinor;

  // The charge succeeded but the mandate SetupIntent for a card-backed mode did not complete
  // (SCA abandoned / declined). This degrades safely — the wallet stays `mandate_status:
  // pending` and BAL-378/379 only ever act on `active` — but the user's stated intent is
  // silently inactive, so surface a gentle, non-blocking retry note (design principle 4).
  const cardBackedIntent = lowBalanceMode === 'auto_topup' || lowBalanceMode === 'keep_going';
  const mandateIncomplete = cardBackedIntent && !mandateCaptured;

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    track(CREDIT_EVENTS.PURCHASE_COMPLETED, {
      amount_minor: amountMinor,
      promo_applied: promoMinor > 0,
      funding_method: 'card',
      low_balance_mode: lowBalanceMode,
    });
    if (promoMinor > 0 && promoCode) {
      track(CREDIT_EVENTS.PROMO_REDEEMED, { code: promoCode, bonus_minor: promoMinor });
    }
    if (mandateCaptured && (lowBalanceMode === 'auto_topup' || lowBalanceMode === 'keep_going')) {
      track(CREDIT_EVENTS.MANDATE_CAPTURED, { low_balance_mode: lowBalanceMode });
    }
    toast.success(`Payment confirmed — ${formatAud(amountMinor)} added.`);
  }, [amountMinor, promoMinor, promoCode, lowBalanceMode, mandateCaptured]);

  return (
    <div className="px-7 py-10 text-center">
      <div className="bg-success/15 text-success motion-safe:animate-in motion-safe:zoom-in-50 mx-auto flex size-14 items-center justify-center rounded-full">
        <Check className="size-7" strokeWidth={2.6} aria-hidden="true" />
      </div>

      <h2 className="text-foreground mt-5 text-xl font-semibold">You&apos;re topped up</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Your balance is now{' '}
        <span className="text-foreground font-semibold tabular-nums">
          {formatAud(newBalanceMinor)}
        </span>{' '}
        — ≈ {timeStr(newBalanceMinor)} of expert time, ready when you are.
      </p>

      <div className="border-border bg-muted/20 mx-auto mt-6 max-w-sm rounded-xl border p-4 text-left text-sm">
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">Added to balance</span>
          <span className="text-foreground font-semibold tabular-nums">
            {formatAud(amountMinor)}
          </span>
        </div>
        {promoMinor > 0 && (
          <div className="flex justify-between py-1">
            <span className="text-success inline-flex items-center gap-1.5">
              <Gift className="size-3.5" strokeWidth={2.4} aria-hidden="true" /> Promo bonus
            </span>
            <span className="text-success font-semibold tabular-nums">
              +{formatAudShort(promoMinor)}
            </span>
          </div>
        )}
        <div className="border-border mt-1 flex justify-between border-t pt-2">
          <span className="text-foreground font-medium">New balance</span>
          <span className="text-foreground font-semibold tabular-nums">
            {formatAud(newBalanceMinor)}
          </span>
        </div>
      </div>

      <p className="text-muted-foreground mx-auto mt-4 max-w-sm text-xs">
        Any consultation or top-up keeps your balance going — nothing is left hanging.
      </p>

      {mandateIncomplete && (
        <div className="border-warning/40 bg-warning/10 mx-auto mt-4 flex max-w-sm items-start gap-2 rounded-xl border p-3 text-left">
          <Info
            className="text-warning mt-0.5 size-4 shrink-0"
            strokeWidth={2.3}
            aria-hidden="true"
          />
          <p className="text-foreground text-xs leading-relaxed font-medium">
            We couldn&apos;t finish setting up automatic charging — your top-up went through fine.
            You can retry anytime from billing settings.
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2.5">
        <Button
          type="button"
          size="lg"
          onClick={onFindExpert}
          className="from-primary w-full bg-gradient-to-br to-violet-600 text-white"
        >
          Find an expert <ArrowRight className="size-4" strokeWidth={2.6} aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
