'use server';

import 'server-only';

import { after } from 'next/server';
import { unifiedSignUpSchema, type UnifiedSignUpFormData } from '@/components/balo/auth/schemas';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { type AuthResult, mapWorkOSError } from '@/lib/auth/errors';
import { log, errorMessage } from '@/lib/logging';

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

/** Serialize an unknown error into structured log fields. */
function serializeError(error: unknown): { error: string; stack: string | undefined } {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
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
      ...serializeError(error),
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
      avatarUrl: null,
      activeMode: user.activeMode,
      onboardingCompleted: false,
      platformRole: 'user',
      // BAL-560 — NO `platformCapabilities`. A row minted here is `platform_role: 'user'`, and
      // the `users_platform_capabilities_staff_array` CHECK forbids a non-staff row from
      // carrying an override at all (D1). There is nothing to seal, and the resolver would
      // ignore it if there were.
      companyId: company.id,
      companyName: company.name,
      companyRole: membership.role,
    };
    session.accessToken = authResponse.accessToken;
    session.refreshToken = authResponse.refreshToken;
    await session.save();

    // BAL-345 + BAL-489 — two post-commit new-user helpers, dynamically imported (like
    // @balo/db above) so they stay out of the primary bundle; this fallback path runs only
    // when WorkOS email-verification is disabled. Pass the SAME real WorkOS emailVerified
    // flag createWithWorkspace received, never true. Each helper is CHAINED off its own
    // dynamic import, so a rejected import (a failed chunk load, which never reaches the
    // helper's own logger) is caught and warned, not just a rejected call: by this point
    // the Balo user and session already exist, and neither helper may fail signup (R10).
    // Domain-join is AWAITED; guest-conversion is scheduled with `after()`, so it runs
    // after the response and can neither fail nor delay signup.
    const newUserIdentity = {
      userId: user.id,
      email: user.email,
      emailVerified: workosUser.emailVerified === true,
    };
    await import('@/lib/domain-join/run-domain-join')
      .then(({ runDomainJoinAndEmit }) => runDomainJoinAndEmit(newUserIdentity))
      .catch((error: unknown) => {
        log.warn('Domain join failed after sign-up (auth unaffected)', {
          userId: newUserIdentity.userId,
          error: errorMessage(error),
        });
      });
    after(() =>
      import('@/lib/guest-conversion/run-guest-conversion')
        .then(({ runGuestConversionAndEmit }) => runGuestConversionAndEmit(newUserIdentity))
        .catch((error: unknown) => {
          log.warn('Guest conversion rejected after sign-up (auth unaffected)', {
            userId: newUserIdentity.userId,
            error: errorMessage(error),
          });
        })
    );

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
      ...serializeError(error),
    });
    return { success: false, error: mapWorkOSError(error) };
  }
}
