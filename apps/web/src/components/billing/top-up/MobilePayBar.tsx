'use client';

import { Clock } from 'lucide-react';
import { formatAud, timeStr } from '@/lib/credit/display-constants';

interface MobilePayBarProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  /** The Pay button, injected — it must live inside `<Elements>`, this bar must not. */
  readonly payAction: React.ReactNode;
}

/**
 * The stacked layout's sticky footer — time, amount and Pay at the thumb while the compact hero
 * scrolls away above. Inside the Sheet it reads as the sheet footer; on the route the document
 * scrolls and `sticky bottom-0` does the same job.
 *
 * ⚠ No `margin-top: auto` (the prototype has one). That only works inside the prototype's
 * fixed-height phone frame; in a real scroll container it fights `sticky bottom-0`.
 *
 * Translucency is tokenised, so it is correct in dark mode: a `rgba(255,255,255,0.96)` panel
 * (as drawn) would be a white slab over a dark page.
 */
export function MobilePayBar({ amountMinor, promoMinor, payAction }: Readonly<MobilePayBarProps>) {
  return (
    <div className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 flex items-center justify-between gap-3 border-t px-4 py-3 backdrop-blur">
      <div className="min-w-0">
        <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-semibold">
          <Clock className="size-3" strokeWidth={2.3} aria-hidden="true" /> Buys ≈{' '}
          {timeStr(amountMinor + promoMinor)}
        </p>
        <p className="text-foreground text-lg font-bold tabular-nums">{formatAud(amountMinor)}</p>
      </div>
      {payAction}
    </div>
  );
}
