import { NextRequest, NextResponse } from 'next/server';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { db, usersRepository } from '@balo/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
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

    if (!user) {
      // === NEW USER SIGNUP ===
      // Create user, personal workspace, and membership in a transaction
      const result = await usersRepository.createWithWorkspace({
        workosId: workosUser.id,
        email: workosUser.email,
        firstName: workosUser.firstName,
        lastName: workosUser.lastName,
        emailVerified: workosUser.emailVerified ?? false,
        activeMode: 'client',
      });

      user = result.user;
      companyId = result.company.id;
      companyName = result.company.name;
      companyRole = result.membership.role;
    } else {
      // === EXISTING USER LOGIN ===
      // Fetch user with company membership
      const userWithCompany = await usersRepository.findWithCompany(user.id);

      if (!userWithCompany?.companyMemberships?.[0]) {
        throw new Error('User has no company membership');
      }

      const membership = userWithCompany.companyMemberships[0];
      companyId = membership.company.id;
      companyName = membership.company.name;
      companyRole = membership.role;
    }

    // Optionally fetch expert profile if user has one
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

      // Company context
      companyId,
      companyName,
      companyRole,

      // Expert context (if exists)
      ...(expertProfile && {
        expertProfileId: expertProfile.id,
        verticalId: expertProfile.verticalId,
      }),
    };
    session.accessToken = accessToken;
    session.refreshToken = refreshToken;
    await session.save();

    // Redirect based on active mode
    const redirectUrl =
      user.activeMode === 'expert' && expertProfile ? '/expert/dashboard' : '/dashboard';

    return NextResponse.redirect(new URL(redirectUrl, req.url));
  } catch (error) {
    console.error('Auth callback error:', error);
    return NextResponse.redirect(new URL('/login?error=auth_failed', req.url));
  }
}
