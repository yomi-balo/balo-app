/**
 * BAL-129 (D5) / BAL-474 (ADR-1040 Amendment 7 §C.2, D5.6) — resolve the BILLING SUBJECT of a Case
 * meeting, SERVER-SIDE, from the meeting alone: the engagement it bills and that engagement's two
 * parties (the client company that pays, the expert who is paid).
 *
 * ONE resolution, shared by every path that opens a credit session for a meeting:
 *   · a client MEMBER's admission (`openSession`) — `requireActive: true`, then the caller's own
 *     company / expert equality checks (the IDOR gate);
 *   · a client-side GUEST's admission and the SESSIONLESS terminal-path open
 *     (`open-on-behalf-of-booker.ts`, `settle-sessionless-case-meeting.ts`) — `requireActive: false`.
 *
 * ⚠ `requireActive` IS THE ONE DIFFERENCE BETWEEN THE TWO, AND IT IS DELIBERATE (D5.6).
 *   · A member's admission requires an ACTIVE engagement: a closed case refuses joins
 *     (`meeting-liveness.ts`), so it cannot legitimately bill, and a `completed` case must not
 *     remain a permanent handle for drawing down credit.
 *   · The system / guest open checks COHERENCE ONLY. A client who resolves the case while the
 *     expert is still waiting must not void the no-show: the expert waited the floor and is owed it.
 *     Coherence is: exactly one `case` context with a `contextId`, the engagement exists, and its
 *     type is `case`; the company and the expert come from that ONE row. The result carries the
 *     close instant, so the on-behalf path can refuse a case closed BEFORE the meeting started
 *     (D10.5) — a case closed while the expert waited stays billable.
 *
 * ⚠ THE PARTIES COME FROM THE ENGAGEMENT ROW, NEVER FROM A CALLER. A caller that also holds a
 * company / expert id from elsewhere (the member path holds both) compares them to this subject —
 * that comparison IS the ownership lookup, and there must not be a second one.
 *
 * ⚠ MEETING STATUS IS NOT CHECKED. `findWithContexts` filters soft-deleted rows; that is the only
 * liveness requirement here. A session may legitimately be opened for a meeting in `scheduled` or
 * `waiting_for_participants` (admission) or `ended` (the terminal path).
 */
import { caseEngagementsRepository, meetingsRepository } from '@balo/db';

export interface CaseBillingSubject {
  readonly engagementId: string;
  readonly companyId: string;
  readonly expertProfileId: string;
  /** `true` while the engagement is `active`. Only a `requireActive: false` read can see `false`. */
  readonly isActive: boolean;
  /**
   * When the client closed the case (`case_engagements.closed_at`). `null` for an active case, and
   * for a non-active case that records no close instant.
   */
  readonly closedAt: Date | null;
  /**
   * BAL-474 (R6-C3) — the CLIENT-SIDE user who closed the case (`case_engagements.closed_by_user_id`), for
   * the expert's "who closed it" sentence. `null` for an active case, for an inactivity-sweep close (no
   * human actor), and when the case child row is unreadable.
   */
  readonly closedByUserId: string | null;
}

/**
 * `undefined` ⇒ the meeting does not resolve to a billable Case engagement (missing / soft-deleted
 * meeting, zero or more than one `case` context, an engagement that is missing, not a case, or —
 * when `requireActive` — not active). WHICH of those it was is the caller's log to write, never the
 * wire's: distinguishing them would tell a caller whether a guessed uuid exists.
 */
export async function resolveCaseBillingSubject(
  meetingId: string,
  opts: { requireActive: boolean }
): Promise<CaseBillingSubject | undefined> {
  const found = await meetingsRepository.findWithContexts(meetingId); // live rows only
  if (found === undefined) {
    return undefined;
  }

  const caseContexts = found.contexts.filter((c) => c.contextType === 'case');
  const [caseContext] = caseContexts; // destructure + guard, never `!`
  if (caseContext === undefined || caseContexts.length !== 1 || caseContext.contextId === null) {
    return undefined;
  }

  // D17.5 — the engagement-then-case-row read is `caseEngagementsRepository.findClosureSubject`,
  // shared with the web end-of-call loader (`load-end-of-call.ts`). Same `requireActive` flag, so
  // this is a drop-in for what used to be inlined here.
  const subject = await caseEngagementsRepository.findClosureSubject(caseContext.contextId, opts);
  if (subject === undefined) {
    return undefined;
  }
  return { engagementId: caseContext.contextId, ...subject };
}
