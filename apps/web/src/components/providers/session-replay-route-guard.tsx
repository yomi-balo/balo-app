'use client';

import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import { syncSessionReplayToRoute } from '@/lib/analytics';

/**
 * Feeds every pathname change to `syncSessionReplayToRoute`. See the docblock on
 * `disable_session_recording` in `packages/analytics/src/client/client.ts` for why the init flag
 * alone does not hold across client-side navigation. A layout effect runs the stop inside the
 * commit, before rrweb's MutationObserver microtask, whose `disconnect()` drops pending records.
 */
export function SessionReplayRouteGuard(): null {
  const pathname = usePathname();

  useLayoutEffect(() => {
    if (pathname !== null) syncSessionReplayToRoute(pathname);
  }, [pathname]);

  return null;
}
