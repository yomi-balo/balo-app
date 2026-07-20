'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock, Gift, Radio, RotateCw, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatIndicative } from '@/lib/credit/display-constants';
import type { DisplayFxSnapshot } from '@/components/billing/top-up/types';

/**
 * BAL-378 (ADR-1040 Lane 2) — the shared client-lens wallet primitive (§9, §14 Q7),
 * from `wallet-balance-widget.jsx`. Extended in BAL-402 with the holder resting states.
 *
 * States: `session` + `promo` (the in-session Case surface), `loading` / `error`, and the
 * resting `healthy` / `low` / `zero` (the dashboard holder lens). An optional `fx` snapshot
 * renders an indicative "≈ local" secondary — `fx=null` (a missing OR stale rate, which are
 * indistinguishable) simply omits that line; it is never surfaced as an error. An optional
 * `action` slot renders the caller-composed affordance (e.g. a Top-up link) in the resting
 * footer, so this stays a context-neutral primitive — it imports no routing and no analytics.
 *
 * HARD BOUNDARY: client-lens only — this never renders on an expert / payout lens.
 * AUD is the real figure; the `session` balance ticks down as a PURE display counter
 * between authoritative refreshes (no ticking-clock alarm, no "overdraft"). The gradient
 * accent is reserved for `session` only — resting states use solid `--primary` (the dashboard
 * is context-neutral).
 */

/**
 * The states this widget implements. `healthy` / `low` / `zero` are the holder resting states
 * (BAL-402); a `stale` FX cache is deliberately NOT a state — a stale rate resolves to `fx=null`
 * upstream, which just omits the indicative line (see the header comment).
 */
export type WalletWidgetState =
  | 'session'
  | 'promo'
  | 'loading'
  | 'error'
  | 'healthy'
  | 'low'
  | 'zero';

interface WalletWidgetProps {
  state: WalletWidgetState;
  /** Authoritative AUD-minor balance (the `session` state ticks down from here). */
  balanceMinor?: number;
  /** Ring-fenced promo credit for the `promo` chip (display only). */
  promoMinor?: number;
  /** Per-minute AUD-minor charge shown in the `session` state. */
  ratePerMinuteMinor?: number;
  /** Indicative display-FX; `null`/omitted hides the "≈ local" secondary (never an error). */
  fx?: DisplayFxSnapshot | null;
  /** Caller-composed affordance rendered in the resting-state footer (e.g. a Top-up link). */
  action?: React.ReactNode;
  onRetry?: () => void;
  className?: string;
}

/** Border token per state: amber for `low`, primary hairline for `session`, neutral otherwise. */
function restingBorderClass(state: WalletWidgetState): string {
  if (state === 'low') return 'border-warning/40';
  if (state === 'session') return 'border-primary/30';
  return 'border-border';
}

const CARD_CLASS =
  'bg-card relative w-full max-w-[380px] overflow-hidden rounded-2xl border p-5 shadow-[0_1px_2px_rgba(15,23,41,0.04),0_6px_20px_rgba(15,23,41,0.04)]';

