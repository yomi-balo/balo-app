import { NextRequest, NextResponse } from 'next/server';
import { usersRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const DEFAULT_REDIRECT = '/dashboard';

/**
 * Validate and normalize a returnTo path to prevent open redirects.
 * Uses URL parsing to ensure the path stays on the same origin.
 */
function getSafeRedirectPath(returnTo: string | null, baseUrl: string): string {
  if (!returnTo) return DEFAULT_REDIRECT;

  try {
    // Parse relative to the request origin — if returnTo contains a different
    // host, new URL() will resolve it and we detect it below.
    const parsed = new URL(returnTo, baseUrl);
    const base = new URL(baseUrl);

    // Must stay on the same origin (blocks absolute URLs, protocol-relative, etc.)
    if (parsed.origin !== base.origin) return DEFAULT_REDIRECT;

    const path = parsed.pathname;

    // Block auth paths to prevent redirect loops
    if (path.startsWith('/login') || path.startsWith('/signup') || path.startsWith('/api/auth')) {
      return DEFAULT_REDIRECT;
    }

    return path;
  } catch {
    return DEFAULT_REDIRECT;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  const returnTo = request.nextUrl.searchParams.get('returnTo');
  const safeReturnTo = getSafeRedirectPath(returnTo, request.url);

  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const dbUser = await usersRepository.findForSessionSync(session.user.id);

  if (!dbUser) {
    log.warn('Session sync: user not found in DB, destroying session', {
      userId: session.user.id,
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_deleted', request.url));
  }

  if (dbUser.deletedAt !== null) {
    log.info('Session invalidated: user deleted', {
      userId: session.user.id,
      reason: 'deleted',
    });
    session.destroy();
    return NextResponse.redirect(new URL('/login?error=account_deleted', request.url));
  }

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
  session.user.activeMode = dbUser.activeMode;
  session.user.platformRole = dbUser.platformRole;
  session.user.onboardingCompleted = dbUser.onboardingCompleted;
  session.user.expertProfileId = dbUser.expertProfileId ?? undefined;
  await session.save();

  log.info('Session synced: drift detected and patched', {
    userId: session.user.id,
  });

  return NextResponse.redirect(new URL(safeReturnTo, request.url));
}
