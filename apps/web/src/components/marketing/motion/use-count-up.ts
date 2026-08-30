'use client';

import { useEffect, useState } from 'react';

const DEFAULT_COUNT_UP_DURATION_MS = 1400;

/**
 * BAL-493 §11 — the proof-band count-up. Mirrors the design reference's `useCountUp`
 * (`marketing-home.jsx:1315-1335`) with an eased ease-out-cubic ramp, one behavioural change:
 * `reduced` is an explicit parameter here (not read internally via `useReducedMotion`), so
 * every caller passes the SAME `useMarketingReducedMotion()` value already computed once per
 * render for the rest of the page, rather than each hook instance re-reading the media query.
 *
 * Under reduced motion the initial render already returns `target` — no effect needs to run
 * first — since `active` gating a jump straight to the final value is indistinguishable from
 * "was always the final value" to a user who has asked for no motion.
 */
export function useCountUp(
  target: number,
  active: boolean,
  reduced: boolean,
  decimals = 0,
  duration: number = DEFAULT_COUNT_UP_DURATION_MS
): string {
  const [value, setValue] = useState(reduced ? target : 0);

  useEffect(() => {
    if (!active) return undefined;

    if (reduced) {
      setValue(target);
      return undefined;
    }

    let rafId = 0;
    let startTime: number | null = null;
    const step = (timestamp: number): void => {
      if (startTime === null) startTime = timestamp;
      const progress = Math.min(1, (timestamp - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) rafId = globalThis.requestAnimationFrame(step);
    };
    rafId = globalThis.requestAnimationFrame(step);
    return () => {
      if (rafId !== 0) globalThis.cancelAnimationFrame(rafId);
    };
  }, [target, active, reduced, duration]);

  return value.toFixed(decimals);
}