/** AUD-minor → "A$1,234.00". AUD is always the real, invoice-matching figure. */
function formatAud(minor: number): string {
  return `A$${(minor / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** True unless the viewer has asked for reduced motion (or `matchMedia` is unavailable). */
function motionAllowed(): boolean {
  if (typeof globalThis.matchMedia !== 'function') {
    return false;
  }
  return !globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A pure display counter for the `session` state: re-seeds from the authoritative
 * `balanceMinor` and ticks down at the per-minute rate between refreshes. Holds at the
 * seed when reduced motion is on (or in a non-DOM test env) so nothing "ticks".
 */
function useLiveBalance(active: boolean, balanceMinor: number, ratePerMinuteMinor: number): number {
  const [live, setLive] = useState(balanceMinor);
  const perSecond = Math.max(0, Math.round(ratePerMinuteMinor / 60));

  useEffect(() => {
    setLive(balanceMinor);
    if (!active || perSecond === 0 || !motionAllowed()) {
      return;
    }
    const id = setInterval(() => {
      setLive((current) => Math.max(0, current - perSecond));
    }, 1000);
    return () => clearInterval(id);
  }, [active, balanceMinor, perSecond]);

  return live;
}

// ── Small pieces ─────────────────────────────────────────────────────────────
function Eyebrow(): React.JSX.Element {
  return (
    <span className="text-muted-foreground/80 inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
      <Wallet className="size-3" strokeWidth={2.4} aria-hidden />
      Wallet
    </span>
  );
}

function LoadingState({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  return (
    <div
      className={cn(CARD_CLASS, 'border-border', className)}
      aria-busy="true"
      aria-label="Loading wallet balance"
    >
      <div className="flex flex-col gap-4">
        <div className="bg-muted h-3 w-16 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted h-8 w-36 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted h-10 w-full animate-pulse rounded motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function ErrorState({
  onRetry,
  className,
}: Readonly<{ onRetry?: () => void; className?: string }>): React.JSX.Element {
  return (
    <div className={cn(CARD_CLASS, 'border-border', className)}>
      <Eyebrow />
      <p className="text-foreground/90 mt-3.5 text-[14.5px] leading-relaxed font-medium">
        Balance didn&apos;t load. Nothing&apos;s wrong with your credit — this is on our side.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="border-border bg-card text-foreground/90 focus-visible:ring-ring hover:bg-muted mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-[13.5px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <RotateCw className="size-3.5" strokeWidth={2.4} aria-hidden />
        Retry
      </button>
    </div>
  );
}

export function WalletWidget({
  state,
  balanceMinor = 0,
  promoMinor = 0,
  ratePerMinuteMinor = 0,
  fx,
  action,
  onRetry,
  className,
}: Readonly<WalletWidgetProps>): React.JSX.Element {
  const isSession = state === 'session';
  const liveBalance = useLiveBalance(isSession, balanceMinor, ratePerMinuteMinor);
  const handleRetry = useCallback((): void => onRetry?.(), [onRetry]);

  if (state === 'loading') {
    return <LoadingState className={className} />;
  }
  if (state === 'error') {
    return <ErrorState onRetry={handleRetry} className={className} />;
  }

  const isPromo = state === 'promo';
  const isLow = state === 'low';
  const isZero = state === 'zero';
  const isResting = state === 'healthy' || isLow || isZero;
  const shownBalance = isSession ? liveBalance : balanceMinor;

  return (
    <div className={cn(CARD_CLASS, restingBorderClass(state), className)}>
      {isSession ? (
        <div className="from-primary absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r to-violet-600" />
      ) : null}

      <div className="flex items-center justify-between">
        <Eyebrow />
        {isSession ? (
          <span className="border-primary/30 bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold">
            <Radio
              className="size-[11px] motion-safe:animate-pulse"
              strokeWidth={2.6}
              aria-hidden
            />
            In consultation
          </span>
        ) : null}
        {isLow ? (
          <span className="border-warning/40 bg-warning/10 text-warning inline-flex items-center rounded-full border px-2.5 py-1 text-[11.5px] font-semibold">
            Running low
          </span>
        ) : null}
      </div>

      <div className="mt-3.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={cn(
              'text-[34px] leading-none font-semibold tracking-tight tabular-nums',
              isZero ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {formatAud(shownBalance)}
          </span>
          {fx && !isZero && !isSession ? (
            <span className="text-muted-foreground text-sm font-medium tabular-nums">
              ≈ {formatIndicative(shownBalance, fx.currency, fx.audToQuote)}
            </span>
          ) : null}
        </div>

        {isSession ? (
          <div className="text-muted-foreground mt-1.5 text-[13px] font-medium">
            {formatAud(ratePerMinuteMinor)}/min · counts down as you talk
          </div>
        ) : null}

        {isPromo ? (
          <div className="text-success bg-success/10 mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-semibold">
            <Gift className="size-3" strokeWidth={2.4} aria-hidden />
            Includes {formatAud(promoMinor)} promo credit
          </div>
        ) : null}

        {isZero ? (
          <p className="text-foreground/90 mt-1.5 text-[14px] leading-relaxed font-medium">
            Top up to start a consultation.
          </p>
        ) : null}
      </div>

      <div className="mt-4">
        {isSession ? (
          <div className="text-muted-foreground/80 flex items-center gap-1.5 text-[12.5px] font-medium">
            <Clock className="size-3" strokeWidth={2.2} aria-hidden />
            We&apos;ll give you a heads-up before it runs out.
          </div>
        ) : null}
        {isPromo ? (
          <p className="text-success/90 bg-success/5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium">
            Promo credit is ring-fenced — it&apos;s spent first and never triggers a card charge.
          </p>
        ) : null}
        {isResting ? action : null}
      </div>
    </div>
  );
}
