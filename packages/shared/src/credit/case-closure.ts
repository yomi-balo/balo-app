/**
 * BAL-474 (ADR-1040 Amendment 7 §D, D12.1(c)) — THE ONE CLOSED-CASE PREDICATE.
 *
 * A Case the client closed BEFORE the meeting's scheduled start is not a consultation the expert can
 * bill a NO-SHOW against: the client resolved it before anyone was due, so an expert who waits alone
 * owes them nothing. `closedAt < scheduledStart` — or a non-active case that records no close instant
 * at all, which is never billed on a guess.
 *
 * ⚠⚠ IT VOIDS A NO-SHOW ONLY. A call that was ATTENDED (the expert and a client-side participant were
 * together, or a client-side participant was present) always bills as `held`, whatever the case's
 * status: a closure never voids an attended call. Callers decide `attended` from the settlement
 * shape (`held`), never from this predicate. A case closed AT or AFTER the start — a client who
 * resolves it while the expert waits — still owes the floor.
 *
 * Pure: the caller supplies the two facts it read.
 */
export function caseClosedBeforeStart(
  subject: { readonly isActive: boolean; readonly closedAt: Date | null },
  scheduledStart: Date
): boolean {
  if (subject.isActive) {
    return false;
  }
  return subject.closedAt === null || subject.closedAt.getTime() < scheduledStart.getTime();
}

/** The two names a closed-case sentence interpolates. Either is `null` when it cannot be attributed. */
export interface CaseClosureNames {
  /** `null` when the inactivity sweep closed the case (no human actor), or the closer has no usable first name. */
  readonly closedByFirstName: string | null;
  /** `null` when the company cannot be read. */
  readonly companyName: string | null;
}

/**
 * BAL-474 (R6-C3 / R6F-2) — THE ONE ASSEMBLY of a closed-case sentence's two names, shared by the in-call state
 * route and the end-of-call screen so the two cannot disagree about who closed the case. Pure: the caller supplies
 * the rows it read. A blank first name is `null`, never an empty attribution.
 */
export function caseClosureNames(
  closer: { readonly firstName: string | null } | undefined,
  company: { readonly name: string } | undefined
): CaseClosureNames {
  const firstName = closer?.firstName?.trim() ?? '';
  return {
    closedByFirstName: firstName.length > 0 ? firstName : null,
    companyName: company?.name ?? null,
  };
}
