'use client';

import { useEffect, useRef, useState } from 'react';

/** True when the viewer prefers reduced motion (SSR-safe; defaults to false). */
function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * BAL-377 — a rAF-driven eased (cubic-out) counter for the hero's hours/minutes and the
 * AUD figures. Reduced-motion viewers get an instant set (no animation), per the design's
 * reduce-motion fallback. Presentation only — the value it eases toward is a display figure,
 * never a charge/balance input.
 */
export function useEasedNumber(target: number, durationMs = 500): number {
  const [value, setValue] = useState(target);
  const frame = useRef<{ from: number; start: number } | null>(null);
  const valueRef = useRef(target);
  valueRef.current = value;

  useEffect(() => {
    const from = valueRef.current;
    // No change (or reduced motion) → set instantly, schedule no frames. This also keeps the
    // mount case (from === target) animation-free, which matters under JSDOM/test runners.
    if (from === target || prefersReducedMotion()) {
      setValue(target);
      return;
    }
    const start = performance.now();
    frame.current = { from, start };
    let raf = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
