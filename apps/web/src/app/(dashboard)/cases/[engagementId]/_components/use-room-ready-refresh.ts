'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings'; // client-safe subpath

export const ROOM_READY_REFRESH_MS = 30_000;
/** How long after the scheduled start the page keeps refreshing: the default venue-unavailable end
 *  (start + missedCallTerminationMs) plus one sweep tick, so the viewer sees Join OR the ended state. */
export const ROOM_READY_REFRESH_AFTER_START_MS =
  DEFAULT_MEETING_TIMERS.missedCallTerminationMs + 60_000;
/** Hard backstop only — 30 min of refreshes; the deadline above is the real bound. */
export const ROOM_READY_REFRESH_MAX = 60;

/**
 * BAL-581 — while `active` (inside the case join window with no ready call room), re-run the
 * Server Component every 30 s until `scheduledStart + ROOM_READY_REFRESH_AFTER_START_MS`, so the Join
 * appears once the venue repair lands (the final repair checkpoint is start+6, the cutoff start+8)
 * and the ended state appears once the sweep ends the meeting (start+10) — without a manual reload.
 * Stops the moment `active` turns false (ready, or the nudge moved on), at the deadline, after
 * `ROOM_READY_REFRESH_MAX` refreshes, or on unmount. A ref holds the router (the
 * `useUpcomingJoinClock` precedent — `useRouter()` is not referentially stable). ⚠ Measured against
 * the device clock (`Date.now()`) — a skewed clock shifts the deadline by its skew, harmless for a
 * bounded refresh.
 */
export function useRoomReadyRefresh(active: boolean, scheduledStartIso: string): void {
  const router = useRouter();
  // ⚠ A REF, NOT AN EFFECT DEPENDENCY — see `useUpcomingJoinClock` (`case-nudge.tsx`) for why:
  // `useRouter()` is not guaranteed referentially stable, and putting it in the dependency array
  // would re-arm the interval every render it changed identity.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
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
      routerRef.current.refresh();
    }, ROOM_READY_REFRESH_MS);

    return () => globalThis.clearInterval(id);
  }, [active, scheduledStartIso]);
}
