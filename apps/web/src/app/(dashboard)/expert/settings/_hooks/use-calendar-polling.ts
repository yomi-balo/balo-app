'use client';

import { useEffect, useRef } from 'react';
import { getCalendarConnectionAction } from '../_actions/get-calendar-connection';
import type { CalendarConnection } from '../_types/calendar';

interface UseCalendarPollingOptions {
  enabled: boolean;
  intervalMs?: number;
  onStatusChange?: (connection: CalendarConnection) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_POLLS = 120; // 10 minutes at 5s intervals

export function useCalendarPolling({
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
  onStatusChange,
}: UseCalendarPollingOptions): void {
  const pollCountRef = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

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

      void getCalendarConnectionAction().then((connection) => {
        if (connection && connection.status !== 'sync_pending') {
          onStatusChangeRef.current?.(connection);
          clearInterval(interval);
        }
      });
    }, intervalMs);

    return () => {
      clearInterval(interval);
    };
  }, [enabled, intervalMs]);
}
