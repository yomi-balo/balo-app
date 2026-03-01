'use server';

import 'server-only';

import { signUpSchema, type SignUpFormData } from '@/components/balo/auth/schemas';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { usersRepository } from '@balo/db';
import { type AuthResult, mapWorkOSError } from '@/lib/auth/errors';

interface SignUpResult {
  needsOnboarding: boolean;
}

export async function signUpAction(input: SignUpFormData): Promise<AuthResult<SignUpResult>> {
  // 1. Validate input (defense-in-depth — form already validates client-side)
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { email, password, firstName, lastName } = parsed.data;

  let workosUser;

  try {
    // 2. Create user in WorkOS
    workosUser = await getWorkOS().userManagement.createUser({
      email,
      password,
      firstName,
      lastName,
    });
  } catch (error) {
    return {
      success: false,
      error: mapWorkOSError(error),
    };
  }

  try {
    // 3. Immediately authenticate to get session tokens
    //    This avoids requiring the user to log in after signup.
    const authResponse = await getWorkOS().userManagement.authenticateWithPassword({
      clientId,
      email,
      password,
    });

    // 4. Create Balo user + personal workspace in a single transaction
    const { user, company, membership } = await usersRepository.createWithWorkspace({
      workosId: workosUser.id,
      email: workosUser.email,
      firstName: workosUser.firstName,
      lastName: workosUser.lastName,
      emailVerified: workosUser.emailVerified ?? false,
      activeMode: 'client',
    });

    // 5. Set session cookie via iron-session
    const session = await getSession();
    session.user = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      activeMode: user.activeMode,
      onboardingCompleted: false,
      companyId: company.id,
      companyName: company.name,
      companyRole: membership.role,
    };
    session.accessToken = authResponse.accessToken;
    session.refreshToken = authResponse.refreshToken;
    await session.save();

    return {
      success: true,
      data: { needsOnboarding: true },
    };
  } catch (error) {
    // Clean up orphaned WorkOS user to prevent permanent lockout.
    // If this fails, the user can retry signup and the createUser call
    // will detect the existing WorkOS user via email_already_exists.
    try {
      await getWorkOS().userManagement.deleteUser(workosUser.id);
    } catch {
      // Best-effort cleanup — log but don't block the error response
    }

    return {
      success: false,
      error: mapWorkOSError(error),
    };
  }
}
