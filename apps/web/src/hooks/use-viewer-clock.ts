'use client';

import { useEffect, useState } from 'react';

export interface ViewerClock {
  readonly now: Date;
  readonly timeZone: string;
}

/** BAL-566 (R3/D10) — the dashboard Up next card's tick cadence, mirroring Calendar's 60s tick. */
export const VIEWER_CLOCK_TICK_MS = 60_000;

/**
 * BAL-566 (D10, R3) — the VIEWER's browser timezone plus a 60s tick, for a component that must
 * format times in the DEVICE's timezone (not `expert_profiles.timezone`, which Calendar uses).
 *
 * `null` on the server pass AND the first client render — identical markup on both, so there is
 * no hydration mismatch — then resolved in an effect to `{ now: new Date(), timeZone:
 * Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }`, and re-ticked every
 * {@link VIEWER_CLOCK_TICK_MS}. Callers render a stable skeleton/placeholder for the time cell
 * while this is `null`.
 *
 * BAL-567's featured ticket card can reuse this rather than deriving a second clock.
 */
export function useViewerClock(): ViewerClock | null {
  const [clock, setClock] = useState<ViewerClock | null>(null);

  useEffect(() => {
    function tick(): void {
      setClock({
        now: new Date(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
    }
    tick();
    const interval = setInterval(tick, VIEWER_CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  return clock;
}
