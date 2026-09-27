/**
 * ⚠⚠ Deliberately does NOT import `withinJoinWindow` (`@balo/shared/engagements`, `case-surface.ts`
 * — the predicate behind `selectCaseNudge`'s `live` flag, also enforced server-side by
 * `assertMeetingJoinable`'s step 3, D16). This composes a new BOOLEAN over the same OPENING INSTANT
 * (D17.5 — {@link joinWindowOpensAt}, the one function that instant comes from, shared with the
 * server's own `opensAt`), with identical semantics (inclusive at the boundary, no closing bound),
 * so a row's pill and menu never disagree with what the nudge says about the same meeting.
 *
 * ⚠⚠ INVARIANT: this predicate and `withinJoinWindow` MUST AGREE at every instant, not merely
 * today. `case-nudge.tsx`'s client clock derives the nudge's own liveness from THIS function
 * applied to the server's render instant (BAL-574) — so if the two formulas ever diverge, the
 * client's first paint stops matching what the server itself decided. `case-join-window.test.ts`
 * pins agreement against `selectCaseNudge`'s public `live` output at the boundary; that test must
 * stay green for both formulas to change independently.
 */
import { joinWindowOpensAt } from '@balo/shared/engagements';

export function insideCaseJoinWindow(now: Date, scheduledStartIso: string): boolean {
  const scheduledStart = new Date(scheduledStartIso);
  return now.getTime() >= joinWindowOpensAt(scheduledStart).getTime();
}
