'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Clock, ArrowRight, Gift, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, CREDIT_EVENTS } from '@/lib/analytics';
import { formatAud, formatAudShort, timeStr } from '@/lib/credit/display-constants';
import { useTopUpCreditPoll, type TopUpCreditPollStatus } from './use-topup-credit-poll';
import type { PurchaseCompletion } from './types';

interface TopUpReceiptProps {
  readonly completion: PurchaseCompletion;
  /**
   * The balance the composer was rendered with — a PLACEHOLDER for the "Balance right now" line
   * until the first poll response lands, and nothing more.
   *
   * ⚠ IT IS NEVER AN ADDEND. This used to feed `previous + amountMinor + promoMinor`, which is
   * the whole defect: that sum cannot tell credited from not-credited.
   */
  readonly previousBalanceMinor: number;
  readonly onFindExpert: () => void;
  readonly onDone: () => void;
}

/**
 * BAL-377 receipt (Step 2) — a restrained triumph, now an EARNED one.
 *
 * ── WHAT CHANGED, AND WHY ────────────────────────────────────────────────────────────────────
 *
 * This screen used to compute `previousBalanceMinor + amountMinor + promoMinor` and render it as
 * "Your balance is now …". Nothing on the client ever asked the wallet, so the figure was an
 * assertion, not a fact — and in the real incident it rendered "A$1,000.00" beside a top-bar
 * credits chip reading "A$0.00", because the wallet was genuinely never credited. A receipt that
 * cannot tell credited from not-credited is worse than one that admits it doesn't know yet.
 *
 * So the receipt now RENDERS A STATE it polled for (`useTopUpCreditPoll`), and every balance
 * figure it shows is a server READ of the actor's own wallet:
 *
 *   · `pending`     — the honest FIRST PAINT. The webhook is asynchronous by design, so this is
 *                     the NORMAL case, not a failure. Neutral mark, never the success check —
 *                     a green tick is an assertion too.
 *   · `credited`    — confirmed against the `manual_purchase:{piId}` ledger entry. Today's
 *                     triumphant copy, now earned.
 *   · `unconfirmed` — the poll window closed without confirmation. The money is safe and the
 *                     copy says so; NO number is ever labelled "New balance" in this state.
 *
 * ⚠⚠ THE `pending → credited` TRANSITION IS ALSO THE CHIP FIX. `router.refresh()` fires THERE
 * and nowhere else. The `(dashboard)` layout is always dynamic (`cookies()`/`headers()`) and
 * `loadTopBarWalletData` is an uncached DB read, so re-running the layout is all the chip needs —
 * there is no stale cache to bust, only an un-re-rendered layout. A blind refresh on MOUNT is the
 * obvious fix and the worst one: it reads the wallet milliseconds after `confirmPayment`, before
 * the webhook has even begun, and authoritatively repaints A$0.00 next to the receipt.
 */
