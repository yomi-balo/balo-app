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
  /** Viewer's expertProfileId ∈ live relationships. */
  isInvitedExpert: boolean;
  /** The viewer-expert's relationship id (null for client/admin) — siblings need this. */
  relationshipId: string | null;
  /** Contact-field visibility — experts/admin see the named contact; the client doesn't. */
  canSeeContact: boolean;
}

const ADMIN_ROLES = new Set<SessionUser['platformRole']>(['admin', 'super_admin']);

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
 *  3. expert match (`expertProfileId` present AND ∈ a LIVE relationship) → **expert**.
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

  // 3. Invited expert (live relationship only) → expert participant.
  if (user.expertProfileId !== undefined) {
    const relationship = request.relationships.find(
      (r) => r.expertProfileId === user.expertProfileId
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
