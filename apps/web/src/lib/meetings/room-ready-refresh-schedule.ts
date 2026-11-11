import { DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings'; // client-safe subpath

export const ROOM_READY_REFRESH_MS = 30_000;
/** How long after the scheduled start the page keeps refreshing: the default venue-unavailable end
 *  (start + missedCallTerminationMs) plus one sweep tick, so the viewer sees Join OR the ended state. */
export const ROOM_READY_REFRESH_AFTER_START_MS =
  DEFAULT_MEETING_TIMERS.missedCallTerminationMs + 60_000;
/** Hard backstop only — 30 min of refreshes; the deadline above is the real bound. */
export const ROOM_READY_REFRESH_MAX = 60;
