import {
  projectRequestStatusEnum,
  type ProjectRequest,
  type RequestExpertRelationship,
} from '../../schema';

/** Request-level status (the stored, derived max-progress aggregate). */
type ProjectRequestStatus = ProjectRequest['status'];
/** Per-expert relationship status (one input to the aggregate). */
type RelationshipStatus = RequestExpertRelationship['status'];

/**
 * Scope-translation map: per-expert relationship status → the request-level
 * status that relationship CONTRIBUTES to the max-progress rollup (ADR-1025).
 *
 * NAMING TRAP: `proposal_requested` and `proposal_submitted` exist in BOTH the
 * relationship enum AND the request enum, at DIFFERENT scopes. This map is a
 * deliberate scope translation, NOT an identity — even where the labels coincide,
 * the left side is a per-expert state and the right side is the request aggregate.
 * Do not "simplify" it to `status as ProjectRequestStatus`.
 *
 * `declined` is intentionally ABSENT: a declined relationship contributes nothing
 * to the rollup (a declined expert must never advance — or hold up — the request).
 * Typing the key as `Exclude<…, 'declined'>` makes that exclusion exhaustive and
 * compiler-checked, so adding a new relationship status forces a decision here.
 */
export const RELATIONSHIP_TO_REQUEST_STATUS: Record<
  Exclude<RelationshipStatus, 'declined'>,
  ProjectRequestStatus
> = {
  invited: 'experts_invited',
  eoi_submitted: 'eoi_submitted',
  proposal_requested: 'proposal_requested',
  proposal_submitted: 'proposal_submitted',
  accepted: 'accepted',
};

/**
 * Rank a request status by its position in the canonical progress order
 * (`projectRequestStatusEnum.enumValues` is already declared in advancing order).
 * A higher index = further along. Unknown values cannot occur (the inputs are
 * enum-typed), so `indexOf` is total over the value space.
 */
function rank(status: ProjectRequestStatus): number {
  return projectRequestStatusEnum.enumValues.indexOf(status);
}

/**
 * Derive the request-level status as the MAX-PROGRESS rollup over its live
 * per-expert relationship statuses, never regressing below the current value
 * (ADR-1025). PURE — no DB, no `Date`, no I/O — so it is the single source of
 * truth for "what status does this request's graph imply" and is unit-testable in
 * isolation. The locked transition path (`advanceRelationshipStatus`) feeds it the
 * freshly-read live statuses and the current stored status and persists the result.
 *
 * Semantics:
 *  - **Max-progress.** The derived status is the furthest-along status any single
 *    non-`declined` relationship maps to (e.g. a mix of `{proposal_submitted,
 *    eoi_submitted}` derives `proposal_submitted`).
 *  - **Never regresses.** The result is never earlier than `currentRequestStatus`,
 *    so admin-only milestones the relationships don't model
 *    (`exploratory_meeting_requested`, `kickoff_approved`) and the pre-relationship
 *    states (`draft`, `requested`) are preserved once reached.
 *  - **`declined` contributes nothing.** It is not in the map, so it is skipped.
 *  - **All-declined / empty set.** No relationship contributes → the current status
 *    is returned unchanged (e.g. all experts declined → the request stays at
 *    `experts_invited`).
 *    // TODO(ADR-1025): revisit if a request-level stalled state is needed.
 *
 * @param relationshipStatuses live (non-soft-deleted) per-expert statuses for the request
 * @param currentRequestStatus the request's current stored status (the floor)
 */
export function deriveRequestStatus(
  relationshipStatuses: RelationshipStatus[],
  currentRequestStatus: ProjectRequestStatus
): ProjectRequestStatus {
  let bestRank = rank(currentRequestStatus);

  for (const relationshipStatus of relationshipStatuses) {
    if (relationshipStatus === 'declined') {
      continue; // declined relationships contribute nothing to the rollup
    }
    const mapped = RELATIONSHIP_TO_REQUEST_STATUS[relationshipStatus];
    const mappedRank = rank(mapped);
    if (mappedRank > bestRank) {
      bestRank = mappedRank;
    }
  }

  const derived = projectRequestStatusEnum.enumValues[bestRank];
  // `bestRank` originates from `indexOf` over the same array, so it is always a
  // valid index — guard for `noUncheckedIndexedAccess` rather than assert.
  return derived ?? currentRequestStatus;
}
