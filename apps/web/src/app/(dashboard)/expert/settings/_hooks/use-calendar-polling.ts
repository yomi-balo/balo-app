'use client';

import { useEffect, useRef } from 'react';
import { getCalendarConnectionsAction } from '../_actions/get-calendar-connections';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

interface UseCalendarPollingOptions {
  /** `connections.some(c => c.credentialStatus === 'SYNC_PENDING')` — owned by the caller. */
  readonly enabled: boolean;
  readonly intervalMs?: number;
  /** Reads `pendingProvidersRef` — a provider with a mutation in flight keeps its LOCAL
   *  (optimistic) row for this tick, so an unrelated poll can never revert it mid-mutation. */
  readonly skipProviders: () => ReadonlySet<CalendarProvider>;
  /** Called with the freshly-fetched connections, ALREADY filtered to exclude any provider
   *  currently in `skipProviders()` — the caller merges this by provider into its own state,
   *  leaving skipped providers' rows exactly as they were. */
  readonly onConnections: (next: CalendarConnection[]) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_POLLS = 120; // 10 minutes at 5s intervals

export function useCalendarPolling({
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
  skipProviders,
  onConnections,
}: UseCalendarPollingOptions): void {
  const pollCountRef = useRef(0);
  const onConnectionsRef = useRef(onConnections);
  onConnectionsRef.current = onConnections;
  const skipProvidersRef = useRef(skipProviders);
  skipProvidersRef.current = skipProviders;

  useEffect(() => {
    if (!enabled) {
      pollCountRef.current = 0;
      return;
    }

    const interval = setInterval(() => {
      pollCountRef.current += 1;

      if (pollCountRef.current > MAX_POLLS) {
        clearInterval(interval);
        return;
      }

      void getCalendarConnectionsAction().then((result) => {
        if (!result.ok) return;
        const skip = skipProvidersRef.current();
        const filtered = skip.size
          ? result.connections.filter((connection) => !skip.has(connection.provider))
          : result.connections;
        onConnectionsRef.current(filtered);
      });
    }, intervalMs);

    return () => {
      clearInterval(interval);
    };
  }, [enabled, intervalMs]);
}
