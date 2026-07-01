import type { ProjectRequestWithRelations, RelationshipStatus } from '@balo/db';

/**
 * Relationship statuses at/after a proposal request — re-requesting one of these
 * is a no-op. Single source of truth shared by the client
 * (`request-proposal.ts`) and admin (`request-proposal-as-admin.ts`) actions so
 * the `proposal_request_count` analytic and the friendly already-requested
 * pre-check agree (BAL-315).
 */
export const AT_OR_PAST_PROPOSAL_REQUEST: ReadonlySet<RelationshipStatus> =
  new Set<RelationshipStatus>(['proposal_requested', 'proposal_submitted', 'accepted']);

/**
 * Earliest live-EOI `submittedAt` across the request's relationships, or `null`
 * when none resolves. Each relationship is hydrated with its newest live EOI
 * (`limit: 1` newest-first — see `findByIdWithRelations`). Known approximation
 * (recorded in the event map): a withdrawn-and-resubmitted EOI reports the
 * resubmit time. Pure + deterministic.
 */
export function firstEoiSubmittedAt(request: ProjectRequestWithRelations): Date | null {
  let earliest: Date | null = null;
  for (const relationship of request.relationships) {
    const [eoi] = relationship.expressionsOfInterest;
    if (eoi === undefined) continue;
    if (earliest === null || eoi.submittedAt.getTime() < earliest.getTime()) {
      earliest = eoi.submittedAt;
    }
  }
  return earliest;
}
