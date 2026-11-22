'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import type { CaseCallNowView } from '@/lib/call-now/call-now-types';

export interface CallNowViewState {
  /**
   * `true` once THIS read has landed; a viewer with no read at all is settled at once. A refresh
   * hands in a new read and turns this `false` again until it lands, even though the last view
   * stays on screen meanwhile.
   */
  settled: boolean;
  callNow: CaseCallNowView | null;
}

const SETTLED_EMPTY: CallNowViewState = { settled: true, callNow: null };

interface LandedRead {
  read: Promise<CaseCallNowView | null>;
  callNow: CaseCallNowView | null;
}

/**
 * The case page's Call now view, which the server streams in after the page rather than making
 * the page wait for it. `read` is `null` when there is nothing to read (an impersonated session).
 *
 * ⚠ A NEW READ KEEPS THE LAST VIEW ON SCREEN UNTIL IT LANDS, BUT IS NOT SETTLED UNTIL THEN. A
 * `router.refresh()` or a same-page navigation hands the surface a fresh promise. Clearing the view
 * meanwhile would blink the entry out on every refresh; calling the stale view settled would let a
 * missed call's "Call back" (`?call=1`, often pushed while a refresh is in flight) act on the view
 * from before the ring lapsed — `ring_in_progress`, so no confirm — and drop the param.
 *
 * ⚠ A REJECTED READ HIDES THE ENTRY. The server never rejects, but a dropped stream can; only the
 * current read is reported, so a superseded or unmounted one adds no noise.
 */
export function useCallNowView(read: Promise<CaseCallNowView | null> | null): CallNowViewState {
  const [landed, setLanded] = useState<LandedRead | null>(null);

  useEffect(() => {
    if (read === null) return undefined;
    let active = true;
    read.then(
      (callNow) => {
        if (active) setLanded({ read, callNow });
      },
      (error: unknown) => {
        if (!active) return;
        Sentry.captureException(error);
        setLanded({ read, callNow: null });
      }
    );
    return () => {
      active = false;
    };
  }, [read]);

  if (read === null) return SETTLED_EMPTY;
  return { settled: landed?.read === read, callNow: landed?.callNow ?? null };
}
