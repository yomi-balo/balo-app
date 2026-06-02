'use client';

import { useEffect, useRef } from 'react';
import { track, SEARCH_EVENTS } from '@/lib/analytics';

interface ZeroResultsTrackerProps {
  filters: Record<string, unknown>;
  wasAvailabilityGated: boolean;
}

/**
 * Fires `search_zero_results_viewed` once when the zero-results UI renders. Lives
 * as a client child of the server `SearchEmptyState` so the empty state stays a
 * server component while the event still carries `was_availability_gated` (which
 * the server-side `search_zero_results` event lacks). Renders nothing.
 */
export function ZeroResultsTracker({
  filters,
  wasAvailabilityGated,
}: Readonly<ZeroResultsTrackerProps>): null {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(SEARCH_EVENTS.ZERO_RESULTS_VIEWED, {
      filters,
      was_availability_gated: wasAvailabilityGated,
    });
  }, [filters, wasAvailabilityGated]);

  return null;
}
