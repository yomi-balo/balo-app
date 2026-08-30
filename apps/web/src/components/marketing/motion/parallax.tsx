'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useMarketingReducedMotion } from './use-reduced-motion';
import type { ParallaxCompute } from './fx';

interface ParallaxProps {
  /** Pure `(scrollY, parentRect, viewportHeight) => transform` — see `fx.ts`'s presets. */
  readonly compute: ParallaxCompute;
  readonly className?: string;
  /**
   * Hide the wrapper from assistive tech. A `<Parallax>` used for a purely decorative layer
   * (a glow, a grid) has no accessible content, but it still renders a real `<div>` that a
   * screen reader walks — its siblings on the same section carry `aria-hidden` directly, so
   * without this the decorative layers were inconsistently exposed. Opt-in, not defaulted:
   * `<Parallax>` also wraps real content (the pricing receipt), which must stay readable.
   */
  readonly ariaHidden?: boolean;
  readonly children: ReactNode;
}

/**
 * BAL-493 §11 — scroll-linked transform, written straight to the DOM (no re-renders). Replaces
 * the design reference's `useScrollFx` (`marketing-home.jsx:1223-1258`), wrapping children so
 * the wrapped content stays server-rendered (the same boundary trick documented at
 * `apps/web/src/components/balo/engagement/reveal.tsx:22-27` — only the rendered React nodes
 * cross the client boundary, never a data object).
 *
 * ⚠⚠ **MEASURES THE PARENT, NOT THIS ELEMENT.** `compute` receives the bounding rect of
 * `element.parentElement`, exactly like the ref. If it measured the element itself, applying
 * `compute`'s returned `transform` would move the element, which would change its own
 * `getBoundingClientRect()` on the next frame, which `compute` would read to produce the next
 * transform — a feedback loop. The parent's box is stable across the transform.
 *
 * ⚠⚠ **rAF-THROTTLED.** `scroll` and `resize` fire far more often than once per frame; `onTick`
 * only ever schedules a single pending `requestAnimationFrame` at a time.
 *
 * ⚠ **`el.style.transform` is written directly — no React state, no re-render.** A parallax
 * offset changes on every scroll tick; routing that through `setState` would re-render the
 * whole subtree dozens of times a second for a change React never needs to know about.
 *
 * Reduced motion attaches **no listeners at all** (not "listeners that immediately no-op") and
 * clears any previously-set transform, so a user who changes their OS setting mid-scroll is not
 * left with a stale offset.
 */
export function Parallax({
  compute,
  className,
  ariaHidden,
  children,
}: Readonly<ParallaxProps>): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = useMarketingReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    if (reduced) {
      el.style.transform = '';
      return undefined;
    }

    let rafId = 0;
    const applyTransform = (): void => {
      rafId = 0;
      const parent = el.parentElement ?? el;
      el.style.transform = compute(
        globalThis.scrollY || 0,
        parent.getBoundingClientRect(),
        globalThis.innerHeight || 800
      );
    };
    const scheduleTick = (): void => {
      if (rafId !== 0) return;
      rafId = globalThis.requestAnimationFrame(applyTransform);
    };

    applyTransform();
    globalThis.addEventListener('scroll', scheduleTick, { passive: true });
    globalThis.addEventListener('resize', scheduleTick);
    return () => {
      globalThis.removeEventListener('scroll', scheduleTick);
      globalThis.removeEventListener('resize', scheduleTick);
      if (rafId !== 0) globalThis.cancelAnimationFrame(rafId);
      el.style.transform = '';
    };
  }, [compute, reduced]);

  return (
    <div ref={ref} className={className} aria-hidden={ariaHidden}>
      {children}
    </div>
  );
}
