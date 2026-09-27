/**
 * Case inactivity rule (BAL-417; the SWEEP that applies it is BAL-572's hourly
 * `case-inactivity-sweep` in `apps/api` — not BAL-420, which shipped only the
 * delayed-dispatch primitive and is Done. See BAL-425's ruling in
 * `repositories/meeting-contexts.ts`).
 *
 * A case is inactive when BOTH hold:
 *   1. it has NO upcoming scheduled consultation (a booked future consultation
 *      always keeps a case open, however old every anchor below is), AND
 *   2. `now - anchor >= thresholdDays`, where the anchor is the LATEST of four
 *      instants, a `null` one being ignored:
 *        - the CASE'S CREATION — always present, so it is the FLOOR;
 *        - the last COMPLETED consultation;
 *        - the last SCHEDULING action — the newest booking, reschedule or
 *          cancellation of a case consultation, even if that call was later
 *          cancelled or missed;
 *        - the last CHAT activity — the newest message or file from either party,
 *          in the case chat or uploaded during a case call.
 *
 * PURE and dependency-free (no @balo/db, no I/O) so it is bundle-safe and
 * exhaustively unit-testable — deliberately NOT placed next to `AUTO_ACCEPT_DAYS`
 * in `@balo/db`, which carries the documented client-bundle footgun
 * (repositories/project-engagements.ts).
 *
 * ⚠ THE ACTIVITY INPUTS ARE PARAMETERS, NOT QUERIES — this module stays PURE. Two
 * batched `@balo/db` reads supply every anchor except creation:
 *
 *   1. The consultation seam. BAL-418 shipped the link — `meeting_contexts`
 *      (`context_type='case'`, `context_id=engagements.id`) plus
 *      `credit_sessions.meeting_id` — and the scheduling anchor comes from the
 *      meeting audit trail (`meeting.booked`, `meeting.rescheduled`,
 *      `meeting.cancelled`) on those same meetings:
 *
 *        meetingContextsRepository.consultationTimestampsForEngagements(
 *          engagementIds, now
 *        ) → Map<engagementId, {
 *              lastCompletedConsultationAt,
 *              nextScheduledConsultationAt,
 *              lastSchedulingActivityAt,
 *            }>
 *
 *      (rides `meeting_context_reverse_idx` on
 *      `meeting_contexts (context_type, context_id) WHERE deleted_at IS NULL`.)
 *
 *   2. The chat read, which supplies `lastChatActivityAt`. It covers MESSAGES and
 *      FILES in the case chat plus in-call UPLOADS (`meeting_files`, from both the
 *      chat paperclip and the Files tab) on the case's meetings, from either party —
 *      never recordings or transcripts:
 *
 *        conversationsRepository.latestChatActivityAtForEngagements(
 *          engagementIds
 *        ) → Map<engagementId, Date | null>
 *
 * Both are BATCHED — a per-engagement call over a sweep candidate list is a textbook
 * N+1 — and both return an entry for EVERY requested id, so "absent" never has to be
 * distinguished from "none".
 *
 * ⚠ THE SWEEP MUST CALL BOTH READS — and does: BAL-572's hourly `case-inactivity-sweep`
 * (`apps/api`), per the note above. `caseEngagementsRepository.listOpenCreatedBefore`
 * returns only the SQL-expressible SUPERSET (creation-anchored, activity-blind — a
 * superset because creation is the anchor's floor); this function refines it, and it
 * can only refine what it is given. Hand-building ANY anchor instead of taking it from
 * its read's Map — a literal `null`, a `?? null` default on a Map miss, a value from
 * some other query — is a BUG, not a gap: a missing anchor collapses the rule toward
 * "created ≥ 30 days ago" and would auto-close a case that had a consultation
 * yesterday, a booking last week or a message this morning. A Map miss is skipped,
 * never defaulted.
 *
 * ⚠ `caseCreatedAt` MUST be `engagements.created_at` (the PARENT) — the same column
 * `listOpenCreatedBefore` filters on, so the candidate set and the refinement cannot
 * diverge on two clocks.
 */

