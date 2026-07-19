'use client';

import { Sparkles } from 'lucide-react';
import type { DrawdownMeter } from '@balo/shared/credit';
import { cn } from '@/lib/utils';

/**
 * BAL-378 (ADR-1040 Lane 2) — the in-session meter bar (§9). A dumb renderer of the
 * pre-derived {@link DrawdownMeter}. It always sits on the dark call stage, so its
 * palette is fixed (light-on-dark) rather than theme-reactive.
 *
 * The fill is NEVER a countdown: in balance mode it reads runway, in grace mode it fills
 * toward the ceiling behind a "settles afterward" caption — reassurance, not alarm.
 */

const FILL_CLASS: Record<DrawdownMeter['tone'], string> = {
  grad: 'bg-gradient-to-r from-primary to-violet-600',
  amber: 'bg-amber-500',
  faint: 'bg-slate-400',
  blue: 'bg-blue-400',
};

const LABEL_CLASS: Record<DrawdownMeter['tone'], string> = {
  grad: 'text-violet-200',
  amber: 'text-amber-300',
  faint: 'text-white/60',
  blue: 'text-white/60',
};

interface SessionMeterProps {
  meter: DrawdownMeter;
}

export function SessionMeter({ meter }: Readonly<SessionMeterProps>): React.JSX.Element {
  const isGrace = meter.mode === 'grace';
  // Floor the fill so a nearly-empty bar is still visible (never a 0-width sliver).
  const fillWidth = `${Math.max(3, meter.pct)}%`;

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-semibold',
            LABEL_CLASS[meter.tone]
          )}
        >
          {isGrace ? <Sparkles className="size-3" strokeWidth={2.6} aria-hidden /> : null}
          {meter.label}
        </span>
        {isGrace ? (
          <span className="text-[10.5px] font-semibold text-white/45">settles afterward</span>
        ) : null}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(meter.pct)}
        aria-label={meter.label}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
            FILL_CLASS[meter.tone]
          )}
          style={{ width: fillWidth }}
        />
      </div>
    </div>
  );
}
