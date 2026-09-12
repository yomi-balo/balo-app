'use client';

import { useEffect, useRef } from 'react';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';

interface ApplicationsAnalyticsProps {
  readonly pendingCount: number;
  readonly oldestDays: number;
}

/**
 * BAL-549 — fires `admin_applications_list_viewed` once per mount. A tiny `'use client'` leaf
 * mounted by the server `page.tsx` (a Server Component can't call `track()` itself), the
 * `AdminQueueAnalytics` `useRef` StrictMode-guard idiom verbatim.
 *
 * `page.tsx` gives this element `key={resolvedFilter}` — a filter change is a genuinely new
 * "view" of the list, and the `key` forces a fresh mount (and therefore a fresh fire) rather
 * than leaving it to an effect dependency array to catch.
 */
export function ApplicationsAnalytics({
  pendingCount,
  oldestDays,
}: Readonly<ApplicationsAnalyticsProps>): null {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(ADMIN_APPLICATIONS_EVENTS.LIST_VIEWED, {
      pending_count: pendingCount,
      oldest_days: oldestDays,
    });
  }, [pendingCount, oldestDays]);

  return null;
}
