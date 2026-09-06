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
 * The request statuses NO relationship can ever express — the "admin-milestone floor".
 *
 * ⚠ THIS SET IS WHAT MAKES THE LOWERING **FLOORED** RATHER THAN UNCONDITIONAL (BAL-540 /
 * ADR-1025 Amendment 1, orchestrator D2). Without it, declining the furthest track would
 * regress an `accepted` or `kickoff_approved` request back to whatever a live track happens
 * to express — which is exactly what `derive-request-status.test.ts`'s two floor cases and
 * `request-status-coherence.integration.test.ts` scenario 5 forbid.
 *
 * ⚠ IT IS **NOT** THE COMPLEMENT OF `RELATIONSHIP_TO_REQUEST_STATUS`'s VALUE SET, despite an
 * earlier version of this comment saying so. `accepted` is in BOTH (a relationship genuinely
 * CAN express `accepted`), and `closed` is in neither. What this set actually is: the statuses
 * orchestrator decision D2 FIXES as the floor — the four admin milestones plus `accepted`,
 * which no LIVE rollup may argue a request down from. `experts_invited`, `eoi_submitted`,
 * `proposal_requested` and `proposal_submitted` are deliberately absent because a request MAY
 * legitimately drop back to one of them when the track holding it up declines; `accepted` is
 * present because it may not.
 *
 * ⚠ `closed` IS DELIBERATELY ABSENT. Rule 1 below short-circuits it before this set is ever
 * consulted; adding it here would say "closed is a floor a rollup may climb above", which is
 * the opposite of terminal. Do not add it.
 *
 * Typed `ReadonlySet<ProjectRequestStatus>` so a future request-status label is at least
 * VISIBLE here (a `Set` cannot be exhaustiveness-checked, so this is a signpost, not a
 * tripwire — the tripwire is `STATUS_TRANSITIONS` in `repositories/project-requests.ts`).
 */
const ADMIN_MILESTONE_STATUSES: ReadonlySet<ProjectRequestStatus> = new Set<ProjectRequestStatus>([
  'draft',
  'requested',
  'exploratory_meeting_requested',
  'accepted',
  'kickoff_approved',
]);

/**
 * Derive the request-level status as the max-progress rollup over its live per-expert
 * relationship statuses (ADR-1025), FLOORED at the admin milestones and short-circuited by
 * the terminal `closed` (ADR-1025 Amendment 1 / BAL-540). PURE — no DB, no `Date`, no I/O —
 * so it is the single source of truth for "what status does this request's graph imply" and
 * is unit-testable in isolation. The locked transition path (`advanceRelationshipStatus`)
 * feeds it the freshly-read live statuses and the current stored status and persists the
 * result.
 *
 * Semantics, in evaluation order:
 *
 *  1. **A TERMINAL STATE WINS.** `currentRequestStatus === 'closed'` returns `'closed'`
 *     unchanged. No relationship's progress may argue a request out of a close — including a
 *     track inserted after the close cascade snapshotted its list. This is a SHORT-CIRCUIT,
 *     not a reliance on `closed` ranking highest: rank order is an enum-declaration accident
 *     and this rule must survive a future label being appended after it.
 *
 *  2. **MAX-PROGRESS OVER THE LIVE TRACKS, FLOORED AT THE ADMIN MILESTONES.** The result is
 *     `max(furthest LIVE track, admin-milestone floor)` — **not** a floor on `current`. That
 *     is the behaviour change BAL-540 makes: declining the furthest track DROPS the request
 *     back to its furthest remaining live track (the kanban requirement), while declining a
 *     non-furthest track moves nothing. An `accepted` / `kickoff_approved` /
 *     `exploratory_meeting_requested` request still cannot be argued down, because those
 *     statuses are in {@link ADMIN_MILESTONE_STATUSES} and seed the floor.
 *
 *  3. **`declined` CONTRIBUTES NOTHING.** It is not in `RELATIONSHIP_TO_REQUEST_STATUS`, so
 *     it is skipped — a declined expert must never advance, nor hold up, the request.
 *
 *  4. **EMPTY CONTRIBUTING SET** (no relationships, or every one `declined`) ⇒ the current
 *     status is returned unchanged. Unchanged from ADR-1025, and still what
 *     `request-status-coherence.integration.test.ts` scenarios 4 and 5 pin: all-declined
 *     leaves the request at `experts_invited`, and a lone declining track leaves it at
 *     `exploratory_meeting_requested`. It falls out of the arithmetic rather than being a
 *     special case — with no live track and a non-milestone `current`, `bestRank` is still
 *     its `-1` sentinel; with a milestone `current`, the floor already equals `current`.
 *
 * @param relationshipStatuses live (non-soft-deleted) per-expert statuses for the request
 * @param currentRequestStatus the request's current stored status
 */
export function deriveRequestStatus(
  relationshipStatuses: RelationshipStatus[],
  currentRequestStatus: ProjectRequestStatus
): ProjectRequestStatus {
  // Rule 1 — terminal wins, before anything else is read.
  if (currentRequestStatus === 'closed') {
    return 'closed';
  }

  // Rule 2's seed: the admin-milestone floor, or the `-1` sentinel meaning "no floor" (which
  // is also, per rule 4, "nothing to derive from if no live track contributes either").
  let bestRank = ADMIN_MILESTONE_STATUSES.has(currentRequestStatus)
    ? rank(currentRequestStatus)
    : -1;

  for (const relationshipStatus of relationshipStatuses) {
    if (relationshipStatus === 'declined') {
      continue; // rule 3 — declined relationships contribute nothing to the rollup
    }
    const mapped = RELATIONSHIP_TO_REQUEST_STATUS[relationshipStatus];
    const mappedRank = rank(mapped);
    if (mappedRank > bestRank) {
      bestRank = mappedRank;
    }
  }

  // Rule 4 — `bestRank < 0` ⟺ no live track contributed AND `current` is not a milestone,
  // because every live track maps to a valid (>= 0) rank. Nothing to derive: leave it be.
  if (bestRank < 0) {
    return currentRequestStatus;
  }

  const derived = projectRequestStatusEnum.enumValues[bestRank];
  // `bestRank` originates from `indexOf` over the same array, so it is always a
  // valid index — guard for `noUncheckedIndexedAccess` rather than assert.
  return derived ?? currentRequestStatus;
}
