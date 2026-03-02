'use server';

import 'server-only';

import { getSession } from '@/lib/auth/session';
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
  const parsed = intentSchema.safeParse(intent);
  if (!parsed.success) {
    return { success: false, error: 'Invalid selection' };
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
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
