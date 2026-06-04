'use client';

import { useEffect, useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { RATE_BOUNDS } from './constants';

interface RateRangeSliderProps {
  /** A$ lower bound; `null` ⇒ slider floor. */
  rateMinDollars: number | null;
  /** A$ upper bound; `null` ⇒ slider ceiling. */
  rateMaxDollars: number | null;
  /**
   * Called on release (`onValueCommit`) with the settled `[min, max]`. A full-span
   * range is reported as `[null, null]` (no rate filter).
   */
  onCommit: (next: { min: number | null; max: number | null }) => void;
}

function clamp(value: number): number {
  return Math.min(RATE_BOUNDS.max, Math.max(RATE_BOUNDS.min, value));
}

/**
 * Dual-handle A$ per-minute range bound to `rateMinDollars`/`rateMaxDollars`. The
 * live drag is local state (no per-drag navigation); the parent only commits on
 * release. A full-span selection clears the filter.
 */
export function RateRangeSlider({
  rateMinDollars,
  rateMaxDollars,
  onCommit,
}: Readonly<RateRangeSliderProps>): React.JSX.Element {
  const initial: [number, number] = [
    clamp(rateMinDollars ?? RATE_BOUNDS.min),
    clamp(rateMaxDollars ?? RATE_BOUNDS.max),
  ];
  const [value, setValue] = useState<[number, number]>(initial);

  // Re-sync from props when the committed URL state changes underneath (e.g.
  // chip removal, clear-all) so the thumbs reflect the source of truth.
  useEffect(() => {
    setValue([clamp(rateMinDollars ?? RATE_BOUNDS.min), clamp(rateMaxDollars ?? RATE_BOUNDS.max)]);
  }, [rateMinDollars, rateMaxDollars]);

  const handleCommit = (next: number[]): void => {
    const min = next[0] ?? RATE_BOUNDS.min;
    const max = next[1] ?? RATE_BOUNDS.max;
    const isFullSpan = min === RATE_BOUNDS.min && max === RATE_BOUNDS.max;
    if (isFullSpan) {
      onCommit({ min: null, max: null });
      return;
    }
    onCommit({
      min: min === RATE_BOUNDS.min ? null : min,
      max: max === RATE_BOUNDS.max ? null : max,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground font-mono text-[13px] tabular-nums">
          A${value[0]}
        </span>
        <span className="text-muted-foreground font-mono text-[13px] tabular-nums">
          A${value[1]}
          {value[1] === RATE_BOUNDS.max ? '+' : ''}
        </span>
      </div>
      <Slider
        value={value}
        min={RATE_BOUNDS.min}
        max={RATE_BOUNDS.max}
        step={1}
        minStepsBetweenThumbs={1}
        onValueChange={(next) => setValue([next[0] ?? RATE_BOUNDS.min, next[1] ?? RATE_BOUNDS.max])}
        onValueCommit={handleCommit}
        aria-label="Rate range in Australian dollars per minute"
        className="py-2"
      />
    </div>
  );
}
