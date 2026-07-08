'use server';

import 'server-only';

import { companiesRepository, usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { companyNameSchema } from '@/lib/auth/company-name-schema';
import { type AuthResult } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

interface NameWorkspaceResult {
  redirectTo: string;
}

/**
 * BAL-350 CLIENT terminal of onboarding. Validates + renames the already-created
 * personal workspace, marks onboarding complete in client mode, and refreshes the
 * session's cached company name. A NEW dedicated action (not an extension of
 * `completeOnboardingAction`) so the untouched expert terminal stays byte-for-byte
 * identical.
 *
 * Uses `getSession()` (not `requireUser()`, which throws on a MISSING user) so an
 * unauthenticated call returns a typed `AuthResult` error instead of throwing. The
 * caller (company step) also validates the name client-side; this re-validates
 * server-side. Never throws to the client — always returns the `AuthResult` shape.
 */
export async function nameWorkspaceAndCompleteAction(
  companyName: string
): Promise<AuthResult<NameWorkspaceResult>> {
  const parsed = companyNameSchema.safeParse({ companyName });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Enter a name for your workspace',
    };
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if (session.user.onboardingCompleted) {
    return { success: false, error: 'Onboarding already completed' };
  }
  // Least-privilege: only the workspace OWNER may rename the company. At onboarding
  // this always holds (the personal workspace was created with the user as owner and
  // `companyId` is server-derived, never client input), so this is defense-in-depth
  // — forward-safe for when the shared-org creation seam (BAL-345/346) makes
  // non-owner memberships reachable here.
  if (session.user.companyRole !== 'owner') {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    const renamed = await companiesRepository.updateName(
      session.user.companyId,
      parsed.data.companyName
    );
    await usersRepository.update(session.user.id, {
      activeMode: 'client',
      onboardingCompleted: true,
    });

    session.user.activeMode = 'client';
    session.user.onboardingCompleted = true;
    session.user.companyName = renamed.name; // keep the session's cached name fresh
    await session.save();

    return { success: true, data: { redirectTo: '/dashboard' } };
  } catch (error) {
    log.error('Failed to name workspace and complete onboarding', {
      userId: session.user.id,
      companyId: session.user.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: "We couldn't save that just now. Please try again." };
  }
}
