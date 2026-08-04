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
 * current UI mode. IDOR-safe: every non-admin lens is gated by an ownership
 * equality against the loaded engagement; a role string alone never grants access
 * except platform admin. Client and expert lenses are mutually exclusive in
 * practice (the delivering expert's active company is never the client company).
 *
 * ⚠ THE LENS GATES *VIEW*; A CAPABILITY GATES *MUTATION*. This function answers
 * "may this viewer see this engagement, and through which lens" — it is not, and
 * must not become, the mutation gate. Every mutating server action additionally
 * resolves `hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId })`
 * (`@/lib/authz`; see `_actions/engagement-lifecycle-shared.ts`). Do not read a
 * `lens` value as authorization for a write (ADR-1029).
 *
 * ENGAGEMENT-TYPE-AGNOSTIC BY CONSTRUCTION (BAL-417). The parameter is the
 * STRUCTURAL MINIMUM — the two universal supertype scalars this gate actually
 * reads — not a concrete engagement shape. That is deliberate: the rule is already
 * correct for every engagement product, and declaring it against the Project-shaped
 * hydration graph would have made the IDOR gate structurally uncallable for a Case
 * even though nothing in its logic is project-specific. `ProjectEngagementWithMilestones`,
 * `CaseEngagementRow` and any future concrete row all satisfy it, so no overload and
 * no cast is ever needed at a call site. Widening was safe HERE only because this
 * function reads no hydrated relation — `deriveEngagementParties` and
 * `mapActionItemsToView` do, and are deliberately NOT widened.
 */
export function resolveEngagementLens(
  user: SessionUser,
  engagement: { companyId: string; expertProfileId: string }
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
