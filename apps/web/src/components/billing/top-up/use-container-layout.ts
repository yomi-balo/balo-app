'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Two-column "decide left, confirm right", or one column with a sticky pay bar. */
export type TopUpLayout = 'wide' | 'stacked';

/** Below this container width the summary rail cannot hold its own column. */
const DEFAULT_BREAKPOINT_PX = 900;

/**
 * Resolve the composer's layout from its OWN width, not the viewport's.
 *
 * ⚠ VIEWPORT WIDTH IS THE WRONG SIGNAL HERE, and this is the whole reason the hook exists.
 * The composer renders both as a full-width route AND inside a ≤560px Dialog / bottom Sheet,
 * where a 1440px viewport says nothing about the 520px box the composer is actually in. Both
 * `window.innerWidth` (the prototype) and `useIsMobile` would put a two-column rail inside a
 * narrow dialog.
 *
 * `hint` is the caller's known-at-render answer (the route passes `'wide'`, the dialog
 * `'stacked'`), so SSR and first paint are already correct on both real surfaces and neither
 * ever flashes the wrong shape. The observer exists only to correct a genuinely narrow desktop
 * window — a case no caller can know in advance.
 *
 * Exactly ONE layout branch renders at a time. That is deliberate: CSS container queries would
 * need both branches in the DOM with one hidden, which means two Pay buttons and two heroes —
 * and under jsdom container queries do not apply at all, so every `getByRole('button', { name:
 * /Pay/ })` in the suite would start matching two elements.
 */
export function useContainerLayout(
  ref: RefObject<HTMLElement | null>,
  hint: TopUpLayout,
  breakpointPx: number = DEFAULT_BREAKPOINT_PX
): TopUpLayout {
  const [layout, setLayout] = useState<TopUpLayout>(hint);

  // The hint is authoritative until (and unless) a measurement disagrees — a caller switching
  // surfaces must not be stuck on a stale measured value.
  useEffect(() => setLayout(hint), [hint]);

  useEffect(() => {
    const element = ref.current;
    if (element === null || globalThis.ResizeObserver === undefined) {
      return;
    }
    const apply = (width: number): void => {
      // A zero width means the element is not laid out yet (hidden dialog, first paint) —
      // measuring it would falsely narrow us to 'stacked'. Keep the hint until it is real.
      if (width > 0) {
        setLayout(width < breakpointPx ? 'stacked' : 'wide');
      }
    };
    apply(element.getBoundingClientRect().width);
    const observer = new globalThis.ResizeObserver((entries) => {
      const [entry] = entries;
      if (entry === undefined) return;
      apply(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, breakpointPx]);

  return layout;
}