/**
 * BAL-421 — the CASE SURFACE's pure core (nudge selection + consultation state), re-exported
 * so `@balo/shared/engagements` stays ONE subpath. No `package.json` change: the subpath
 * already points at this file. Same barrel posture as `../meetings/index.ts`.
 */
export * from './case-surface';

/**
 * BAL-572 — the case-close notification payload assembly (`CASE_TITLE_MAX`, `capCaseTitle`,
 * `summariseCaseCloseAnchors`, `buildCaseClosedPayload`), re-exported for the same
 * one-subpath reason as `./case-surface` above.
 */
export * from './case-closed';

/** The default inactivity window, in days. */
export const CASE_INACTIVITY_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface CaseInactivityInput {
  now: Date;
  /** The PARENT `engagements.created_at` — the anchor's floor. */
  caseCreatedAt: Date;
  /** From the consultation seam's Map entry. */
  lastCompletedConsultationAt: Date | null;
  /**
   * The newest booking, reschedule or cancellation of a live case meeting, from the
   * consultation seam's Map entry. REQUIRED: an omitted field would quietly mean "none".
   */
  lastSchedulingActivityAt: Date | null;
  /**
   * The newest live case-chat message or file, or in-call upload, from either party —
   * the chat read's Map value. REQUIRED: an omitted field would quietly mean "none".
   */
  lastChatActivityAt: Date | null;
  /** From the consultation seam's Map entry. */
  nextScheduledConsultationAt: Date | null;
  /** Defaults to `CASE_INACTIVITY_DAYS`. */
  thresholdDays?: number;
}

/** The four instants the inactivity clock can run from. */
export type CaseInactivityAnchorInput = Pick<
  CaseInactivityInput,
  | 'caseCreatedAt'
  | 'lastCompletedConsultationAt'
  | 'lastSchedulingActivityAt'
  | 'lastChatActivityAt'
>;

/** The latest of `floor` and every non-null candidate; a tie keeps the earlier argument. */
function latestOf(floor: Date, ...candidates: Array<Date | null>): Date {
  let latest = floor;
  for (const candidate of candidates) {
    if (candidate !== null && candidate.getTime() > latest.getTime()) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * The instant the inactivity clock runs from: the LATEST of the case's creation, its
 * last completed consultation, its last scheduling action and its last chat activity.
 *
 * ONE `latestOf` over all four, with creation as the floor. Never a `??` chain — it lets
 * an older anchor mask a newer one — and never the latest of the three optional anchors
 * with `?? caseCreatedAt` afterwards, which drops the floor: an anchor older than the
 * case never pulls the clock back before creation (the safe direction). An anchor later
 * than `now` yields a negative elapsed time, so the case reads as active (also safe).
 */
export function caseInactivityAnchor(input: CaseInactivityAnchorInput): Date {
  return latestOf(
    input.caseCreatedAt,
    input.lastCompletedConsultationAt,
    input.lastSchedulingActivityAt,
    input.lastChatActivityAt
  );
}

/**
 * True when the case is eligible for auto-close by the inactivity rule.
 *
 * An UPCOMING scheduled consultation always wins (returns `false`). A consultation
 * already in the past never blocks through this rule, because only a *future*
 * commitment means the case is still live — though its booking or reschedule may
 * still hold the case through the scheduling anchor.
 *
 * The boundary is INCLUSIVE (`>=`): exactly `thresholdDays` elapsed IS inactive,
 * matching `listPendingAutoAccept`'s `lte(completionRequestedAt, cutoff)` convention.
 */
export function isCaseInactive(input: CaseInactivityInput): boolean {
  const { now, nextScheduledConsultationAt } = input;

  if (
    nextScheduledConsultationAt !== null &&
    nextScheduledConsultationAt.getTime() > now.getTime()
  ) {
    return false;
  }

  const anchor = caseInactivityAnchor(input);
  const thresholdMs = (input.thresholdDays ?? CASE_INACTIVITY_DAYS) * MS_PER_DAY;

  return now.getTime() - anchor.getTime() >= thresholdMs;
}
