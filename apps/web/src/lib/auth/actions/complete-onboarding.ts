'use server';

import 'server-only';

import { getSession } from '@/lib/auth/session';
import { accountRefusalFor } from '@/lib/auth/account-liveness';
import { usersRepository } from '@balo/db';
import { type AuthResult } from '@/lib/auth/errors';
import { z } from 'zod';

const intentSchema = z.enum(['client', 'expert']);

interface CompleteOnboardingResult {
  redirectTo: string;
}

export async function completeOnboardingAction(
  intent: 'client' | 'expert'
): Promise<AuthResult<CompleteOnboardingResult>> {
  // BAL-568 (ruling 2026-09-18) — ACCOUNT LIVENESS, against the LIVE row. This module is one of
  // the bounded set that resolves its actor with `getSession()` alone (the `workos-auth` skill
  // blesses exactly the onboarding-wizard actions for that), so there is no chokepoint to fold
  // into and the gate is explicit here.
  //
  // ⚠⚠ IT SITS **ABOVE THE PARSE**, AND THAT ORDERING IS R9, NOT TIDINESS (fix round 1, F4). The
  // first cut of BAL-568 placed it after `safeParse`, which lets a refused caller learn from the
  // shape of the error whether their input was well-formed. The chokepoint seams get this ordering
  // for free because they were never edited; a hand-gated module like this one has to be
  // deliberate about it.
  //
  // ⚠ `accountRefusalFor` rather than `assertAccountLive`: this action's contract is to RETURN a
  // typed result, and a throw would be swallowed by the `try` below and degrade into generic retry
  // copy — the exact failure mode the plan's no-redirect reasoning describes.
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if ((await accountRefusalFor(session.user.id, { path: 'action', emit: true })) !== null) {
    return { success: false, error: 'Unauthorized' };
  }

  const parsed = intentSchema.safeParse(intent);
  if (!parsed.success) {
    return { success: false, error: 'Invalid selection' };
  }

  if (session.user.onboardingCompleted) {
    return { success: false, error: 'Onboarding already completed' };
  }

  try {
    // Both paths start in client mode. Expert applicants remain clients
    // until their expert profile is approved (derived from expert_profiles.approvedAt).
    await usersRepository.update(session.user.id, {
      activeMode: 'client',
      onboardingCompleted: true,
    });

    session.user.activeMode = 'client';
    session.user.onboardingCompleted = true;
    await session.save();

    const redirectTo = parsed.data === 'client' ? '/dashboard' : '/expert/apply';
    return { success: true, data: { redirectTo } };
  } catch {
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
