import { NextRequest, NextResponse } from 'next/server';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { mapWorkosAuthMethod } from '@/lib/auth/auth-method';
import { db, usersRepository, type DomainCaptureResult } from '@balo/db';
import { isValidReturnTo } from '@/lib/auth/validation';
import { AccountExistsError } from '@/lib/auth/errors';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { emitDomainCapture } from '@/lib/analytics/party-domains';
import { trackServerAndFlush, AUTH_SERVER_EVENTS } from '@/lib/analytics/server';
import { runDomainJoinAndEmit } from '@/lib/domain-join/run-domain-join';

export const dynamic = 'force-dynamic';

interface ResolvedUser {
  user: Awaited<ReturnType<typeof usersRepository.findByWorkosId>> & { id: string };
  companyId: string;
  companyName: string;
  companyRole: 'owner' | 'admin' | 'member';
  isNewUser: boolean;
  // BAL-344: set only in the create branch; emitted post-commit for new users.
  domainCapture?: DomainCaptureResult;
  // BAL-360: true when a workosId miss re-linked onto a live verified-email user.
  didRelink?: boolean;
}

async function resolveOrCreateUser(workosUser: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
  emailVerified: boolean;
}): Promise<ResolvedUser> {
  let existing = await usersRepository.findByWorkosId(workosUser.id);
  let didRelink = false;

  if (!existing) {
    // BAL-360: workosId miss. Before creating, look for a LIVE user with this email.
    const emailMatch = await usersRepository.findByEmail(workosUser.email);
    if (emailMatch) {
      // A live Balo user owns this email under a DIFFERENT workosId. Re-link ONLY if
      // WorkOS asserts the email is verified (account-takeover guard). WorkOS only
      // returns verified profiles when verification is required, but assert it here
      // explicitly — never assume/loosen.
      if (workosUser.emailVerified !== true) {
        throw new AccountExistsError(emailMatch.id);
      }
      existing = await usersRepository.relinkWorkosId(emailMatch.id, workosUser.id, {
        actorUserId: emailMatch.id,
        oldWorkosId: emailMatch.workosId,
        email: workosUser.email,
        emailVerified: workosUser.emailVerified,
      });
      didRelink = true;
    }
  }

  if (!existing) {
    // No live workosId AND no live email → genuine new user (create path unchanged).
    const result = await usersRepository.createWithWorkspace({
      workosId: workosUser.id,
      email: workosUser.email,
      firstName: workosUser.firstName,
      lastName: workosUser.lastName,
      avatarUrl: workosUser.profilePictureUrl ?? null,
      emailVerified: workosUser.emailVerified ?? false,
      activeMode: 'client',
    });

    return {
      user: result.user,
      companyId: result.company.id,
      companyName: result.company.name,
      companyRole: result.membership.role,
      isNewUser: true,
      domainCapture: result.domainCapture,
    };
  }

  // Shared returning-user tail (covers findByWorkosId hits AND re-linked users).
  // Sync profile data from OAuth provider on every login.
  // Only use OAuth avatar if user hasn't uploaded a custom one (R2 key).
  // R2 keys don't start with 'http', so preserve them.
  const shouldUpdateAvatar = !existing.avatarUrl || existing.avatarUrl.startsWith('http');
  const updatedUser = await usersRepository.update(existing.id, {
    avatarUrl: shouldUpdateAvatar
      ? (workosUser.profilePictureUrl ?? existing.avatarUrl)
      : existing.avatarUrl,
    emailVerified: workosUser.emailVerified || existing.emailVerified,
  });

  const userWithCompany = await usersRepository.findWithCompany(updatedUser.id);

  if (!userWithCompany?.companyMemberships?.[0]) {
    throw new Error('User has no company membership');
  }

  const membership = userWithCompany.companyMemberships[0];

  return {
    user: updatedUser,
    companyId: membership.company.id,
    companyName: membership.company.name,
    companyRole: membership.role,
    isNewUser: false,
    didRelink,
  };
}

