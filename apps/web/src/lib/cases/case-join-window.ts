/**
 * ⚠⚠ Deliberately does NOT import `withinJoinWindow` (`packages/shared/src/engagements/case-
 * surface.ts:130`) — that predicate is private to `selectCaseNudge`'s own `live` flag. This
 * composes a new one over the same exported `CASE_JOIN_WINDOW_MINUTES` constant, with identical
 * semantics (inclusive at the boundary, no closing bound), so a row's pill and menu never
 * disagree with what the nudge says about the same meeting.
 */
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';

const MS_PER_MINUTE = 60_000;

export function insideCaseJoinWindow(now: Date, scheduledStartIso: string): boolean {
  const scheduledStart = new Date(scheduledStartIso);
  return scheduledStart.getTime() - now.getTime() <= CASE_JOIN_WINDOW_MINUTES * MS_PER_MINUTE;
}
