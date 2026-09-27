import { MAX_SESSION_MINUTES } from '../pricing';

/**
 * THE pre-connect ESTIMATE, in whole minutes, from a meeting's scheduled window — the ONE
 * estimator shared by admission (`joinMeetingAsMember` sizes the hold with it), the sessionless
 * terminal-path open, and both booking funding checks (the web gate and `POST /meetings`), so the
 * figure a booking is refused on is the figure admission will actually hold (BAL-474 §I.3, AD-13).
 * Moved here from `apps/api/src/services/meetings/join-meeting.ts` (BAL-466) unchanged.
 *
 * ⚠ CLAMPED TO `[1, MAX_SESSION_MINUTES]`. `estimatedMinutes` sizes the pre-connect HOLD, and
 * `openSessionBodySchema` caps the wire at `MAX_SESSION_MINUTES` for exactly that reason — a
 * service-side caller must not be able to over-size a hold that the route could not. A window of
 * zero or negative length (a corrupt row) becomes 1, never 0: a zero-minute hold would pass the
 * funds gate for a wallet with no money at all.
 */
export function estimatedMinutesForWindow(scheduledStart: Date, scheduledEnd: Date): number {
  const raw = Math.ceil((scheduledEnd.getTime() - scheduledStart.getTime()) / 60_000);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, MAX_SESSION_MINUTES);
}
