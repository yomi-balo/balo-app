import 'server-only';

import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { navWorkspaceTypeOf, readCompanyForRequest } from '@/lib/navigation/nav-context';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-503 — resolves the client Settings layout's chrome for one already-authenticated request.
 * Both fields are a UX AFFORDANCE only, never the authorization decision — every gated section
 * keeps its own server-side gate untouched (`settings/team/page.tsx`'s `hasCapability` +
 * `isPersonal` → `notFound()`).
 */
export interface SettingsChrome {
  /** Nav SCOPING (ADR-1053), never authorization: true iff the actor's workspace is a company. */
  readonly showSectionNav: boolean;
  /** UX AFFORDANCE ONLY. `settings/team/page.tsx` remains the authorization boundary. */
  readonly showTeamSection: boolean;
}

/**
 * Resolve `user`'s Settings chrome.
 *
 * `showSectionNav` comes from `navWorkspaceTypeOf` — the ONE place `activeMode` is inverted into a
 * workspace type (exported from `nav-context.ts` so the projection keeps a single home). Never
 * gates on `activeMode` directly. It is PURE and costs no read, which is what lets the expert
 * branch below return before touching the database at all.
 *
 * `showTeamSection` is a LIVE read — `hasCapability(user, MANAGE_MEMBERS, { companyId })` AND
 * `company.isPersonal === false` — the SAME two conditions `settings/team/page.tsx` itself
 * enforces. Deliberately NOT `NavContext.capabilities`: that set is stale by construction
 * (derived from the 7-day session cookie), and `nav-registry.ts:64` names this ticket explicitly
 * as the one that must not gate an action on it.
 *
 * On a repo failure, this fails CLOSED on the affordance only (`showTeamSection: false`) —
 * never on the whole chrome, since `showSectionNav` costs no additional read.
 */
export async function resolveSettingsChrome(user: SessionUser): Promise<SettingsChrome> {
  const showSectionNav = navWorkspaceTypeOf(user) === 'company';

  // ⚠ An expert workspace never renders the tab bar, so `showTeamSection` is unreachable there —
  // and `team` is now EXPERT-scoped, so `/settings/team` is precisely where expert traffic lands.
  // Returning here keeps that path at ZERO database round trips.
  if (!showSectionNav) {
    return { showSectionNav, showTeamSection: false };
  }

  try {
    const [allowed, company] = await Promise.all([
      hasCapability(user, CAPABILITIES.MANAGE_MEMBERS, { companyId: user.companyId }),
      readCompanyForRequest(user.companyId),
    ]);
    const showTeamSection = allowed && company !== undefined && !company.isPersonal;
    return { showSectionNav, showTeamSection };
  } catch (error) {
    log.error('Failed to resolve settings chrome', {
      userId: user.id,
      companyId: user.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { showSectionNav, showTeamSection: false };
  }
}
