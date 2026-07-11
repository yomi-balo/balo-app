'use server';

import 'server-only';

import { signInSchema, type SignInFormData } from '@/components/balo/auth/schemas';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { db, usersRepository, type User } from '@balo/db';
import { type AuthResult, mapWorkOSError, AccountExistsError } from '@/lib/auth/errors';
import { resolveLinkedUser, ACCOUNT_EXISTS_MESSAGE } from '@/lib/auth/resolve-identity';
import { log } from '@/lib/logging';
import { emitDomainCapture } from '@/lib/analytics/party-domains';
import { trackServerAndFlush, AUTH_SERVER_EVENTS } from '@/lib/analytics/server';
import { runDomainJoinAndEmit } from '@/lib/domain-join/run-domain-join';

interface SignInResult {
  needsOnboarding: boolean;
  userId: string;
  email: string;
  activeMode: 'client' | 'expert';
  platformRole: 'user' | 'admin' | 'super_admin';
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

    // 3. Resolve the WorkOS identity to a LIVE Balo user — or auto-create if orphaned.
    //    BAL-362: the shared resolver returns a findByWorkosId hit, a safe re-link
    //    onto a live verified-email row (workosId churned in WorkOS), or null. It
    //    throws AccountExistsError when a live email is owned under a different
    //    identity and either side is unverified (handled in the catch below).
    //    An orphaned WorkOS user (exists in WorkOS but not Balo DB) can happen if
    //    the DB transaction failed during signup — the null branch recovers by
    //    creating the DB user now rather than leaving them permanently locked out.
    const resolved = await resolveLinkedUser(authResponse.user);
    let user: User;
    let didRelink = false;
    if (resolved) {
      user = resolved.user;
      didRelink = resolved.didRelink;
    } else {
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
      // BAL-344: emit the domain auto-capture outcome (post-commit). Usually
      // not_applicable unless WorkOS reports the orphaned user's email verified.
      emitDomainCapture(result.domainCapture, user.id);

      // BAL-345: run the domain auto-join match engine (post-commit). Pass the
      // SAME WorkOS emailVerified flag createWithWorkspace received — never
      // hardcode true; the engine's verified hard-gate stands down when false. The
      // `.catch` is belt-and-suspenders so a domain-join failure can NEVER break auth.
      await runDomainJoinAndEmit({
        userId: user.id,
        email: user.email,
        emailVerified: workosUser.emailVerified === true,
      }).catch(() => {
        // runDomainJoinAndEmit already logs internally.
      });
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
      avatarUrl: user.avatarUrl ?? null,
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

    // BAL-362: a returning user whose workosId was re-linked onto their live
    // verified-email row (post-commit — the re-link tx already committed).
    if (didRelink) {
      trackServerAndFlush(AUTH_SERVER_EVENTS.AUTH_RELINK, {
        distinct_id: user.id,
        method: 'password',
      });
    }

    // 7. Touch last active timestamp (fire-and-forget, don't block response)
    usersRepository.touch(user.id).catch((err) => {
      log.warn('Failed to update last active timestamp', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // 8. Determine onboarding status
    const needsOnboarding = user.onboardingCompleted === false;

    return {
      success: true,
      data: {
        needsOnboarding,
        userId: user.id,
        email: user.email,
        activeMode: user.activeMode,
        platformRole: user.platformRole,
      },
    };
  } catch (error) {
    // BAL-362: a live Balo user owns this email under a different identity and a
    // re-link was refused (either side unverified) — surface a clean conflict, not
    // a 500. `distinct_id` is the internal user id only (never the email/PII).
    if (error instanceof AccountExistsError) {
      trackServerAndFlush(AUTH_SERVER_EVENTS.AUTH_CONFLICT, {
        distinct_id: error.existingUserId,
        method: 'password',
      });
      log.warn('Sign-in: email owned by a different identity — conflict', {
        existingUserId: error.existingUserId,
      });
      return { success: false, error: ACCOUNT_EXISTS_MESSAGE, code: 'account_exists' };
    }
    log.error('Sign-in failed', {
      email,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      error: mapWorkOSError(error),
    };
  }
}
