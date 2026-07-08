'use server';

import 'server-only';

import { partyMembershipsRepository, usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { resolveActionableCompanyForSession } from '@/lib/domain-join/resolve-actionable-company';
import { type AuthResult } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

interface JoinMatchedCompanyResult {
  redirectTo: string;
}

/**
 * BAL-346 auto-join terminal of onboarding (DORMANT in v1). Creates the
 * `domain_match` membership for the domain-matched company and completes
 * onboarding in client mode — the same shape as `nameWorkspaceAndCompleteAction`,
 * MINUS the rename.
 *
 * Takes ZERO client-supplied identifiers: the owning company is re-derived
 * server-side from `session.user.email` via `resolveActionableCompanyForSession`
 * (IDOR guard). Uses `getSession()` directly (mid-onboarding), never throws to the
 * client, and FAILS CLOSED — any write failure or mode drift returns a typed error
 * with NO navigation.
 *
 * Session company-context is intentionally NOT switched here (companyId /
 * companyName / companyRole stay on the personal workspace) — matching
 * `runDomainJoin`'s auto path, which also only creates the membership. Switching
 * the active company (and reconciling with `usersRepository.findWithCompany`'s
 * ordering) is deferred to BAL-348.
 */
export async function joinMatchedCompanyAction(): Promise<AuthResult<JoinMatchedCompanyResult>> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if (session.user.onboardingCompleted) {
    return { success: false, error: 'Onboarding already completed' };
  }

  try {
    const actionable = await resolveActionableCompanyForSession(session.user.email);
    // Fail CLOSED: no actionable company, or mode drifted to request since resolve.
    if (actionable === null || actionable.mode !== 'auto') {
      return {
        success: false,
        error: "We couldn't add you to that workspace just now. Please try again.",
      };
    }

    // Idempotent: an `already_member` outcome is treated as success (user proceeds).
    await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'company',
      partyId: actionable.partyId,
      userId: session.user.id,
      actorUserId: session.user.id,
    });

    await usersRepository.update(session.user.id, {
      activeMode: 'client',
      onboardingCompleted: true,
    });
    session.user.activeMode = 'client';
    session.user.onboardingCompleted = true;
    await session.save();

    return { success: true, data: { redirectTo: '/dashboard' } };
  } catch (error) {
    log.error('Failed to auto-join matched company', {
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      error: "We couldn't add you to that workspace just now. Please try again.",
    };
  }
}
