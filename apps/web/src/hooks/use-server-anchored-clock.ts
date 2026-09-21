'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ServerAnchoredClock {
  readonly now: Date;
  /**
   * `false` for render 0 — the SSR pass AND the client's pre-hydration render — and `true` once
   * the mount effect has run at least once. `now` is a pure function of props on EVERY render, so
   * it is always safe to read; `anchored` exists for a consumer that additionally wants to know
   * whether it is now safe to fold in something that is NOT a pure function of props, such as the
   * viewer's own local calendar day — reading that during a render that can still run on the
   * server disagrees between the server's host timezone and the client's browser timezone and
   * breaks hydration. Gate that kind of read on `anchored`, not on `now` alone.
   */
  readonly anchored: boolean;
}

/**
 * BAL-574 — a clock anchored to a SERVER instant rather than the device clock, for any UI whose
 * correctness (a join window, a countdown) must not depend on the viewer's clock being accurate.
 *
 * Render 0 (the SSR pass AND the client's hydration render, before any effect runs) returns
 * EXACTLY `new Date(serverNowIso)` — a pure function of the prop, so both passes produce
 * identical output and there is no hydration mismatch. The mount effect then measures
 * `offset = serverNow − Date.now()` ONCE and ticks `now` forward as `Date.now() + offset` every
 * `tickMs`, so a device clock that is fast or slow never enters the comparison — only the
 * elapsed real time since mount does.
 *
 * ⚠ NO FALLBACK TO A BARE `Date.now()` ANYWHERE IN HERE. That would reinstate the device clock
 * this hook exists to remove; every `now` this hook produces is `serverNow`-derived, always.
 *
 * ⚠ THE OFFSET IS MEASURED EXACTLY ONCE, AT MOUNT — never re-measured on a later `serverNowIso`
 * (e.g. from a `router.refresh()`). A later prop change restarts the tick interval but keeps
 * running from the original anchor; see `offsetRef`'s own comment for why `??=` is load-bearing.
 *
 * **Stated tolerance, not pure skew.** The offset also absorbs TTFB and hydration latency, so the
 * derived clock runs behind true wall-clock time by that amount — sub-second to low seconds in
 * practice. It is deliberately a ONE-SIDED error: the derived clock is never AHEAD of the server,
 * so a window can open a fraction late, never early.
 */
export function useServerAnchoredClock(serverNowIso: string, tickMs: number): ServerAnchoredClock {
  const serverNowMs = useMemo(() => new Date(serverNowIso).getTime(), [serverNowIso]);
  // `useState` is handed a plain value here, not an initializer function, so this is NOT React's
  // "lazy initial state". The property that matters is the ordinary one: React uses this argument
  // only for the FIRST render and discards it on every later one, so a LATER `serverNowIso` (e.g.
  // after a `router.refresh()`) does not reset `nowMs` — the clock keeps ticking from the mount
  // anchor rather than jumping.
  const [nowMs, setNowMs] = useState(serverNowMs);
  // Flips exactly once, false → true, on the first mount-effect run.
  const [anchored, setAnchored] = useState(false);
  const offsetRef = useRef<number | null>(null);

  useEffect(() => {
    // `??=`, NEVER `||=`: a genuinely skew-free device measures an offset of exactly 0, which
    // `||=` would treat as unset and re-measure on every effect run.
    offsetRef.current ??= serverNowMs - Date.now();
    const offset = offsetRef.current;
    const tick = (): void => {
      setNowMs(Date.now() + offset);
      setAnchored(true);
    };
    tick();
    const timer = setInterval(tick, tickMs);
    return () => {
      clearInterval(timer);
    };
  }, [serverNowMs, tickMs]);

  return useMemo(() => ({ now: new Date(nowMs), anchored }), [nowMs, anchored]);
}
