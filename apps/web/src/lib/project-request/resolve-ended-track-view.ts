import type { ProjectRequestWithRelations } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-540 — the ONE surface a de-participated expert may still see. `resolveRequestLens` is
 * UNCHANGED and still returns `null` for a declined track (D13): this is a SECOND, strictly
 * narrower branch consulted only after it (deviation V1, `plan-bal-540.md` §Deviations). It
 * exists because ADR-1048's historical-read guarantee (`resolveRequestTrackFileAccess` →
 * `{kind:'closed'}`) is unreachable if the page 404s, and because `project.track_declined`'s
 * in-app notice deep-links here.
 *
 * It carries the TITLE, the ended state and nothing else — no brief, no contact, no
 * conversation, no action. Pure + synchronous.
 */
export interface EndedTrackView {
  mode: 'declined' | 'request_closed';
  relationshipId: string;
  title: string;
  companyName: string;
  endedAtIso: string;
  hadProposal: boolean;
}

/**
 * Returns non-null only when `user.expertProfileId` matches a LIVE relationship whose status
 * is `declined`. `mode` reads the relationship's `declineReason`: `'request_closed'` (the
 * whole request ended) vs a deliberate per-track decline (`'client_declined'` /
 * `'balo_declined'`, both surfaced as `mode: 'declined'` — the expert's copy does not
 * distinguish WHO declined them, only whether it was their own track or the whole request).
 * `endedAtIso` reads `declinedAt`; a relationship with no `declinedAt`/`declineReason` yet
 * (a data anomaly — every `declined` row is stamped by `advanceRelationshipStatus` — OR a
 * pre-BAL-540 fixture/row that predates the D3 attribution columns) resolves to `null` rather
 * than guessing, so the caller falls back to its existing not-a-participant denial.
 */
export function resolveEndedTrackView(
  user: SessionUser,
  request: ProjectRequestWithRelations
): EndedTrackView | null {
  if (user.expertProfileId === undefined) return null;

  const relationship = request.relationships.find(
    (r) => r.expertProfileId === user.expertProfileId && r.status === 'declined'
  );
  if (relationship === undefined) return null;
  // Falsy check (not `=== null`) — deliberately catches `undefined` too, defending against a
  // row that predates the D3 attribution columns, not only an explicit `null`.
  if (!relationship.declinedAt || !relationship.declineReason) return null;

  const mode: EndedTrackView['mode'] =
    relationship.declineReason === 'request_closed' ? 'request_closed' : 'declined';

  return {
    mode,
    relationshipId: relationship.id,
    title: request.title,
    companyName: request.company.name,
    endedAtIso: relationship.declinedAt.toISOString(),
    hadProposal: relationship.proposals.length > 0,
  };
}
