'use client';

import { useEffect, useRef } from 'react';
import { track, ADMIN_CAPTURE_HEALTH_EVENTS } from '@/lib/analytics';
import type { CaptureHealthQueueFilter } from '@/lib/analytics';

interface CaptureHealthAnalyticsProps {
  readonly windowDays: number;
  readonly filter: CaptureHealthQueueFilter;
  readonly issueCount: number;
}

/**
 * BAL-550 — fires `admin_capture_health_viewed` once per mount. Mirrors `AdminQueueAnalytics`'s
 * once-on-mount discipline (a ref guard against React StrictMode's dev-mode double-invoke).
 *
 * `page.tsx` gives this element `key={`${category ?? 'all'}:${windowDays}`}` — a filter or
 * window change is a genuinely new "view" of the lens, and the `key` forces a fresh mount (and
 * therefore a fresh fire) rather than leaving it to an effect dependency array to catch — the
 * BAL-551 double-fire regression this pattern exists to avoid.
 */
export function CaptureHealthAnalytics({
  windowDays,
  filter,
  issueCount,
}: Readonly<CaptureHealthAnalyticsProps>): null {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(ADMIN_CAPTURE_HEALTH_EVENTS.VIEWED, {
      window_days: windowDays,
      filter,
      issue_count: issueCount,
    });
  }, [windowDays, filter, issueCount]);

  return null;
}
