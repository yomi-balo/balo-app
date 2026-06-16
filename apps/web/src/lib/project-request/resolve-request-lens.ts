import type { ProjectRequestWithRelations } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

export type ProjectRequestStatus = ProjectRequestWithRelations['status'];

/** participant = client | expert (they act on the request); observer = admin (monitors). */
export type RequestArchetype = 'participant' | 'observer';
export type RequestLens = 'client' | 'expert' | 'admin';

/**
 * Statuses BEFORE experts are invited — an invited-expert lens at one of these
 * is still gated (the request isn't open to them yet).
 */
export const BEFORE_INVITE_STATUSES = [
  'draft',
  'requested',
  'exploratory_meeting_requested',
] as const;

/**
 * Statuses where the conversation becomes the page (Phase 2). `eoi_submitted`
 * is the flip point (`PHASE2_FROM`), matching the repo state machine + prototype.
 */
export const PHASE2_STATUSES = [
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'kickoff_approved',
] as const;

/** `'phase2'` once the request has reached `eoi_submitted`; otherwise `'phase1'`. */
export function requestPhase(status: ProjectRequestStatus): 'phase1' | 'phase2' {
  return (PHASE2_STATUSES as readonly string[]).includes(status) ? 'phase2' : 'phase1';
}

/**
 * The viewer's resolved relationship to a specific request. Shared primitive the
 * detail page renders from and that A2–A5 import to scope their slices.
 */
export interface RequestViewerContext {
  lens: RequestLens;
  /** participant = client|expert; observer = admin. */
  archetype: RequestArchetype;
  /** Viewer's company owns the request. */
  isOwner: boolean;
  /** Viewer's expertProfileId ∈ a live, non-declined relationship. */
  isInvitedExpert: boolean;
  /** The viewer-expert's relationship id (null for client/admin) — siblings need this. */
  relationshipId: string | null;
  /** Contact-field visibility — experts/admin see the named contact; the client doesn't. */
  canSeeContact: boolean;
}

const ADMIN_ROLES = new Set<SessionUser['platformRole']>(['admin', 'super_admin']);

type RelationshipStatus = ProjectRequestWithRelations['relationships'][number]['status'];

/**
 * Terminal-negative relationship statuses that do NOT grant the expert
 * participant access. A `declined` relationship is still "live" at the DB layer
 * (`deletedAt IS NULL` — declining only stamps `declinedAt`), but the expert is
 * no longer a participant and must not see the brief, the client's contact, or
 * (once A2 lands) the conversation. The admin observer view still lists declined
 * experts — that comes from the read/mapper, not this resolver. Extend this set
 * if `removed`/`withdrawn` relationship statuses are added later.
 */
const INACTIVE_RELATIONSHIP_STATUSES = new Set<RelationshipStatus>(['declined']);

/**
 * Resolve the viewer's lens/archetype for this request. Pure + synchronous — no
 * I/O (the page already holds the row). Returns `null` when the viewer is NOT
 * authorised to see this request → the caller calls `notFound()` (same copy as a
 * missing row, so existence never leaks).
 *
 * Precedence (deliberate):
 *  1. platform admin → **observer**, regardless of any other relationship (admins
 *     monitor, never participate — even an admin who also owns the request).
 *  2. company match (`user.companyId === request.companyId`) → **client** owner.
 *  3. expert match (`expertProfileId` present AND ∈ a live, non-declined relationship) → **expert**.
 *  4. else → `null` (unauthorised).
 *
 * `canSeeContact = lens !== 'client'` — experts on invite + admins see the named
 * contact; the client does not see their own identity surfaced as a "Contact".
 *
 * DELIBERATELY `activeMode`-AGNOSTIC: the lens is keyed on `platformRole` /
 * `companyId` / `expertProfileId` only — authorization derives from company
 * ownership, a live request↔expert relationship, or platform role, NOT the
 * viewer's current UI mode. An invited expert browsing in client mode (or vice
 * versa) still resolves to the relationship-derived lens. (A2 thread-scoping must
 * not assume `activeMode` aligns with the lens.)
 */
export function resolveRequestLens(
  user: SessionUser,
  request: ProjectRequestWithRelations
): RequestViewerContext | null {
  // 1. Admin → observer (precedence over ownership/invite).
  if (ADMIN_ROLES.has(user.platformRole)) {
    return {
      lens: 'admin',
      archetype: 'observer',
      isOwner: user.companyId === request.companyId,
      isInvitedExpert: false,
      relationshipId: null,
      canSeeContact: true,
    };
  }

  // 2. Owner company → client participant.
  if (user.companyId === request.companyId) {
    return {
      lens: 'client',
      archetype: 'participant',
      isOwner: true,
      isInvitedExpert: false,
      relationshipId: null,
      canSeeContact: false,
    };
  }

  // 3. Invited expert (live, non-declined relationship) → expert participant.
  //    A declined relationship stays live at the DB layer (deletedAt IS NULL)
  //    but no longer grants access — a dropped/declined expert must not see the
  //    brief, the client's contact, or (once A2 lands) the conversation.
  if (user.expertProfileId !== undefined) {
    const relationship = request.relationships.find(
      (r) =>
        r.expertProfileId === user.expertProfileId && !INACTIVE_RELATIONSHIP_STATUSES.has(r.status)
    );
    if (relationship !== undefined) {
      return {
        lens: 'expert',
        archetype: 'participant',
        isOwner: false,
        isInvitedExpert: true,
        relationshipId: relationship.id,
        canSeeContact: true,
      };
    }
  }

  // 4. Not a participant, owner, or admin → unauthorised.
  return null;
}

/** Why a viewer who resolves to NO lens was denied — analytics only. Extend the
 *  union as more terminal-negative relationship statuses gain signals. */
export type RequestAccessDenialReason = 'declined_relationship';

/**
 * Classify WHY `resolveRequestLens` would deny this viewer, for analytics at the
 * denial boundary. The resolver returns a bare `null` (same copy for a stranger
 * and a declined expert, so existence never leaks) — the *reason* is derived here,
 * server-side, and never surfaced to the client.
 *
 * Returns `'declined_relationship'` ONLY for a viewer who would otherwise be an
 * expert participant but whose matching relationship(s) are all terminal-negative
 * (`declined`) — a dropped/declined expert hitting the wall. Returns `null` for
 * everyone else (admins, owners, live experts, plain strangers — no event for
 * strangers). Pure + synchronous; mirrors `resolveRequestLens` precedence and
 * reuses `INACTIVE_RELATIONSHIP_STATUSES` (single source of truth — no drift).
 */
export function resolveRequestDenialReason(
  user: SessionUser,
  request: ProjectRequestWithRelations
): RequestAccessDenialReason | null {
  if (ADMIN_ROLES.has(user.platformRole)) return null; // observer, never denied
  if (user.companyId === request.companyId) return null; // owner → client lens
  if (user.expertProfileId === undefined) return null; // not an expert → stranger

  const matching = request.relationships.filter((r) => r.expertProfileId === user.expertProfileId);
  // A live (non-declined) match → they DO resolve to the expert lens → not denied.
  if (matching.some((r) => !INACTIVE_RELATIONSHIP_STATUSES.has(r.status))) return null;
  // At least one matching relationship, all terminal-negative → the declined wall.
  return matching.length > 0 ? 'declined_relationship' : null;
}
