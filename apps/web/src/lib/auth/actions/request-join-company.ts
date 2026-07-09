'use server';

import 'server-only';

import { partyJoinRequestsRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { resolveActionableCompanyForSession } from '@/lib/domain-join/resolve-actionable-company';
import { type AuthResult } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

interface RequestJoinCompanyResult {
  status: 'pending';
}

/**
 * BAL-346 request-to-join terminal of onboarding (DORMANT in v1). Files a pending
 * `party_join_request` for the domain-matched company and leaves the user waiting
 * — it does NOT complete onboarding (the user finishes only via an escape hatch on
 * the pending screen).
 *
 * Takes ZERO client-supplied identifiers: the owning company is re-derived
 * server-side from `session.user.email` via `resolveActionableCompanyForSession`
 * (IDOR guard). Uses `getSession()` directly (mid-onboarding), never throws to the
 * client, and FAILS CLOSED — any write failure or mode mismatch returns a typed
 * error with NO navigation ("Nothing was changed").
 */
export async function requestJoinCompanyAction(): Promise<AuthResult<RequestJoinCompanyResult>> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if (session.user.onboardingCompleted) {
    return { success: false, error: 'Onboarding already completed' };
  }

  try {
    const actionable = await resolveActionableCompanyForSession(
      session.user.id,
      session.user.email
    );
    // Fail CLOSED: no actionable company, or mode is not request.
    if (actionable === null || actionable.mode !== 'request') {
      return {
        success: false,
        error: "We couldn't send your request just now. Nothing was changed — please try again.",
      };
    }

    // Idempotent: an `already_pending` outcome is treated as success.
    await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: actionable.partyId,
      userId: session.user.id,
    });

    // Do NOT complete onboarding here — the user is still waiting. Onboarding
    // completes only via an escape hatch on the pending screen.
    return { success: true, data: { status: 'pending' } };
  } catch (error) {
    log.error('Failed to file company join request', {
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      error: "We couldn't send your request just now. Nothing was changed — please try again.",
    };
  }
}
