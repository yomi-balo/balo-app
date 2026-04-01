'use server';

import 'server-only';

import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { usersRepository } from '@balo/db';
import { type AuthResult, mapWorkOSError } from '@/lib/auth/errors';
import { verifyEmailSchema, type VerifyEmailFormData } from '@/components/balo/auth/schemas';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

export type VerifyEmailInput = VerifyEmailFormData;

interface VerifyEmailResult {
  needsOnboarding: boolean;
  userId: string;
  email: string;
  activeMode: 'client' | 'expert';
  platformRole: 'user' | 'admin' | 'super_admin';
}

export async function verifyEmailAction(
  input: VerifyEmailInput
): Promise<AuthResult<VerifyEmailResult>> {
  // 1. Validate
  const parsed = verifyEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const { pendingAuthToken, code } = parsed.data;

  try {
    // 2. Complete email verification with WorkOS.
    //    Exchanges the pending token + OTP code for real auth tokens.
    const authResponse = await getWorkOS().userManagement.authenticateWithEmailVerification({
      clientId,
      pendingAuthenticationToken: pendingAuthToken,
      code,
    });

    const workosUser = authResponse.user;

    // 3. Check if user already exists (handles double-submit / retry race conditions)
    let existingUser = await usersRepository.findByWorkosId(workosUser.id);
    let isNewUser = false;

    if (!existingUser) {
      // Create Balo user + personal workspace in a single transaction.
      // Name is null -- will be collected in onboarding for email sign-ups.
      const created = await usersRepository.createWithWorkspace({
        workosId: workosUser.id,
        email: workosUser.email,
        firstName: workosUser.firstName ?? null,
        lastName: workosUser.lastName ?? null,
        emailVerified: true,
        activeMode: 'client',
      });
      existingUser = created.user;
      isNewUser = true;
    }

    // 4. Load company membership (always exists — created at signup or recovery above)
    const userWithCompany = await usersRepository.findWithCompany(existingUser.id);
    if (!userWithCompany?.companyMemberships?.[0]) {
      return { success: false, error: 'Account setup incomplete. Please try signing in.' };
    }

    const user = existingUser;
    const membership = userWithCompany.companyMemberships[0];

    // 5. Set session cookie
    const session = await getSession();
    session.user = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl ?? null,
      activeMode: user.activeMode,
      onboardingCompleted: false,
      platformRole: 'user',
      companyId: membership.company.id,
      companyName: membership.company.name,
      companyRole: membership.role,
    };
    session.accessToken = authResponse.accessToken;
    session.refreshToken = authResponse.refreshToken;
    await session.save();

    if (isNewUser) {
      // role is always 'client' — experts sign up as clients first,
      // then apply separately (see expert.application_submitted event).
      // The 'expert' variant of WelcomeEmail is reserved for a future
      // expert-specific signup flow.
      publishNotificationEvent('user.welcome', {
        correlationId: user.id,
        userId: user.id,
        role: 'client',
      }).catch(() => {
        // publishNotificationEvent logs internally
      });
    }

    log.info('Email verification completed, user created', {
      userId: user.id,
      email: user.email,
    });

    return {
      success: true,
      data: {
        needsOnboarding: true,
        userId: user.id,
        email: user.email,
        activeMode: user.activeMode,
        platformRole: 'user',
      },
    };
  } catch (error) {
    log.error('Email verification failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: mapWorkOSError(error) };
  }
}
