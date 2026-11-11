'use client';

import { useEffect, useRef } from 'react';
import {
  ROOM_READY_REFRESH_AFTER_START_MS,
  ROOM_READY_REFRESH_MAX,
  ROOM_READY_REFRESH_MS,
} from '@/lib/meetings/room-ready-refresh-schedule';

/**
 * BAL-581 — while `active` (inside a join window with no ready call room), call `onRefresh` every
 * 30 s until `scheduledStart + ROOM_READY_REFRESH_AFTER_START_MS`, so the Join appears once the
 * venue repair lands (the final repair checkpoint is start+6, the cutoff start+8) and the ended
 * state appears once the sweep ends the meeting (start+10) — without a manual reload. What
 * "refresh" means is the caller's: the case page re-runs its Server Component, the top-nav call
 * pill refetches its own feed.
 *
 * Stops the moment `active` turns false (ready, or the caller moved on), at the deadline, after
 * `ROOM_READY_REFRESH_MAX` calls, or on unmount. A ref holds the callback so a caller passing a
 * fresh closure (or an unstable `useRouter()`) never re-arms the interval. ⚠ Measured against the
 * device clock (`Date.now()`) — a skewed clock shifts the deadline by its skew, harmless for a
 * bounded refresh.
 */
export function useRoomReadyRefetch(
  active: boolean,
  scheduledStartIso: string,
  onRefresh: () => void
): void {
  // ⚠ A REF, NOT AN EFFECT DEPENDENCY — see `useUpcomingJoinClock` (`case-nudge.tsx`) for why:
  // putting the callback in the dependency array would re-arm the interval every render it
  // changed identity.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });

  useEffect(() => {
    if (!active) return undefined;

    const deadlineMs = new Date(scheduledStartIso).getTime() + ROOM_READY_REFRESH_AFTER_START_MS;
    let refreshCount = 0;

    const id = globalThis.setInterval(() => {
      if (Date.now() >= deadlineMs || refreshCount >= ROOM_READY_REFRESH_MAX) {
        globalThis.clearInterval(id);
        return;
      }
      refreshCount += 1;
      onRefreshRef.current();
    }, ROOM_READY_REFRESH_MS);

    return () => globalThis.clearInterval(id);
  }, [active, scheduledStartIso]);
}
