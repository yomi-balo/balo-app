'use server';

import 'server-only';

import { unifiedSignUpSchema, type UnifiedSignUpFormData } from '@/components/balo/auth/schemas';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { type AuthResult, mapWorkOSError } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

interface SignUpResult {
  pendingAuthToken?: string;
  email: string;
  /** True when verification is not required and auth completed immediately */
  verified?: boolean;
  // These fields are only present when verified is true (fallback path)
  userId?: string;
  activeMode?: 'client' | 'expert';
  platformRole?: 'user' | 'admin' | 'super_admin';
  needsOnboarding?: boolean;
}

export async function signUpAction(
  input: UnifiedSignUpFormData
): Promise<AuthResult<SignUpResult>> {
  // 1. Validate
  const parsed = unifiedSignUpSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const { email, password } = parsed.data;

  let workosUser;

  try {
    // 2. Create user in WorkOS (no firstName/lastName -- collected in onboarding)
    workosUser = await getWorkOS().userManagement.createUser({
      email,
      password,
    });
  } catch (error) {
    log.error('WorkOS user creation failed', {
      email,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: mapWorkOSError(error) };
  }

  try {
    // 3. Authenticate to check if email verification is required.
    //    WorkOS may either:
    //    (a) Return a pendingAuthenticationToken in the response object
    //    (b) Throw an error with code 'email_verification_required' containing the token
    //    (c) Return full auth tokens if verification is not enabled
    const authResponse = await getWorkOS().userManagement.authenticateWithPassword({
      clientId,
      email,
      password,
    });

    // Check for pending authentication token in the response
    if ('pendingAuthenticationToken' in authResponse && authResponse.pendingAuthenticationToken) {
      log.info('Email verification required for new signup', { email });
      return {
        success: true,
        data: {
          pendingAuthToken: authResponse.pendingAuthenticationToken as string,
          email,
        },
      };
    }

    // FALLBACK: No verification required -- create DB user + session immediately.
    // This path executes when email verification is not enabled in WorkOS.
    // Dynamic imports: the primary path (email verification) doesn't need DB/session,
    // so we lazy-load them here to keep the main bundle lighter.
    const { usersRepository } = await import('@balo/db');
    const { getSession } = await import('@/lib/auth/session');

    const { user, company, membership } = await usersRepository.createWithWorkspace({
      workosId: workosUser.id,
      email: workosUser.email,
      firstName: null,
      lastName: null,
      emailVerified: workosUser.emailVerified ?? false,
      activeMode: 'client',
    });

    const session = await getSession();
    session.user = {
      id: user.id,
      email: user.email,
      firstName: null,
      lastName: null,
      activeMode: user.activeMode,
      onboardingCompleted: false,
      platformRole: 'user',
      companyId: company.id,
      companyName: company.name,
      companyRole: membership.role,
    };
    session.accessToken = authResponse.accessToken;
    session.refreshToken = authResponse.refreshToken;
    await session.save();

    return {
      success: true,
      data: {
        verified: true,
        email,
        userId: user.id,
        activeMode: user.activeMode,
        platformRole: 'user',
        needsOnboarding: true,
      },
    };
  } catch (error: unknown) {
    // Check if this is the email_verification_required error (path b)
    const errObj = error as Error & {
      code?: string;
      rawData?: { code?: string; pending_authentication_token?: string };
    };
    const code = errObj.code ?? errObj.rawData?.code;

    if (code === 'email_verification_required') {
      const pendingToken = errObj.rawData?.pending_authentication_token;
      if (pendingToken) {
        log.info('Email verification required for new signup', { email });
        return {
          success: true,
          data: { pendingAuthToken: pendingToken, email },
        };
      }
    }

    // Non-verification error -- clean up orphaned WorkOS user
    try {
      await getWorkOS().userManagement.deleteUser(workosUser.id);
    } catch {
      // Best-effort cleanup
    }

    log.error('Sign-up failed', {
      email,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: mapWorkOSError(error) };
  }
}
