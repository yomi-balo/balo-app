import { NextRequest, NextResponse } from 'next/server';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { db, usersRepository } from '@balo/db';
import { isValidReturnTo } from '@/lib/auth/validation';

export const dynamic = 'force-dynamic';

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
    } = await getWorkOS().userManagement.authenticateWithCode({
      code,
      clientId,
    });

    // Find existing user
    let user = await usersRepository.findByWorkosId(workosUser.id);

    let companyId: string;
    let companyName: string;
    let companyRole: 'owner' | 'admin' | 'member';
    let isNewUser = false;

    if (!user) {
      // === NEW USER SIGNUP VIA OAUTH ===
      isNewUser = true;
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
      companyId = result.company.id;
      companyName = result.company.name;
      companyRole = result.membership.role;
    } else {
      // === EXISTING USER LOGIN VIA OAUTH ===
      const userWithCompany = await usersRepository.findWithCompany(user.id);

      if (!userWithCompany?.companyMemberships?.[0]) {
        throw new Error('User has no company membership');
      }

      const membership = userWithCompany.companyMemberships[0];
      companyId = membership.company.id;
      companyName = membership.company.name;
      companyRole = membership.role;
    }

    // Load expert profile if user has one
    const expertProfile = await db.query.expertProfiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.userId, user.id),
    });

    // Create session
    const session = await getSession();
    session.user = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      activeMode: user.activeMode,
      companyId,
      companyName,
      companyRole,
      ...(expertProfile && {
        expertProfileId: expertProfile.id,
        verticalId: expertProfile.verticalId,
      }),
    };
    session.accessToken = accessToken;
    session.refreshToken = refreshToken;
    await session.save();

    // Determine redirect URL
    let redirectUrl: string;

    // Check onboarding status
    const needsOnboarding = isNewUser || user.onboardingCompleted === false;

    if (needsOnboarding) {
      redirectUrl = '/onboarding';
    } else {
      // Check for return-to cookie (set by OAuth initiation action)
      const returnTo = req.cookies.get('auth_return_to')?.value;

      if (returnTo && isValidReturnTo(returnTo)) {
        redirectUrl = returnTo;
      } else {
        // Default: route based on active mode
        redirectUrl =
          user.activeMode === 'expert' && expertProfile ? '/expert/dashboard' : '/dashboard';
      }
    }

    const response = NextResponse.redirect(new URL(redirectUrl, req.url));

    // Clear the return-to cookie
    response.cookies.delete('auth_return_to');

    return response;
  } catch (error) {
    console.error('Auth callback error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.redirect(new URL('/login?error=auth_failed', req.url));
  }
}
