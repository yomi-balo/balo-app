'use server';

import 'server-only';

import { signInSchema, type SignInFormData } from '@/components/balo/auth/schemas';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { db, usersRepository } from '@balo/db';
import { type AuthResult, mapWorkOSError } from '@/lib/auth/errors';

interface SignInResult {
  needsOnboarding: boolean;
}

export async function signInAction(input: SignInFormData): Promise<AuthResult<SignInResult>> {
  // 1. Validate
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { email, password } = parsed.data;

  try {
    // 2. Authenticate with WorkOS (verifies password, returns tokens)
    const authResponse = await getWorkOS().userManagement.authenticateWithPassword({
      clientId,
      email,
      password,
    });

    // 3. Find Balo user by WorkOS ID — or auto-create if orphaned.
    //    An orphaned WorkOS user (exists in WorkOS but not Balo DB) can happen
    //    if the DB transaction failed during signup. We recover by creating
    //    the DB user now rather than leaving them permanently locked out.
    let user = await usersRepository.findByWorkosId(authResponse.user.id);
    if (!user) {
      const workosUser = authResponse.user;
      const result = await usersRepository.createWithWorkspace({
        workosId: workosUser.id,
        email: workosUser.email,
        firstName: workosUser.firstName,
        lastName: workosUser.lastName,
        avatarUrl: workosUser.profilePictureUrl ?? null,
        emailVerified: workosUser.emailVerified ?? false,
        activeMode: 'client',
      });
      user = result.user;
    }

    // 4. Load company membership (always exists — created at signup or recovery above)
    const userWithCompany = await usersRepository.findWithCompany(user.id);
    if (!userWithCompany?.companyMemberships?.[0]) {
      return {
        success: false,
        error: 'Account configuration error. Please contact support.',
        code: 'no_company_membership',
      };
    }

    const membership = userWithCompany.companyMemberships[0];

    // 5. Load expert profile if user is in expert mode
    let expertProfile = null;
    if (user.activeMode === 'expert') {
      expertProfile = await db.query.expertProfiles.findFirst({
        where: (profiles, { eq }) => eq(profiles.userId, user.id),
      });
    }

    // 6. Set session
    const session = await getSession();
    session.user = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      activeMode: user.activeMode,
      onboardingCompleted: user.onboardingCompleted,
      platformRole: user.platformRole,
      companyId: membership.company.id,
      companyName: membership.company.name,
      companyRole: membership.role,
      ...(expertProfile && {
        expertProfileId: expertProfile.id,
        verticalId: expertProfile.verticalId,
      }),
    };
    session.accessToken = authResponse.accessToken;
    session.refreshToken = authResponse.refreshToken;
    await session.save();

    // 7. Touch last active timestamp (fire-and-forget, don't block response)
    usersRepository.touch(user.id).catch(() => {
      // Non-critical — swallow errors
    });

    // 8. Determine onboarding status
    const needsOnboarding = user.onboardingCompleted === false;

    return {
      success: true,
      data: { needsOnboarding },
    };
  } catch (error) {
    return {
      success: false,
      error: mapWorkOSError(error),
    };
  }
}
