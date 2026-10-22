'use client';

import { useEffect, useState } from 'react';
import { VIEWER_CLOCK_TICK_MS } from '@/hooks/use-viewer-clock';

/**
 * A ticking "now" for a surface that can stay open for hours. Re-reads the clock every
 * {@link VIEWER_CLOCK_TICK_MS} and immediately when the page returns (tab visible, window focus,
 * bfcache restore), so a grid fetched earlier never keeps listing times that have already
 * started.
 */
export function useNowTick(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const refresh = (): void => setNow(new Date());
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    const interval = setInterval(refresh, VIEWER_CLOCK_TICK_MS);
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener('focus', refresh);
    globalThis.addEventListener('pageshow', refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener('focus', refresh);
      globalThis.removeEventListener('pageshow', refresh);
    };
  }, []);

  return now;
}
