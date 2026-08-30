'use client';

import { useCallback, useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { useMarketingReducedMotion } from './use-reduced-motion';

interface RevealGroupProps {
  /** The wrapper tag. Defaults to `'div'`. */
  readonly as?: ElementType;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Matches the design reference's `useInView` threshold/rootMargin (`marketing-home.jsx:1204`). */
const REVEAL_THRESHOLD = 0.12;
const REVEAL_ROOT_MARGIN = '0px 0px -8% 0px';

/**
 * BAL-493 §11 — one IntersectionObserver per group; fires once, adds `.is-in`. Replaces the
 * design reference's `useInView` + `Reveal` (`marketing-home.jsx:1184-1220`) with a single
 * component covering both.
 *
 * ⚠⚠ **THE `mk-reveal-group` CLASS IS RENDERED UNCONDITIONALLY, ON THE SERVER, EVERY TIME.**
 * `marketing-home.css`'s comment above `.mk-reveal` explains why this is load-bearing, not
 * cosmetic: the hidden state is scoped to `.mk-reveal-group:not(.is-in) .mk-reveal` (rather
 * than a bare `.mk-reveal { opacity: 0 }`) specifically so that a server-rendered page with no
 * JS at all never needs `.is-in` to be visible — the CSS file's own
 * `@media (scripting: none)` block forces full visibility in that case. But that fallback only
 * works if `.mk-reveal-group` itself is present in the markup from the first paint; if this
 * component instead deferred adding ANY class until an effect ran, a hydration-less or
 * JS-disabled client would see no `.mk-reveal-group` wrapper, the CSS selectors above would
 * never match, and the page would render however the browser default happens to be, un-pinned.
 * `inView` (and therefore `.is-in`) is the ONLY thing that is client/effect-driven; the group
 * class itself is not.
 *
 * ⚠ NOT a duplicate of `apps/web/src/components/balo/engagement/reveal.tsx`. That `Reveal` is a
 * **mount** animation — a `motion.div` with `initial`/`animate` and a numeric `delay`, no
 * `IntersectionObserver` — for content that is already on screen when it appears (e.g. a
 * delivery workspace panel swapping in). This `RevealGroup` is a **scroll-triggered group**
 * reveal: it waits for the group to scroll into view, then lets the CSS `--i`-staggered
 * children (marked with `.mk-reveal` by the caller, not by this component) animate in via pure
 * CSS transitions gated on the `.is-in` class. Different trigger, different mechanism, only
 * superficially similar names — kept as `RevealGroup` (not `Reveal`) specifically so nobody
 * "consolidates" the two.
 *
 * Reduced motion (or an environment with no `IntersectionObserver`, e.g. a very old browser or
 * this repo's own jsdom test environment before the global stub is installed) sets `inView`
 * to `true` immediately and never constructs an observer at all.
 */
export function RevealGroup({
  as,
  className,
  children,
}: Readonly<RevealGroupProps>): React.JSX.Element {
  const Component = as ?? 'div';
  const reduced = useMarketingReducedMotion();
  const elementRef = useRef<Element | null>(null);
  const [inView, setInView] = useState(false);

  const setRef = useCallback((node: Element | null) => {
    elementRef.current = node;
  }, []);

  useEffect(() => {
    if (reduced) {
      setInView(true);
      return;
    }

    const el = elementRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: REVEAL_THRESHOLD, rootMargin: REVEAL_ROOT_MARGIN }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduced]);

  // Both modifiers are extracted to named consts rather than interpolated inline: a template
  // literal nested inside another template literal trips SonarJS `no-nested-template-literals`.
  const inViewClass = inView ? ' is-in' : '';
  const extraClass = className ? ` ${className}` : '';
  const classes = `mk-reveal-group${inViewClass}${extraClass}`;

  return (
    <Component ref={setRef} className={classes}>
      {children}
    </Component>
  );
}
