'use client';

import { useEffect, useRef } from 'react';
import { track, ADMIN_ALERTS_EVENTS } from '@/lib/analytics';
import type { AdminAlertQueueFilter } from '@/lib/analytics';

interface AdminQueueAnalyticsProps {
  readonly openCount: number;
  readonly oldestAgeDays: number;
  readonly filter: AdminAlertQueueFilter;
}

/**
 * BAL-548 / ADR-1055 — fires `admin_queue_viewed` once per mount. A tiny `'use client'` leaf
 * mounted by the server `page.tsx` (a Server Component can't call `track()` itself), mirroring
 * `DashboardWalletCard`'s once-on-mount `wallet_widget_viewed` discipline (a ref guard against
 * React StrictMode's dev-mode double-invoke).
 *
 * `page.tsx` gives this element `key={view.group ?? 'all'}` — a filter change is a genuinely new
 * "view" of the queue, and the `key` forces a fresh mount (and therefore a fresh fire) rather
 * than leaving it to an effect dependency array to catch.
 */
export function AdminQueueAnalytics({
  openCount,
  oldestAgeDays,
  filter,
}: Readonly<AdminQueueAnalyticsProps>): null {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(ADMIN_ALERTS_EVENTS.QUEUE_VIEWED, {
      open_count: openCount,
      oldest_age_days: oldestAgeDays,
      filter,
    });
  }, [openCount, oldestAgeDays, filter]);

  return null;
}
