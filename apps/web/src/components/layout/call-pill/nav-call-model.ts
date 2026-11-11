import type { NavCallEventBase } from '@balo/analytics/events';
import { signedMinutesUntilCalendarStart } from '@/lib/calendar/join-window';
import { meetingTypeLabel } from '@/lib/meetings/meeting-type-label';
import type { NavCallView } from '@/lib/meetings/nav-call-view-types';
import { meetingIdOfRecapOrEndPath } from '@/lib/meetings/own-meeting-route';
import { resolveUpNextRowTiming, type UpNextRowTiming } from '@/lib/meetings/up-next-presentation';

/**
 * BAL-636 — pure, client-safe selection for the top-nav call pill. `now` is always injected (the
 * server-anchored clock), never read here.
 */

export interface NavCallCandidate {
  readonly call: NavCallView;
  readonly timing: UpNextRowTiming;
}

export interface NavCallSelection {
  readonly primary: NavCallCandidate | null;
  readonly others: NavCallCandidate[];
}

function compareLatestStartFirst(a: NavCallCandidate, b: NavCallCandidate): number {
  const byStart =
    new Date(b.call.scheduledStart).getTime() - new Date(a.call.scheduledStart).getTime();
  if (byStart !== 0) return byStart;
  if (a.call.meetingId === b.call.meetingId) return 0;
  return a.call.meetingId < b.call.meetingId ? -1 : 1;
}

/**
 * Candidates = every call whose window is open (joinable, or the room is still being set up),
 * minus the one whose own recap/end page is the current page. Primary = the LATEST start: with
 * back-to-back calls the one just opening is the one the person is heading to.
 */
export function selectNavCalls(
  calls: readonly NavCallView[],
  now: Date,
  pathname: string
): NavCallSelection {
  const excludedId = meetingIdOfRecapOrEndPath(pathname);
  const candidates = calls
    .filter((call) => call.meetingId !== excludedId)
    .map((call) => ({ call, timing: resolveUpNextRowTiming(call, now) }))
    .filter(({ timing }) => timing.joinVisible || timing.roomSettingUp)
    .sort(compareLatestStartFirst);

  const [primary, ...others] = candidates;
  return { primary: primary ?? null, others };
}

/**
 * Quiet = the pill's Join must not animate: a page-level Join already rings, or the call is in its
 * overrun grace (the urgency is the start, not the grace).
 */
export function navCallIsQuiet(input: {
  readonly joinOnPage: boolean;
  readonly now: Date;
  readonly scheduledEnd: Date;
}): boolean {
  return input.joinOnPage || input.now.getTime() >= input.scheduledEnd.getTime();
}

/** ⚠ `minutes_to_start` comes ONLY from `signedMinutesUntilCalendarStart` and is never floored. */
export function navCallEventProps(
  candidate: NavCallCandidate,
  context: {
    readonly now: Date;
    readonly quiet: boolean;
    readonly workspaceType: NavCallEventBase['workspace_type'];
  }
): NavCallEventBase {
  return {
    meeting_type: candidate.call.contextType,
    minutes_to_start: signedMinutesUntilCalendarStart(
      context.now,
      new Date(candidate.call.scheduledStart)
    ),
    quiet: context.quiet,
    other_workspace: candidate.call.otherWorkspace,
    workspace_type: context.workspaceType,
  };
}

export function navCallPartyName(
  call: Pick<NavCallView, 'counterpartyName' | 'contextType'>
): string {
  return call.counterpartyName ?? meetingTypeLabel(call.contextType);
}
