import { NextRequest, NextResponse } from 'next/server';
import { usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { isValidReturnTo } from '@/lib/auth/route-config';
import { log } from '@/lib/logging';

/**
 * GET /api/auth/session-sync?returnTo=/path
 *
 * Route handler that performs session sync with cookie mutation.
 * Called via redirect from the dashboard layout when drift or
 * invalidation is detected. Route handlers CAN modify cookies
 * (unlike Server Components).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  const returnTo = request.nextUrl.searchParams.get('returnTo');
  const safeReturnTo = returnTo && isValidReturnTo(returnTo) ? returnTo : '/dashboard';

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const dbUser = await usersRepository.findForSessionSync(session.user.id);

  // User not found in DB
  if (!dbUser) {
    log.warn('Session sync: user not found in DB, destroying session', {
      userId: session.user.id,
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_deleted', request.url));
  }

  // Soft-deleted user
  if (dbUser.deletedAt !== null) {
    log.info('Session invalidated: user deleted', {
      userId: session.user.id,
      reason: 'deleted',
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_deleted', request.url));
  }

  // Suspended/inactive user
  if (dbUser.status !== 'active') {
    log.info('Session invalidated: user suspended', {
      userId: session.user.id,
      reason: 'suspended',
      status: dbUser.status,
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_suspended', request.url));
  }

  // Patch session with fresh DB values
  session.user.activeMode = dbUser.activeMode as 'client' | 'expert';
  session.user.platformRole = dbUser.platformRole as 'user' | 'admin' | 'super_admin';
  session.user.onboardingCompleted = dbUser.onboardingCompleted;
  session.user.expertProfileId = dbUser.expertProfileId ?? undefined;
  await session.save();

  log.info('Session synced: drift detected and patched', {
    userId: session.user.id,
  });

  return NextResponse.redirect(new URL(safeReturnTo, request.url));
}
