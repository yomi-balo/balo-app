'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MEETINGS_CHANGED_EVENT } from '@/lib/meetings/meetings-changed-event';

/**
 * Re-renders a server-rendered meeting surface when the notification feed reports a meeting
 * change (`MEETINGS_CHANGED_EVENT`): a booking, a reschedule, a cancellation, or a Call now ring
 * starting or lapsing.
 *
 * The companion of `useRefreshOnFocus`, which only reconciles when a human looks back at the tab.
 * A tab that stays focused through a change would otherwise keep showing what its last server
 * render saw — an unanswered call still offered as "Happening now · Join call" until reload.
 *
 * ⚠ EVENT-DRIVEN, NEVER PERIODIC, and not rate-limited: the feed raises the event at most once
 * per response and only for a meeting-change row it has not seen before.
 */
export function useRefreshOnMeetingsChanged(): void {
  const router = useRouter();
  useEffect(() => {
    function refresh(): void {
      router.refresh();
    }
    globalThis.addEventListener(MEETINGS_CHANGED_EVENT, refresh);
    return () => {
      globalThis.removeEventListener(MEETINGS_CHANGED_EVENT, refresh);
    };
  }, [router]);
}
