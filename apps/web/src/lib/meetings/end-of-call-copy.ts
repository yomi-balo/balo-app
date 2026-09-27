import type { CaseClosureNames } from '@balo/shared/credit';
import { CASE_CLOSED_ENDED_TITLE, caseClosedFirstClause } from './waiting-copy';

/**
 * BAL-474 (R6-C5, owner-approved) — THE END-OF-CALL COPY FOR A PERSON WHO LEFT AN EARLY CALL BEFORE ITS START.
 *
 * Under billing Rule A the minutes the expert and a client-side participant spend together before the scheduled
 * start are billed and paid. So a call that is `in_progress` while `now < scheduled_start` is NOT "a meeting that
 * hasn't taken place": the neutral "Nothing to wrap up yet" was false for it. This third arm says what is true —
 * the call is still open (End is refused before the start and the idle end is never before the start + 5
 * minutes), they can rejoin from the case page, and the time together so far counts.
 *
 * The rating and the case close stay hidden: post-call eligibility is UNCHANGED (`meetingAllowsPostCallActions`).
 * `{Name}` is the view's `counterpartyName` (the expert's given name for the client lens, the client company for
 * the expert lens). Every string is pinned by equality in `end-of-call-copy.test.ts`.
 */

/** The headline, on both lenses. */
export const CALL_STILL_OPEN_HEADLINE = 'Your call is still open';

/** The client lens's body. */
export function clientCallStillOpenBody(counterpartyName: string): string {
  return `You can rejoin from the case page — the call stays open until its start time. Time you and ${counterpartyName} spent together before then is part of this consultation.`;
}

/** The expert lens's body. */
export function expertCallStillOpenBody(counterpartyName: string): string {
  return `You can rejoin from the case page — the call stays open until its start time. Time you and ${counterpartyName} spent together before then counts toward this session.`;
}

/**
 * BAL-474 (R6F-2, D15.4, owner-approved) — THE END-OF-CALL COPY AFTER A VOIDED NO-SHOW: the meeting ended as a
 * client no-show on a case that was closed before its start. Nothing was billed and nothing is owed, so this arm
 * promises no recap, receipt or payout and offers no rating or resolve.
 *
 * Retrospective, so it names the PERSON with "@ company" (CLAUDE.md). The first clause is the SAME sentence
 * the in-call waiting screen shows (`caseClosedFirstClause` in `waiting-copy.ts`): "{Closer} @ {Company} closed
 * this case before the start time", or "This case was closed before the start time" with no closer, and "their
 * team" for a missing company. Both lenses share one headline — the SAME constant the in-call waiting screen
 * uses (`CASE_CLOSED_ENDED_TITLE`), re-exported here so there is one string, not two byte-identical ones.
 */
export { CASE_CLOSED_ENDED_TITLE as CASE_CLOSED_HEADLINE };

/** The client lens's body. */
export function clientCaseClosedBody(closure: CaseClosureNames): string {
  return `${caseClosedFirstClause(closure)}, so this consultation didn't take place and nothing was charged.`;
}

/** The expert lens's body. */
export function expertCaseClosedBody(closure: CaseClosureNames): string {
  return `${caseClosedFirstClause(closure)}, so this call isn't billed and no payout is recorded.`;
}
