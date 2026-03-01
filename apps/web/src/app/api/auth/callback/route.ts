import { NextRequest, NextResponse } from 'next/server';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { db, usersRepository } from '@balo/db';
import { isValidReturnTo } from '@/lib/auth/validation';

export const dynamic = 'force-dynamic';

interface ResolvedUser {
  user: Awaited<ReturnType<typeof usersRepository.findByWorkosId>> & { id: string };
  companyId: string;
  companyName: string;
  companyRole: 'owner' | 'admin' | 'member';
  isNewUser: boolean;
}

async function resolveOrCreateUser(workosUser: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
  emailVerified: boolean;
}): Promise<ResolvedUser> {
  const existing = await usersRepository.findByWorkosId(workosUser.id);

  if (!existing) {
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
    };
  }

  const userWithCompany = await usersRepository.findWithCompany(existing.id);

  if (!userWithCompany?.companyMemberships?.[0]) {
    throw new Error('User has no company membership');
  }

  const membership = userWithCompany.companyMemberships[0];

  return {
    user: existing,
    companyId: membership.company.id,
    companyName: membership.company.name,
    companyRole: membership.role,
    isNewUser: false,
  };
}

async function createSession(
  resolved: ResolvedUser,
  accessToken: string,
  refreshToken: string
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
    activeMode: resolved.user.activeMode,
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
    } = await getWorkOS().userManagement.authenticateWithCode({ code, clientId });

    const resolved = await resolveOrCreateUser(workosUser);
    await createSession(resolved, accessToken, refreshToken);

    const redirectUrl = determineRedirectUrl(resolved, req);
    const response = NextResponse.redirect(new URL(redirectUrl, req.url));
    response.cookies.delete('auth_return_to');

    return response;
  } catch (error) {
    console.error('Auth callback error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.redirect(new URL('/login?error=auth_failed', req.url));
  }
}
