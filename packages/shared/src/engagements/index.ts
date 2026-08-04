/**
 * Case inactivity rule (BAL-417; the SWEEP that applies it is BAL-420's).
 *
 * A case is inactive when BOTH hold:
 *   1. it has NO upcoming scheduled consultation (a booked future consultation
 *      always keeps a case open, however long it has been quiet), AND
 *   2. `now - anchor >= thresholdDays`, where the anchor is the LAST COMPLETED
 *      consultation, falling back to the CASE'S CREATION when none has completed.
 *
 * PURE and dependency-free (no @balo/db, no I/O) so it is bundle-safe and
 * exhaustively unit-testable — deliberately NOT placed next to `AUTO_ACCEPT_DAYS`
 * in `@balo/db`, which carries the documented client-bundle footgun
 * (repositories/project-engagements.ts).
 *
 * ⚠ THE CONSULTATION INPUTS ARE PARAMETERS, NOT QUERIES. There is no FK between
 * `case_engagements` and any consultation/session table yet (`credit_sessions` has
 * no `engagement_id`; `consultations` is an availability stub). The link is
 * BAL-418's `meeting_contexts` (`context_type='case'`, `context_id=engagements.id`)
 * plus `credit_sessions.meeting_id`; BAL-420 supplies both timestamps once that
 * lands. Until then `caseEngagementsRepository.listOpenCreatedBefore` returns the
 * SQL-expressible SUPERSET (creation-anchored, consultation-blind) and this
 * function refines it.
 *
 * ⚠ DO NOT RUN A SWEEP OVER THIS BEFORE BAL-418. With no link, both timestamps can
 * only be `null`, which collapses the rule to "created ≥ 30 days ago" and would
 * auto-close a case that had a consultation yesterday and another booked tomorrow.
 * Nothing calls this in BAL-417 (D4), which is the only reason it is safe.
 *
 * ⚠ `caseCreatedAt` MUST be `engagements.created_at` (the PARENT) — the same column
 * `listOpenCreatedBefore` filters on, so the candidate set and the refinement cannot
 * diverge on two clocks.
 */

/** The default inactivity window, in days. */
export const CASE_INACTIVITY_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface CaseInactivityInput {
  now: Date;
  /** The PARENT `engagements.created_at`. */
  caseCreatedAt: Date;
  lastCompletedConsultationAt: Date | null;
  nextScheduledConsultationAt: Date | null;
  /** Defaults to `CASE_INACTIVITY_DAYS`. */
  thresholdDays?: number;
}

/**
 * The instant the inactivity clock runs from: the last COMPLETED consultation, or
 * the case's creation when none has completed.
 */
export function caseInactivityAnchor(input: {
  caseCreatedAt: Date;
  lastCompletedConsultationAt: Date | null;
}): Date {
  return input.lastCompletedConsultationAt ?? input.caseCreatedAt;
}

/**
 * True when the case is eligible for auto-close by the inactivity rule.
 *
 * An UPCOMING scheduled consultation always wins (returns `false`) — a consultation
 * already in the past never blocks, however recently it was scheduled, because only
 * a *future* commitment means the case is still live.
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

  const anchor = caseInactivityAnchor({
    caseCreatedAt: input.caseCreatedAt,
    lastCompletedConsultationAt: input.lastCompletedConsultationAt,
  });
  const thresholdMs = (input.thresholdDays ?? CASE_INACTIVITY_DAYS) * MS_PER_DAY;

  return now.getTime() - anchor.getTime() >= thresholdMs;
}