async function createSession(
  resolved: ResolvedUser,
  accessToken: string,
  refreshToken: string,
  authenticationMethod?: string
): Promise<void> {
  const expertProfile = await db.query.expertProfiles.findFirst({
    where: (profiles, { eq }) => eq(profiles.userId, resolved.user.id),
  });

  const session = await getSession();
  const sessionUser: SessionUser = {
    id: resolved.user.id,
    email: resolved.user.email,
    firstName: resolved.user.firstName,
    lastName: resolved.user.lastName,
    avatarUrl: resolved.user.avatarUrl ?? null,
    activeMode: resolved.user.activeMode,
    onboardingCompleted: resolved.user.onboardingCompleted,
    platformRole: resolved.user.platformRole,
    // BAL-350: coarse auth method from the WorkOS OAuth response, for onboarding
    // analytics. Undefined for non-OAuth / unknown providers (never mislabelled).
    authMethod: mapWorkosAuthMethod(authenticationMethod),
    companyId: resolved.companyId,
    companyName: resolved.companyName,
    companyRole: resolved.companyRole,
    ...(expertProfile && {
      expertProfileId: expertProfile.id,
      verticalId: expertProfile.verticalId,
    }),
  };

  session.user = sessionUser;
  session.accessToken = accessToken;
  session.refreshToken = refreshToken;
  await session.save();
}

function determineRedirectUrl(resolved: ResolvedUser, req: NextRequest): string {
  const needsOnboarding = resolved.isNewUser || resolved.user.onboardingCompleted === false;

  if (needsOnboarding) {
    return '/onboarding';
  }

  const returnTo = req.cookies.get('auth_return_to')?.value;
  if (returnTo && isValidReturnTo(returnTo)) {
    return returnTo;
  }

  return resolved.user.activeMode === 'expert' ? '/expert/dashboard' : '/dashboard';
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=no_code', req.url));
  }

  try {
    const {
      user: workosUser,
      accessToken,
      refreshToken,
      authenticationMethod,
    } = await getWorkOS().userManagement.authenticateWithCode({ code, clientId });

    const resolved = await resolveOrCreateUser(workosUser);
    await createSession(resolved, accessToken, refreshToken, authenticationMethod);

    // BAL-360: a returning user whose workosId was re-linked onto their live
    // verified-email row (post-commit — the re-link tx already committed).
    if (resolved.didRelink) {
      trackServerAndFlush(AUTH_SERVER_EVENTS.OAUTH_CALLBACK_RELINK, {
        distinct_id: resolved.user.id,
      });
    }

    if (resolved.isNewUser) {
      // role is always 'client' — experts sign up as clients first,
      // then apply separately (see expert.application_submitted event).
      // The 'expert' variant of WelcomeEmail is reserved for a future
      // expert-specific signup flow.
      publishNotificationEvent('user.welcome', {
        correlationId: resolved.user.id,
        userId: resolved.user.id,
        role: 'client',
      }).catch(() => {
        // publishNotificationEvent already logs internally
      });

      // BAL-344: emit the domain auto-capture outcome (post-commit — the create
      // tx has already committed inside createWithWorkspace).
      if (resolved.domainCapture) {
        emitDomainCapture(resolved.domainCapture, resolved.user.id);
      }

      // BAL-345: run the domain auto-join match engine (post-commit). OAuth may
      // return an UNVERIFIED email — pass the real WorkOS flag, never assume true.
      // The engine's verified hard-gate stands down when it is false. The `.catch`
      // is belt-and-suspenders so a domain-join failure can NEVER break auth.
      await runDomainJoinAndEmit({
        userId: resolved.user.id,
        email: resolved.user.email,
        emailVerified: workosUser.emailVerified === true,
      }).catch(() => {
        // runDomainJoinAndEmit already logs internally.
      });
    }

    log.info('OAuth callback succeeded', {
      userId: resolved.user.id,
      isNewUser: resolved.isNewUser,
      provider: workosUser.id, // WorkOS user ID identifies the provider flow
    });

    const redirectUrl = determineRedirectUrl(resolved, req);
    const response = NextResponse.redirect(new URL(redirectUrl, req.url));
    response.cookies.delete('auth_return_to');

    return response;
  } catch (error) {
    // BAL-360: a live user owns this email under a different identity and the
    // incoming profile is unverified — surface a clean conflict (never a 500).
    if (error instanceof AccountExistsError) {
      trackServerAndFlush(AUTH_SERVER_EVENTS.OAUTH_CALLBACK_CONFLICT_409, {
        distinct_id: error.existingUserId,
      });
      log.warn('OAuth callback: email owned by a different identity — conflict', {
        existingUserId: error.existingUserId,
      });
      return NextResponse.redirect(new URL('/login?error=account_exists', req.url));
    }
    log.error('OAuth callback failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: req.nextUrl.pathname,
      hasCode: !!code,
    });
    return NextResponse.redirect(new URL('/login?error=auth_failed', req.url));
  }
}
