'use client';

import { Sparkles, Gift } from 'lucide-react';
import { InfoHint } from './InfoHint';
import { useEasedNumber } from './use-eased-number';
import {
  GOAL_AMOUNT_MINOR,
  formatAud,
  formatAudShort,
  formatIndicative,
  timeStr,
} from '@/lib/credit/display-constants';
import { cn } from '@/lib/utils';
import type { DisplayFxSnapshot } from './types';

interface TopUpHeroProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly fx: DisplayFxSnapshot | null;
  /**
   * Tighter padding + a smaller figure for the stacked layout, where the hero sits above the
   * scrolling column rather than inside the rail. ONE hero component either way — a second
   * "compact hero" would be near-identical markup and would trip the duplication gate.
   */
  readonly compact?: boolean;
}

const RATE_HINT =
  'An estimate at the average expert rate of A$3/min. Your actual time depends on the expert you book.';

/**
 * BAL-377 dark hero (ALWAYS dark in both themes — a deliberate premium surface, like the
 * billing Balance panel). Translates the top-up into hours of expert time and counts up
 * live; the AUD amount is the load-bearing figure, the local currency + time are
 * presentation-only. Two slowly-floating glow orbs turn green when the A$5,000 goal is hit.
 * Reduced-motion: orbs static (CSS media query) + counters instant (the eased hook).
 */
export function TopUpHero({
  amountMinor,
  promoMinor,
  fx,
  compact = false,
}: Readonly<TopUpHeroProps>) {
  const creditedMinor = amountMinor + promoMinor;
  const hitGoal = amountMinor >= GOAL_AMOUNT_MINOR;
  const easedCredited = useEasedNumber(creditedMinor);
  const easedAmount = useEasedNumber(amountMinor);

  const heroTextGradient = hitGoal
    ? 'linear-gradient(120deg,#fff 20%,#A7F3D0 58%,#6EE7B7 100%)'
    : 'linear-gradient(120deg,#fff 20%,#BFDBFE 60%,#DDD6FE 100%)';

  return (
    <div
      className={cn(
        'relative overflow-hidden bg-gradient-to-br from-[#0F1729] to-[#1E293B]',
        compact ? 'px-5 pt-4 pb-5' : 'px-7 pt-6 pb-8'
      )}
    >
      <style>{`
        @keyframes topupOrbA{0%,100%{transform:translate(0,0)}50%{transform:translate(-16px,14px)}}
        @keyframes topupOrbB{0%,100%{transform:translate(0,0)}50%{transform:translate(14px,-12px)}}
        .topup-orb-a{animation:topupOrbA 9s ease-in-out infinite}
        .topup-orb-b{animation:topupOrbB 11s ease-in-out infinite}
        @media(prefers-reduced-motion:reduce){.topup-orb-a,.topup-orb-b{animation:none}}
      `}</style>

      {/* Glow orbs (green at goal) */}
      <div
        aria-hidden="true"
        className="topup-orb-a pointer-events-none absolute -top-28 -right-16 size-64 rounded-full blur-3xl"
        style={{
          background: hitGoal ? 'rgba(16,185,129,0.40)' : 'rgba(37,99,235,0.45)',
          transition: 'background .5s',
        }}
      />
      <div
        aria-hidden="true"
        className="topup-orb-b pointer-events-none absolute -bottom-28 -left-10 size-56 rounded-full blur-3xl"
        style={{
          background: hitGoal ? 'rgba(52,211,153,0.34)' : 'rgba(124,58,237,0.40)',
          transition: 'background .5s',
        }}
      />

      <div className="relative">
        <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.09em] text-white/55 uppercase">
          <Sparkles className="size-3.5" strokeWidth={2.4} aria-hidden="true" /> Your top-up buys
        </div>

        <div className={cn('flex flex-wrap items-baseline gap-2.5', compact ? 'mt-2' : 'mt-3')}>
          {/*
            The gradient is applied by the `.topup-grad-text` class in globals.css, which gates
            `background-clip: text` + `-webkit-text-fill-color: transparent` behind an
            `@supports` check. Applying those inline and UNCONDITIONALLY (as this did) renders
            the figure BLANK on any engine without background-clip support — the live bug this
            replaces. Only the gradient VALUE is inline, as a custom property.
          */}
          <span
            className={cn(
              'topup-grad-text leading-none font-bold tabular-nums',
              compact ? 'text-[30px]' : 'text-[44px]'
            )}
            style={{ '--topup-grad': heroTextGradient } as React.CSSProperties}
          >
            ≈ {timeStr(easedCredited)}
          </span>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-white/60">
            of expert time <InfoHint text={RATE_HINT} onDark />
          </span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold text-white tabular-nums">
            {formatAud(easedAmount)}
          </span>
          {fx && (
            <span className="text-[13px] font-medium text-white/50">
              ≈ {formatIndicative(amountMinor, fx.currency, fx.audToQuote)}
            </span>
          )}
          {promoMinor > 0 && (
            <span className="border-success/30 bg-success/15 text-success inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-bold">
              <Gift className="size-3" strokeWidth={2.6} aria-hidden="true" /> +
              {formatAudShort(promoMinor)} promo
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
