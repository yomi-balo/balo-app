'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Users, Bell, Check, ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { nudgeBillingAdminAction } from '@/lib/credit/actions';
import { formatAud, formatIndicative, LOW_BALANCE_MINOR } from '@/lib/credit/display-constants';
import type { DisplayFxSnapshot } from './types';

interface MemberWalletNudgeProps {
  readonly balanceMinor: number;
  /** The billing holder's display name (or a warm generic when unresolved). */
  readonly adminLabel: string;
  readonly fx: DisplayFxSnapshot | null;
  /**
   * BAL-402 — optional analytics hook, invoked with the resting state on the nudge press (on
   * intent, before the async action). Omitted on the `/billing/top-up` route + `TopUpLauncher`,
   * which keep firing no analytics; the dashboard passes it to emit `wallet_nudge_clicked`.
   */
  readonly onNudgeClick?: (state: 'low' | 'zero') => void;
}

/**
 * BAL-381 member variant — a company member WITHOUT MANAGE_BILLING sees and spends the shared
 * team balance but can't top up. Their constructive action is to NUDGE the billing holder(s).
 * Team-framed copy ("your team's balance"), never "top up"; "overdraft" never appears. The
 * `LOW_BALANCE_MINOR` floor is shared with the holder resting states (single source of truth).
 */
export function MemberWalletNudge({
  balanceMinor,
  adminLabel,
  fx,
  onNudgeClick,
}: Readonly<MemberWalletNudgeProps>) {
  const [requested, setRequested] = useState(false);
  const [pending, setPending] = useState(false);

  const isZero = balanceMinor <= 0;
  const isLow = !isZero && balanceMinor < LOW_BALANCE_MINOR;

  const nudge = useCallback(async () => {
    if (pending || requested) return;
    setPending(true);
    try {
      const result = await nudgeBillingAdminAction();
      if (result.ok) {
        setRequested(true);
        toast.success(`We let ${adminLabel} know.`);
      } else {
        toast.error("We couldn't send that just now — please try again.");
      }
    } finally {
      setPending(false);
    }
  }, [pending, requested, adminLabel]);

  const handleNudgeClick = useCallback(() => {
    onNudgeClick?.(isZero ? 'zero' : 'low');
    nudge().catch(() => undefined);
  }, [nudge, onNudgeClick, isZero]);

  function renderAction() {
    if (requested) {
      return (
        <div className="border-success/40 bg-success/10 text-success inline-flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold">
          <Check className="size-4" strokeWidth={2.6} aria-hidden="true" /> We let {adminLabel} know
        </div>
      );
    }
    if (isZero || isLow) {
      return (
        <Button
          type="button"
          onClick={handleNudgeClick}
          disabled={pending}
          variant={isZero ? 'default' : 'secondary'}
          className="min-h-11 w-full"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Bell className="size-4" strokeWidth={2.5} aria-hidden="true" />
          )}
          {isZero ? `Ask ${adminLabel} to top up` : `Nudge ${adminLabel} to top up`}
        </Button>
      );
    }
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
        <ShieldCheck className="text-success size-3.5" strokeWidth={2.2} aria-hidden="true" /> You
        can start a consultation anytime.
      </p>
    );
  }

  return (
    <div
      className={cn(
        'bg-card w-full max-w-sm rounded-2xl border p-5 shadow-sm',
        isLow ? 'border-warning/40' : 'border-border'
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wide uppercase">
          <Users className="size-3.5" strokeWidth={2.4} aria-hidden="true" /> Team balance
        </span>
        {isLow && (
          <span className="border-warning/40 bg-warning/10 text-warning rounded-full border px-2.5 py-0.5 text-[11px] font-semibold">
            Running low
          </span>
        )}
      </div>

      <div className="mt-3.5 flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            'text-3xl font-semibold tabular-nums',
            isZero ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {formatAud(balanceMinor)}
        </span>
        {!isZero && fx && (
          <span className="text-muted-foreground text-sm font-medium">
            ≈ {formatIndicative(balanceMinor, fx.currency, fx.audToQuote)}
          </span>
        )}
      </div>

      <p className="text-muted-foreground mt-2 text-xs leading-relaxed font-medium">
        {isZero
          ? `Your team's balance is used up. Ask ${adminLabel} to top up to start a consultation.`
          : `Shared across your team · ${adminLabel} manages top-ups.`}
      </p>

      <div className="mt-4">{renderAction()}</div>
    </div>
  );
}
