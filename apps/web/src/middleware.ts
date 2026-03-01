import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { sessionConfig } from '@/lib/auth/config';
import type { SessionData } from '@/lib/auth/session';

/**
 * Routes that don't require authentication.
 * Auth is checked for everything else as a UX convenience.
 */
const PUBLIC_PATHS = new Set([
  '/',
  '/login',
  '/signup',
  '/reset-password',
  '/experts',
  '/about',
  '/pricing',
  '/contact',
]);

/**
 * Path prefixes that are always public.
 */
const PUBLIC_PREFIXES = [
  '/api/auth/', // Auth callbacks
  '/api/webhooks/', // Webhook endpoints
  '/experts/', // Expert profiles (public marketplace)
  '/_next/', // Next.js internals
];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const requestId = crypto.randomUUID();

  // Always add request ID
  const responseHeaders = new Headers();
  responseHeaders.set('x-request-id', requestId);

  // Structured JSON log compatible with Axiom ingestion.
  // Pino is not available in Edge Runtime, so we use console.log with JSON.
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Request',
      requestId,
      method: request.method,
      path: pathname,
      timestamp: new Date().toISOString(),
    })
  );

  // Check if path is public
  const isPublic =
    PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (isPublic) {
    const response = NextResponse.next();
    response.headers.set('x-request-id', requestId);
    return response;
  }

  // For protected routes: check session
  try {
    const response = NextResponse.next();
    response.headers.set('x-request-id', requestId);

    const session = await getIronSession<SessionData>(request, response, sessionConfig);

    if (!session?.user?.id) {
      // No session — redirect to login with return-to
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('returnTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Onboarding check — redirect users who haven't completed onboarding.
    // Exception: the onboarding route itself and API routes.
    if (
      pathname !== '/onboarding' &&
      !pathname.startsWith('/api/') &&
      session.user.onboardingCompleted === false
    ) {
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }

    return response;
  } catch {
    // Session decryption failed — treat as unauthenticated
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
