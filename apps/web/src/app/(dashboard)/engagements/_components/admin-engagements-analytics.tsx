'use client';

import { useEffect, useRef } from 'react';
import { track, ADMIN_ENGAGEMENTS_EVENTS } from '@/lib/analytics';
import type { OversightCounts, OversightFilter } from '@/lib/engagements/oversight-row';

/**
 * Analytics-only client island (renders null) — the only way the oversight list
 * can fire `track()`. Emits `admin_engagements_list_viewed` on each filter CHANGE
 * (the `useRef` holds the last-fired filter, so a re-render with the same filter
 * doesn't re-fire, but switching filters does — and revisiting a filter after
 * leaving fires again, which is the intended per-change signal), carrying the
 * whole-set active / in-review / stalled counts. Mirrors `projects-inbox-analytics.tsx`.
 */

interface AdminEngagementsAnalyticsProps {
  filter: OversightFilter;
  counts: OversightCounts;
}

export function AdminEngagementsAnalytics({
  filter,
  counts,
}: Readonly<AdminEngagementsAnalyticsProps>): null {
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (firedFor.current === filter) return;
    firedFor.current = filter;

    track(ADMIN_ENGAGEMENTS_EVENTS.LIST_VIEWED, {
      filter,
      count_active: counts.active,
      count_in_review: counts.inReview,
      count_stalled: counts.stalled,
    });
  }, [filter, counts.active, counts.inReview, counts.stalled]);

  return null;
}
