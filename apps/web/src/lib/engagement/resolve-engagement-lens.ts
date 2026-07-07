import type { EngagementWithMilestones } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

/** participant = client | expert (they act on the engagement); observer = admin (monitors). */
export type EngagementArchetype = 'participant' | 'observer';
export type EngagementLens = 'client' | 'expert' | 'admin';

/**
 * The viewer's resolved relationship to a specific engagement. Shared primitive
 * the delivery workspace renders from — every component consumes the derived
 * `EngagementWorkspaceView`, but the page + view mapper key off this context.
 */
export interface EngagementViewerContext {
  lens: EngagementLens;
  /** participant = client|expert; observer = admin. */
  archetype: EngagementArchetype;
  /** Viewer's active company owns the engagement (companyId equality). */
  isClientOwner: boolean;
  /** Viewer's expertProfileId is the delivering expert (expertProfileId equality). */
  isDeliveringExpert: boolean;
}

const ADMIN_ROLES = new Set<SessionUser['platformRole']>(['admin', 'super_admin']);

/**
 * Resolve the viewer's lens/archetype for this engagement. PURE + SYNCHRONOUS —
 * no I/O (the page already holds the loaded, `deletedAt IS NULL` row and calls
 * `notFound()` on a `null` return, so a stranger sees the same 404 as a missing
 * row — existence never leaks).
 *
 * Precedence (deliberate — mirrors `resolveRequestLens`):
 *  1. platform admin → **observer**, regardless of any other relationship (admins
 *     monitor, never participate — even an admin who also owns / delivers it). The
 *     `isClientOwner` / `isDeliveringExpert` flags still record the incidental
 *     overlap for the view without changing the lens.
 *  2. company match (`user.companyId === engagement.companyId`) → **client** owner.
 *  3. expert match (`expertProfileId` present AND === `engagement.expertProfileId`)
 *     → **expert** (the delivering expert).
 *  4. else → `null` (unauthorised).
 *
 * DELIBERATELY `activeMode`-AGNOSTIC: the lens keys on `platformRole` /
 * `companyId` / `expertProfileId` only — authorization derives from company
 * ownership, being the delivering expert, or platform role, NOT the viewer's
 * current UI mode. There is no `hasCapability()` yet (BAL-314) — `companyId`
 * equality IS the membership test today (`SessionUser` carries one active
 * company). IDOR-safe: every non-admin lens is gated by an ownership equality
 * against the loaded engagement; a role string alone never grants access except
 * platform admin. Client and expert lenses are mutually exclusive in practice (the
 * delivering expert's active company is never the client company).
 */
export function resolveEngagementLens(
  user: SessionUser,
  engagement: EngagementWithMilestones
): EngagementViewerContext | null {
  // 1. Admin → observer (precedence over ownership / delivery).
  if (ADMIN_ROLES.has(user.platformRole)) {
    return {
      lens: 'admin',
      archetype: 'observer',
      isClientOwner: user.companyId === engagement.companyId,
      isDeliveringExpert:
        user.expertProfileId !== undefined && user.expertProfileId === engagement.expertProfileId,
    };
  }

  // 2. Owner company → client participant.
  if (user.companyId === engagement.companyId) {
    return {
      lens: 'client',
      archetype: 'participant',
      isClientOwner: true,
      isDeliveringExpert: false,
    };
  }

  // 3. Delivering expert → expert participant.
  if (user.expertProfileId !== undefined && user.expertProfileId === engagement.expertProfileId) {
    return {
      lens: 'expert',
      archetype: 'participant',
      isClientOwner: false,
      isDeliveringExpert: true,
    };
  }

  // 4. Not owner, delivering expert, or admin → unauthorised.
  return null;
}
