import type {
  ProjectRequestWithRelations,
  ProjectRequestCloseReason,
  RelationshipDeclineReason,
} from '@balo/db';
import { personWithOrgLabel } from '@balo/shared/parties';
import type { RequestViewerContext } from './resolve-request-lens';

/**
 * closed-request-view — BAL-540 Phase 6.3's read-side home for the closed-request
 * projection, and D11's `close_note` audience-gating home (the invariant
 * `apps/web/src/invariants/request-close-capability-gated.test.ts` scans this
 * file — it is listed in that test's `PROJECT_REQUEST_FILES` / `PINNED_FILES`).
 *
 * ⚠ THEREFORE: NO `lens` / `role` / `platformRole` / `activeMode` COMPARISON MAY APPEAR IN
 * THIS FILE, in either direction (`===` or `!==`). The staff-only gate here is
 * `ctx.canSeeStaffOnly` — a CAPABILITY (`hasPlatformCapability(CLOSE_ANY_REQUEST)`) resolved
 * once by `resolveRequestLens`. Per-lens PRESENTATION choices live one level up, in
 * `request-detail-view.ts`'s `mapRequestToDetailView`, which is where every other one already
 * is. That separation is what makes the invariant's claim literally true rather than vacuous
 * (fix round, review finding 3).
 *
 * PURE + SYNCHRONOUS. The two DB reads this projection needs (the closer's
 * display name, and the `project_request.closed` audit row's counts) are done by
 * the PAGE (`page.tsx`) and threaded in as {@link ClosedSummaryInput} — this
 * module never imports `@balo/db` as a VALUE and is never `server-only`, so it
 * stays as testable as the rest of `request-detail-view.ts`.
 */

/** The primitive fields the page has already resolved via I/O before calling {@link deriveClosedSummary}. */
export interface ClosedSummaryInput {
  /** The closer's display name (`personDisplayName(firstName, lastName)` — never raw). */
  closedByName: string;
  /** Read from the `project_request.closed` audit row's `metadata.counts` (see D8 — the cause/counts live on the audit row, never on `project_requests` or `proposals`). */
  counts: { tracksEnded: number; proposalsWithdrawn: number; meetingsCancelled: number };
}

export interface ClosedRequestSummary {
  closedAtIso: string;
  reason: ProjectRequestCloseReason;
  /** Retrospective attribution: the PERSON "@ company/Balo" (CLAUDE.md). */
  closedByLabel: string;
  closedByParty: 'client' | 'balo';
  /** ⚠ STAFF-ONLY (D11). `null` on every lens that does not hold `CLOSE_ANY_REQUEST`. */
  note: string | null;
  counts: { tracksEnded: number; proposalsWithdrawn: number; meetingsCancelled: number };
}

/**
 * `null` unless the request is genuinely closed AND the caller supplied the two
 * async-resolved primitives (`page.tsx` skips the extra reads for a live request).
 *
 * `closedByParty` is derived from `reason` alone — `'withdrawn'` is the client
 * arm's ONLY reason (`close-request.ts`'s schema never accepts it from the Balo
 * arm), so no separate actor-kind field needs to be threaded through.
 *
 * ⚠ THE `close_note` GATE (D11). `note` is `ctx.canSeeStaffOnly ? request.closeNote
 * : null` — a CAPABILITY, never `ctx.archetype === 'observer'` (the lens-gate
 * shape PR #273's appendix flags as a defect on the fee line). Do not copy that
 * shape here.
 */
export function deriveClosedSummary(
  request: ProjectRequestWithRelations,
  ctx: RequestViewerContext,
  input: ClosedSummaryInput | null
): ClosedRequestSummary | null {
  if (
    request.status !== 'closed' ||
    request.closedAt === null ||
    request.closeReason === null ||
    input === null
  ) {
    return null;
  }
  const closedByParty: 'client' | 'balo' = request.closeReason === 'withdrawn' ? 'client' : 'balo';
  const orgLabel = closedByParty === 'balo' ? 'Balo' : request.company.name;
  return {
    closedAtIso: request.closedAt.toISOString(),
    reason: request.closeReason,
    closedByLabel: personWithOrgLabel(input.closedByName, orgLabel),
    closedByParty,
    note: ctx.canSeeStaffOnly ? request.closeNote : null,
    counts: input.counts,
  };
}

/** One frozen track on a closed request — display-only (no EOI HTML, no money, no contact). */
export interface ClosedTrackView {
  relationshipId: string;
  expertName: string;
  expertInitials: string;
  partyLabel: string;
  finalChip: 'invite_withdrawn' | 'declined' | 'ended_request_closed';
  endedLabel: string;
}

function initialsFor(name: string): string {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return initials.length > 0 ? initials : '?';
}

/**
 * `declineReason` (+ EOI presence) → the frozen track's final chip + ended-label (design ref
 * `TrackCard`, `:484-496`; plan §6.3's exact rule): `request_closed` ⇒ `ended_request_closed`;
 * otherwise a deliberate per-track decline — `invite_withdrawn` when the track never got past
 * a bare invite (no live EOI), `declined` when it had at least reached `eoi_submitted`.
 */
function finalChipFor(
  declineReason: RelationshipDeclineReason | null,
  hasLiveEoi: boolean
): {
  finalChip: ClosedTrackView['finalChip'];
  endedLabel: string;
} {
  if (declineReason === 'request_closed') {
    return {
      finalChip: 'ended_request_closed',
      endedLabel: 'Ended when the request closed · files as they were',
    };
  }
  // `client_declined` / `balo_declined` — a deliberate per-track decline BEFORE the request
  // itself closed.
  if (!hasLiveEoi) {
    return {
      finalChip: 'invite_withdrawn',
      endedLabel: 'Invite withdrawn before the request closed',
    };
  }
  return { finalChip: 'declined', endedLabel: 'Declined before the request closed' };
}

/**
 * Every relationship's frozen state, for a CLOSED request. Empty for anything else.
 * Pure + deterministic; mirrors `deriveRelationshipView`'s per-track fold.
 *
 * ⚠ TAKES NO VIEWER CONTEXT, DELIBERATELY. The audience narrowing (client + admin only — an
 * expert never sees a counterparty's track list; see `resolve-ended-track-view.ts` for the
 * expert's OWN, strictly narrower closed-state view) belongs to the caller,
 * `request-detail-view.ts`'s `mapRequestToDetailView`, alongside every other per-lens
 * projection choice it already makes. Keeping the lens read OUT of this module is what lets
 * `request-close-capability-gated.test.ts` scan this file — D11's `close_note` home — for
 * VIEW-shaped tokens without a per-file exemption. Pinned by
 * `request-detail-view.test.ts`'s "expert never sees the counterparty track list".
 */
export function deriveClosedTracks(request: ProjectRequestWithRelations): ClosedTrackView[] {
  if (request.status !== 'closed') {
    return [];
  }
  return request.relationships.map((relationship) => {
    const { user } = relationship.expertProfile;
    const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    const expertName = full.length > 0 ? full : 'Invited expert';
    const hasLiveEoi = relationship.expressionsOfInterest.length > 0;
    const { finalChip, endedLabel } = finalChipFor(relationship.declineReason, hasLiveEoi);
    return {
      relationshipId: relationship.id,
      expertName,
      expertInitials: initialsFor(expertName),
      // ⚠ Collapses to `expertName` — see `close-copy.ts`'s docblock on why a genuine
      // agency/company "party" label is a documented deviation, not yet plumbed onto this
      // view.
      partyLabel: expertName,
      finalChip,
      endedLabel,
    };
  });
}