export function TopUpReceipt({
  completion,
  previousBalanceMinor,
  onFindExpert,
  onDone,
}: Readonly<TopUpReceiptProps>) {
  const router = useRouter();
  const mountFired = useRef(false);
  const creditedFired = useRef(false);
  const { amountMinor, promoMinor, promoCode, lowBalanceMode, mandateCaptured, paymentIntentId } =
    completion;

  const { status, balanceMinor } = useTopUpCreditPoll(paymentIntentId);
  /** ⚠ ALWAYS THE SERVER'S FIGURE ONCE ONE EXISTS. The placeholder never becomes an addend. */
  const shownBalanceMinor = balanceMinor ?? previousBalanceMinor;

  // The charge succeeded but the mandate SetupIntent for a card-backed mode did not complete
  // (SCA abandoned / declined). This degrades safely — the wallet stays `mandate_status:
  // pending` and BAL-378/379 only ever act on `active` — but the user's stated intent is
  // silently inactive, so surface a gentle, non-blocking retry note (design principle 4). On a
  // DIFFERENT axis from the credit status above: it is about automatic charging on FUTURE
  // purchases, not about whether THIS one landed — so it renders in every state, unchanged.
  const cardBackedIntent = lowBalanceMode === 'auto_topup' || lowBalanceMode === 'keep_going';
  const mandateIncomplete = cardBackedIntent && !mandateCaptured;

  useEffect(() => {
    if (mountFired.current) return;
    mountFired.current = true;

    // ⚠ STAYS ON MOUNT, WITH ITS STRING UNCHANGED. It honestly means "the buyer's payment
    // confirmed client-side"; delaying it to the credited transition would drop the funnel step
    // every time a tab closes, and renaming it would churn live PostHog dashboards. The money
    // truth is the SERVER series (`credit_manual_purchase_credited`), and the gap between the
    // two is the "charged but never credited" alarm.
    track(CREDIT_EVENTS.PURCHASE_COMPLETED, {
      amount_minor: amountMinor,
      promo_applied: promoMinor > 0,
      funding_method: 'card',
      low_balance_mode: lowBalanceMode,
      credit_status: 'pending',
    });
    if (mandateCaptured && (lowBalanceMode === 'auto_topup' || lowBalanceMode === 'keep_going')) {
      track(CREDIT_EVENTS.MANDATE_CAPTURED, { low_balance_mode: lowBalanceMode });
    }
    toast.success(`Payment confirmed — ${formatAud(amountMinor)}.`);
  }, [amountMinor, promoMinor, lowBalanceMode, mandateCaptured]);

  /**
   * ⚠⚠ THE CONFIRMATION TRANSITION — the one place the layout is refreshed, and the only place a
   * granted bonus is counted. Latched, so it runs exactly once and NEVER on mount (the first
   * paint is always `pending`; the poll's first read is asynchronous).
   */
  useEffect(() => {
    if (status !== 'credited' || creditedFired.current) return;
    creditedFired.current = true;

    // ⚠ MOVED OFF MOUNT DELIBERATELY. The promo is re-validated at settlement and can be SKIPPED
    // while the base purchase still credits, so firing this on mount overstated promo cost.
    // Undercount beats overcount for granted money.
    if (promoMinor > 0 && promoCode) {
      track(CREDIT_EVENTS.PROMO_REDEEMED, { code: promoCode, bonus_minor: promoMinor });
    }
    toast.success(`${formatAud(amountMinor)} is in your balance.`);
    // Re-runs the `(dashboard)` layout → `CreditsChipSlot` → `loadTopBarWalletData`, so the
    // top-bar chip repaints from the same uncached read this receipt just confirmed against.
    router.refresh();
  }, [status, amountMinor, promoMinor, promoCode, router]);

  const credited = status === 'credited';

  return (
    <div className="px-7 py-10 text-center">
      {credited ? (
        <div className="bg-success/15 text-success motion-safe:animate-in motion-safe:zoom-in-50 mx-auto flex size-14 items-center justify-center rounded-full">
          <Check className="size-7" strokeWidth={2.6} aria-hidden="true" />
        </div>
      ) : (
        // ⚠ NEUTRAL, NOT THE SUCCESS CHECK — a green tick is an assertion too.
        <div className="bg-muted text-muted-foreground mx-auto flex size-14 items-center justify-center rounded-full">
          <Clock className="size-7" strokeWidth={2.4} aria-hidden="true" />
        </div>
      )}

      <ReceiptHeadline
        status={status}
        amountMinor={amountMinor}
        balanceMinor={shownBalanceMinor}
        paymentIntentId={paymentIntentId}
      />

      <div className="border-border bg-muted/20 mx-auto mt-6 max-w-sm rounded-xl border p-4 text-left text-sm">
        <ReceiptRows
          status={status}
          amountMinor={amountMinor}
          promoMinor={promoMinor}
          balanceMinor={shownBalanceMinor}
        />
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

interface HeadlineProps {
  readonly status: TopUpCreditPollStatus;
  readonly amountMinor: number;
  readonly balanceMinor: number;
  readonly paymentIntentId: string;
}

/** The heading + sub-copy for each state. Warm and factual; never adversarial, never a countdown. */
function ReceiptHeadline({
  status,
  amountMinor,
  balanceMinor,
  paymentIntentId,
}: Readonly<HeadlineProps>) {
  if (status === 'credited') {
    return (
      <>
        <h2 className="text-foreground mt-5 text-xl font-semibold">You&apos;re topped up</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Your balance is now{' '}
          <span className="text-foreground font-semibold tabular-nums">
            {formatAud(balanceMinor)}
          </span>{' '}
          — ≈ {timeStr(balanceMinor)} of expert time, ready when you are.
        </p>
      </>
    );
  }

  if (status === 'pending') {
    return (
      <>
        <h2 className="text-foreground mt-5 text-xl font-semibold">Payment received</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          <span className="text-foreground font-semibold tabular-nums">
            {formatAud(amountMinor)}
          </span>{' '}
          is on its way to your balance — it usually lands within a few seconds, and we&apos;ll
          update this the moment it does.
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="text-foreground mt-5 text-xl font-semibold">
        Payment received — your balance is still catching up
      </h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Your payment of{' '}
        <span className="text-foreground font-semibold tabular-nums">{formatAud(amountMinor)}</span>{' '}
        went through and it&apos;s safe with us. The balance hasn&apos;t updated yet — that part is
        on us to finish, and it will land without you doing anything. No need to pay again.
      </p>
      <p className="text-muted-foreground mx-auto mt-3 max-w-sm text-xs">
        If it&apos;s still not showing in a few minutes, get in touch with reference{' '}
        <span className="text-foreground font-medium">{paymentIntentId.slice(-8)}</span> and
        we&apos;ll sort it out.
      </p>
    </>
  );
}

interface RowsProps {
  readonly status: TopUpCreditPollStatus;
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly balanceMinor: number;
}

/** One row of the little summary card. `emphasis` is the ruled-off total line. */
function ReceiptRow({
  label,
  value,
  emphasis = false,
}: Readonly<{ label: string; value: string; emphasis?: boolean }>) {
  return (
    <div
      className={
        emphasis
          ? 'border-border mt-1 flex justify-between border-t pt-2'
          : 'flex justify-between py-1'
      }
    >
      <span className={emphasis ? 'text-foreground font-medium' : 'text-muted-foreground'}>
        {label}
      </span>
      <span className="text-foreground font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/**
 * The money rows.
 *
 * ⚠⚠ THE `New balance` ROW EXISTS ONLY IN THE `credited` STATE, AND ITS FIGURE IS THE WALLET
 * READ — never `previous + amount + promo`. The other two states show "Balance right now", which
 * is a statement about the present, not a claim about this purchase.
 */
function ReceiptRows({ status, amountMinor, promoMinor, balanceMinor }: Readonly<RowsProps>) {
  if (status === 'credited') {
    return (
      <>
        <ReceiptRow label="Added to balance" value={formatAud(amountMinor)} />
        {promoMinor > 0 && <PromoRow promoMinor={promoMinor} />}
        <ReceiptRow label="New balance" value={formatAud(balanceMinor)} emphasis />
      </>
    );
  }

  if (status === 'pending') {
    return (
      <>
        <ReceiptRow label="Paid" value={formatAud(amountMinor)} />
        {promoMinor > 0 && <PromoRow promoMinor={promoMinor} suffix=" — applied on arrival" />}
        <ReceiptRow label="Balance right now" value={`${formatAud(balanceMinor)} · updating`} />
      </>
    );
  }

  // `unconfirmed` — the money is safe, the balance is not yet provable. No promo line (the grant
  // is re-validated at settlement and we have not seen it land), and NO "New balance", ever.
  return (
    <>
      <ReceiptRow label="Paid" value={formatAud(amountMinor)} />
      <ReceiptRow label="Balance right now" value={formatAud(balanceMinor)} />
    </>
  );
}

function PromoRow({ promoMinor, suffix = '' }: Readonly<{ promoMinor: number; suffix?: string }>) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-success inline-flex items-center gap-1.5">
        <Gift className="size-3.5" strokeWidth={2.4} aria-hidden="true" /> Promo bonus{suffix}
      </span>
      <span className="text-success font-semibold tabular-nums">+{formatAudShort(promoMinor)}</span>
    </div>
  );
}
