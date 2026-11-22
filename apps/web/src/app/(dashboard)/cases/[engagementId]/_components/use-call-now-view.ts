'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import type { CaseCallNowView } from '@/lib/call-now/call-now-types';

export interface CallNowViewState {
  /** `false` until the first read lands; a viewer with no read at all is settled at once. */
  settled: boolean;
  callNow: CaseCallNowView | null;
}

const SETTLED_EMPTY: CallNowViewState = { settled: true, callNow: null };

/**
 * The case page's Call now view, which the server streams in after the page rather than making
 * the page wait for it. `read` is `null` when there is nothing to read (an impersonated session).
 *
 * ⚠ A NEW READ KEEPS THE LAST VIEW ON SCREEN UNTIL IT LANDS. A `router.refresh()` hands the surface
 * a fresh promise; clearing to `null` meanwhile would blink the entry out on every refresh.
 *
 * ⚠ A REJECTED READ HIDES THE ENTRY. The server side never rejects, so a rejection is a bug and is
 * reported rather than shown.
 */
export function useCallNowView(read: Promise<CaseCallNowView | null> | null): CallNowViewState {
  const [state, setState] = useState<CallNowViewState>({ settled: false, callNow: null });

  useEffect(() => {
    if (read === null) return undefined;
    let active = true;
    read.then(
      (callNow) => {
        if (active) setState({ settled: true, callNow });
      },
      (error: unknown) => {
        Sentry.captureException(error);
        if (active) setState(SETTLED_EMPTY);
      }
    );
    return () => {
      active = false;
    };
  }, [read]);

  return read === null ? SETTLED_EMPTY : state;
}
